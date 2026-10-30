import { basename, dirname } from 'node:path';
import type { DeliveryConfig, DeliveryRepoConfig } from '../config/types.ts';
import { coveringClaims, freezeText, readClaims } from '../delivery/freezes.ts';
import { takeWhenClear, type Readiness } from '../delivery/clearance.ts';
import { underLock, type HostLock, type HostLockInfo } from '../delivery/host-lock.ts';
import { appendDeploy, rangeText } from '../delivery/ledger.ts';
import type { DeliveryPlaces } from '../delivery/places.ts';
import { marksOfTaking, recordHeavy, runRecorded, type HeavyMark } from '../delivery/recorded-step.ts';
import { heavyCutoffReason, resetBlackoutReason, type ResetTime } from '../delivery/schedule.ts';
import { exitCodeOf, type StepEnd, type StepRunner } from '../delivery/steps.ts';
import type { Files } from '../core/files.ts';
import { gitEnvironment } from '../core/git-run.ts';
import { ENV, type Env } from '../core/home.ts';
import type { Clock, Sleep } from '../core/lock.ts';
import { samePath } from '../core/paths.ts';
import type { SecretScanner } from '../core/secrets.ts';
import type { TimeZone } from '../core/zone.ts';
import { shownLine } from '../deploy/checks.ts';
import { HOOK_WAIT_EXIT, hookEndText, hookExitCode, succeeded, type HookRunner } from '../deploy/hooks.ts';
import type { CommitLog } from '../push-guard/commit-size.ts';
import { readPassRecord } from '../push-guard/pass-record.ts';
import { commandLine } from '../test-run/shell.ts';
import { rangeInstallTouches, runDependencyCheck } from './dependencies.ts';
import type { GateHolds } from './gate-holds.ts';
import { gatedVerdict, type GatedSetup, type GatedTask, type GatedVerdict } from './gated-step.ts';
import { ORIGIN, type Checkout, type MergeGit } from './git.ts';
import { LOCKFILE } from './manifest.ts';
import type { MergeLog, MergeRecord } from './merge-log.ts';
import { readPendingMerge, removePendingMerge, writePendingMerge, type PendingMerge } from './pending-merges.ts';
import { checkExitCode, runReviewCheck } from './review-check.ts';
import { reviewGateVerdict, type GatedChange, type ReviewClearance, type ReviewGatePorts, type ReviewGateSetup } from './review-gate-step.ts';
import type { ReviewHolds } from './review-holds.ts';

/**
 * `teamrig merge`: merges a finished branch into origin's default branch, one push on the host at a time. It refuses
 * a branch it must not merge (detached, the default branch, uncommitted changes, nothing new, a dependency change the
 * gate holds and no dependency check clears), waits out deploy freezes on what the push deploys, takes the host lock,
 * rebases onto the fresh default branch, runs the dependency check when the branch changes the package files, the
 * review gate when the repo has one (a change of a review path waits for its reviewer) and, under
 * `pushGuard.pushToProtected: gated`, the self-merge gates (a change that misses one waits for a leader's approval), and
 * pushes (the pre-push hook runs as a queued step), then logs what the self-merge gates let merge, tidies the branch away
 * and, when configured, fast-forwards the main checkout. It never deploys: a push a host deploys by itself is recorded
 * as that deploy. A repository with a merge command (`delivery.repos.<name>.merge`, say one that merges through a
 * pull request) runs it in place of the push: exit 0 merged, once its remote shows it; 75 waits, and the next `teamrig
 * merge` finishes it once it merged; else failed. That remote is origin unless `merge.remote` names another, say the
 * upstream a fork's pull request merges into: the branch is rebased onto its default branch, and the local default
 * branch follows it.
 */

const MINUTE_MS = 60_000;
/** A push origin rejects because its default branch moved meanwhile is rebased and pushed again, this many times in all. */
export const PUSH_ATTEMPTS = 3;
/** What a merge command is told beside `TEAMRIG_SESSION`: the branch, the default branch it merges into, and the rebased commit. */
export const MERGE_ENV = { branch: 'TEAMRIG_MERGE_BRANCH', base: 'TEAMRIG_MERGE_BASE', head: 'TEAMRIG_MERGE_HEAD' } as const;
/** Branch names never merged, whatever origin's default branch is. */
const PROTECTED_BRANCHES: readonly string[] = ['main', 'master'];

export interface MergeRequest {
  readonly session: string;
  /** The folder the command runs in: any folder of the branch's checkout. */
  readonly dir: string;
  /** Keep the branch on origin after merging it. */
  readonly keepRemote: boolean;
  /** Keep the local branch (and the checkout on it) after merging it. */
  readonly keepLocal: boolean;
}

export interface MergeSetup {
  readonly delivery: DeliveryConfig;
  readonly places: DeliveryPlaces;
  /** The team's clock, for the times its refusals and waits name. */
  readonly zone: TimeZone;
  /** A configured path as a place: a relative one is in the team's folder. */
  inTeam(path: string): string;
  /** What the review gate holds and who reviews it, for a repo with `reviewGate` on. */
  readonly review: ReviewGateSetup;
  /** The self-merge gates under `pushGuard.pushToProtected: gated`; undefined under any other choice, where what the review gate lets through lands. */
  readonly gated: GatedSetup | undefined;
}

export interface MergePorts {
  readonly git: MergeGit;
  readonly steps: StepRunner;
  /** Runs the dependency and review checks, without a shell. */
  readonly hooks: HookRunner;
  /** Redacts the checks' lines before they show. */
  readonly scanner: Pick<SecretScanner, 'redact'>;
  readonly files: Files;
  /** The review gate's holds (`DeliveryPlaces.reviewHolds`). */
  readonly reviewHolds: Pick<ReviewHolds, 'read' | 'write' | 'remove'>;
  /** The self-merge gates' holds (`DeliveryPlaces.gateHolds`). */
  readonly gateHolds: Pick<GateHolds, 'read' | 'write' | 'remove'>;
  /** The log of what the self-merge gates let land (`DeliveryPlaces.merges`). */
  readonly merges: Pick<MergeLog, 'append'>;
  /** The commits a change lands with their files, which the self-merge gates weigh. */
  readonly commitLog: CommitLog;
  /** The register's task by id, for the review gate and the self-merge gates; undefined when it has none. */
  taskOf(id: string): Promise<GatedTask | undefined>;
  readonly clock: Clock;
  readonly sleep: Sleep;
  readonly lock: Pick<HostLock, 'acquire' | 'release'>;
  readonly env: Env;
  readonly platform: NodeJS.Platform;
  /** The next weekly token reset after `nowMs`, read again at every check; undefined when unknown. */
  nextReset(nowMs: number): Promise<ResetTime | undefined>;
  newId(): string;
  /** A progress line. */
  say(text: string): void;
}

export type MergeEnd =
  | { readonly kind: 'done'; readonly summary: string }
  | { readonly kind: 'failed'; readonly reason: string }
  | { readonly kind: 'refused'; readonly reason: string }
  | { readonly kind: 'waiting'; readonly reason: string };

/** The repository a checkout belongs to: its `delivery.repos` entry, else one named after its main checkout's folder with nothing configured. */
export interface RepoMatch {
  readonly name: string;
  readonly config: DeliveryRepoConfig;
  readonly listed: boolean;
}

export function repoOf(checkout: Checkout, setup: MergeSetup, platform: NodeJS.Platform): RepoMatch {
  const main = checkout.mainCheckout ?? checkout.top;
  const listed = Object.entries(setup.delivery.repos).find(([, config]) => samePath(setup.inTeam(config.mainCheckout), main, platform));
  if (listed !== undefined) {
    const [name, config] = listed;
    return { name, config, listed: true };
  }
  return { name: basename(main), config: { mainCheckout: main, deploysOnPush: [], dependencyGate: false, reviewGate: false, updateMainCheckout: false }, listed: false };
}

/** What `teamrig merge` merges: a branch of a checkout, into its remote's default branch. */
interface Plan {
  /** The session landing it. */
  readonly session: string;
  readonly top: string;
  readonly branch: string;
  readonly linked: boolean;
  readonly mainCheckout: string | undefined;
  /** The remote whose default branch the branch merges into: the merge command's `remote`, else origin. */
  readonly remote: string;
  readonly defaultBranch: string;
  readonly repo: RepoMatch;
  /** The merge the branch's last run left waiting, with the branch still at the commit the command was given. */
  readonly pending: PendingMerge | undefined;
}

/** The checks before the lock: a plan to merge, or why not. */
type Planned = { readonly kind: 'ready'; readonly plan: Plan } | Exclude<MergeEnd, { kind: 'done' | 'waiting' }>;

/**
 * How the merge went: merged by the push or the merge command (the commits it merged, as `rangeText` names them, when,
 * and its merges row when the self-merge gates let it merge), waiting on the merge command, refused by a check or a
 * gate, or failed.
 */
type MergeOutcome =
  | {
      readonly kind: 'merged';
      readonly via: 'push' | 'command';
      readonly range: string;
      readonly after: string;
      readonly startedAt: string;
      readonly endedAt: string;
      readonly merge: MergeRecord | undefined;
    }
  | { readonly kind: 'waiting'; readonly reason: string }
  | { readonly kind: 'refused'; readonly reason: string }
  | { readonly kind: 'failed'; readonly reason: string };

/** What the checks let merge: how the review gate cleared it, and the self-merge gates' verdict under `gated` (undefined under any other choice). */
type Cleared = { readonly kind: 'cleared'; readonly review: ReviewClearance; readonly gated: Exclude<GatedVerdict, { kind: 'held' }> | undefined };

function short(sha: string): string {
  return sha.slice(0, 8);
}

function endText(end: StepEnd): string {
  switch (end.kind) {
    case 'exited':
      return `exited ${end.code}`;
    case 'signal':
      return `was stopped by ${end.signal}`;
    case 'timedOut':
      return `was killed at its time limit (exit ${exitCodeOf(end)})`;
    case 'stopped':
      return `was killed when its launching shell ended (exit ${exitCodeOf(end)})`;
  }
}

/** The checks that need no lock: what to merge, and whether it may merge at all. */
async function planOf(setup: MergeSetup, ports: MergePorts, request: MergeRequest): Promise<Planned> {
  const { git } = ports;
  const checkout = git.checkoutOf(request.dir);
  if (checkout === undefined) {
    return { kind: 'refused', reason: `${request.dir} is not in a git checkout` };
  }
  const { top, branch } = checkout;
  if (branch === undefined) {
    return { kind: 'refused', reason: `${top} has a detached HEAD: check out the branch to merge` };
  }
  const changes = git.changes(top, true);
  if (changes === undefined) {
    return { kind: 'refused', reason: `git status failed in ${top}` };
  }
  if (changes.length > 0) {
    return { kind: 'refused', reason: `${top} has ${changes.length} uncommitted change${changes.length === 1 ? '' : 's'}: commit or stash them first` };
  }
  const repo = repoOf(checkout, setup, ports.platform);
  const remote = repo.config.merge?.remote ?? ORIGIN;
  const fetched = git.fetch(top, remote);
  if (!fetched.ok) {
    return { kind: 'failed', reason: `git fetch failed: ${fetched.reason}` };
  }
  const defaultBranch = git.defaultBranch(top, remote);
  if (branch === defaultBranch || PROTECTED_BRANCHES.includes(branch)) {
    return { kind: 'refused', reason: `${branch} is a default branch: merge a feature branch` };
  }
  const onto = `${remote}/${defaultBranch}`;
  // A merge commit can make the branch an ancestor of what it merged into: a pending merge is still to finish.
  const pending = await waitingMerge(setup, ports, repo, top, branch);
  if (pending === undefined && git.isAncestor(top, 'HEAD', onto)) {
    return { kind: 'refused', reason: `nothing to merge: every commit of ${branch} is already on ${onto}` };
  }
  const held = repo.config.dependencyGate && repo.config.dependencyCheck === undefined ? await dependencyHold(git, top, onto, repo.name) : undefined;
  if (held !== undefined) {
    return { kind: 'refused', reason: held };
  }
  return { kind: 'ready', plan: { session: request.session, top, branch, linked: checkout.linked, mainCheckout: checkout.mainCheckout, remote, defaultBranch, repo, pending } };
}

/** The merge the branch's last run left waiting, when its repository merges by command and the branch is still at the commit that run gave the command. */
async function waitingMerge(setup: MergeSetup, ports: MergePorts, repo: RepoMatch, top: string, branch: string): Promise<PendingMerge | undefined> {
  if (repo.config.merge === undefined) {
    return undefined;
  }
  const pending = await readPendingMerge(ports.files, setup.places, repo.name, branch);
  return pending !== undefined && pending.head === ports.git.sha(top, 'HEAD') ? pending : undefined;
}

/** Why the dependency gate, with no check to clear a change, holds the branch: its package files need an install; undefined when they do not. */
async function dependencyHold(git: MergeGit, top: string, onto: string, repo: string): Promise<string | undefined> {
  const base = git.mergeBase(top, onto, 'HEAD');
  const touches = base === undefined ? undefined : await rangeInstallTouches(git, top, base, 'HEAD');
  if (touches === undefined) {
    return `could not read what the branch changes against ${onto}, so the dependency gate cannot clear it`;
  }
  if (touches.length === 0) {
    return undefined;
  }
  return (
    `deps changed (${touches.join(', ')}): delivery.repos.${repo}.dependencyGate holds a dependency change, since merging it changes, unreviewed, ` +
    `the node_modules every worktree links to; set delivery.repos.${repo}.dependencyCheck to the check that clears one, or push it and install by hand`
  );
}

/** The host lock a merge took, the session it took it for, and the ledger marks of the steps it runs under it (see {@link marksOfTaking}). */
interface Taking {
  readonly lock: HostLockInfo;
  readonly session: string;
  readonly markOf: (what: string) => HeavyMark;
}

/**
 * Under the host lock `taking` holds, after the rebase onto `base`: runs the repository's dependency check when the
 * gate is on and the rebased branch changes the package files, with `base`'s package-lock.json in the file
 * `TEAMRIG_BASELINE_LOCK` names, kept only while the check runs. Undefined lets the push go; else the refusal, the
 * check's output shown above it.
 */
async function dependencyCheckRefusal(setup: MergeSetup, ports: MergePorts, plan: Plan, taking: Taking, base: string): Promise<Extract<MergeOutcome, { kind: 'refused' }> | undefined> {
  const { top, branch, defaultBranch, repo } = plan;
  const argv = repo.config.dependencyCheck;
  if (!repo.config.dependencyGate || argv === undefined) {
    return undefined;
  }
  const touches = await rangeInstallTouches(ports.git, top, base, 'HEAD');
  if (touches === undefined) {
    return { kind: 'refused', reason: `could not read what ${branch} changes against ${short(base)}, so the dependency check cannot clear it` };
  }
  if (touches.length === 0) {
    return undefined;
  }
  const changed = `deps changed (${touches.join(', ')})`;
  ports.say(`${changed}: dependency check ${argv.join(' ')}`);
  const end = await recordHeavy(
    ports,
    setup.places.ledger,
    taking.markOf(`merge ${repo.name}: dependency check of ${branch}`),
    () =>
      runDependencyCheck(ports, {
        argv,
        cwd: top,
        baseline: ports.git.fileAt(top, base, LOCKFILE),
        folder: dirname(setup.places.ledger),
        env: underLock(gitEnvironment(ports.env), taking.lock),
        timeoutMs: setup.delivery.queue.maxRunMinutes * MINUTE_MS,
        onLine: (line) => ports.say(`  ${shownLine(ports.scanner, line)}`),
      }),
    hookExitCode,
  );
  if (succeeded(end)) {
    return undefined;
  }
  return { kind: 'refused', reason: `${changed}: the dependency check \`${argv.join(' ')}\` ${hookEndText(end)}, so ${branch} stays off ${defaultBranch}; its output is above` };
}

/** The review gate's ports: its check runs under the lock `taking` holds, recorded as a queued step, its lines redacted. */
function reviewGatePorts(setup: MergeSetup, ports: MergePorts, plan: Plan, taking: Taking): ReviewGatePorts {
  const { top, branch, repo } = plan;
  return {
    git: ports.git,
    holds: ports.reviewHolds,
    clock: ports.clock,
    taskOf: (id) => ports.taskOf(id),
    say: (text) => ports.say(text),
    runCheck: (argv, base) =>
      recordHeavy(
        ports,
        setup.places.ledger,
        taking.markOf(`merge ${repo.name}: review check of ${branch}`),
        () =>
          runReviewCheck(ports.hooks, {
            argv,
            cwd: top,
            base,
            env: underLock(gitEnvironment(ports.env), taking.lock),
            timeoutMs: setup.delivery.queue.maxRunMinutes * MINUTE_MS,
            redact: (line) => shownLine(ports.scanner, line),
            onLine: (line) => ports.say(`  ${line}`),
          }),
        checkExitCode,
      ),
  };
}

/**
 * The checks on what the rebase made from `base` to `head`, under the lock `taking` holds: the dependency check (see
 * {@link dependencyCheckRefusal}), the review gate (see {@link reviewGateVerdict}) and, under `gated`, the self-merge
 * step (see {@link gatedStep}). A new rebase makes a new change, so an approved gate hold binds it no more. Cleared lets
 * the merge go; else the refusal.
 */
async function checksOf(setup: MergeSetup, ports: MergePorts, plan: Plan, taking: Taking, base: string, head: string): Promise<Cleared | Extract<MergeOutcome, { kind: 'refused' }>> {
  const refused = await dependencyCheckRefusal(setup, ports, plan, taking, base);
  if (refused !== undefined) {
    return refused;
  }
  const { top, branch, repo } = plan;
  const change: GatedChange = { session: plan.session, repo: repo.name, config: repo.config, top, branch, base, head };
  const review = await reviewGateVerdict(setup.review, setup.zone, reviewGatePorts(setup, ports, plan, taking), change);
  if (review.kind === 'held') {
    return { kind: 'refused', reason: review.reason };
  }
  const gated = setup.gated === undefined ? undefined : await gatedStep(setup.gated, ports, plan, base, head);
  return gated?.kind === 'held' ? { kind: 'refused', reason: gated.reason } : { kind: 'cleared', review: review.review, gated };
}

/** The self-merge step (see {@link gatedVerdict}) on the rebased `base..head`, reading the checkout's commits and the pass records its worktrees share. */
function gatedStep(gated: GatedSetup, ports: MergePorts, plan: Plan, base: string, head: string): Promise<GatedVerdict> {
  const { session, top, branch, repo } = plan;
  const commonDir = ports.git.commonDir(top);
  return gatedVerdict(
    gated,
    {
      holds: ports.gateHolds,
      clock: ports.clock,
      taskOf: (id) => ports.taskOf(id),
      treeOf: (commit) => ports.git.treeOf(top, commit),
      commitsOf: (from, to) => ports.commitLog.between(top, from, to),
      passOf: async (tree) => (commonDir === undefined ? undefined : readPassRecord(ports.files, top, commonDir, tree)),
      say: (text) => ports.say(text),
    },
    { session, repo: repo.name, reviewGate: repo.config.reviewGate, branch, base, head },
  );
}

/**
 * The merges row of a change the checks cleared, when the self-merge step weighed it: `base..head`, cleared by the
 * review gate as `cleared.review`, merged at `at`.
 */
function mergeOf(cleared: Cleared, plan: Plan, at: string, base: string, head: string): MergeRecord | undefined {
  const { gated: verdict, review } = cleared;
  if (verdict === undefined) {
    return undefined;
  }
  const merged = { at, session: plan.session, repo: plan.repo.name, branch: plan.branch, base, head, ...verdict.facts, review };
  return verdict.kind === 'self' ? { ...merged, route: 'self' } : { ...merged, route: 'approved', missed: verdict.missed, approvedBy: verdict.approvedBy };
}

/** Whether the push may start now: the queue cutoff and the reset blackout refuse it, a deploy freeze on what it deploys holds it. */
function readinessOf(setup: MergeSetup, ports: MergePorts, repo: RepoMatch): () => Promise<Readiness> {
  const { schedule } = setup.delivery;
  const targets = repo.config.deploysOnPush;
  return async () => {
    const now = ports.clock.now();
    const hours = schedule.resetBlackoutHours;
    const refusal =
      heavyCutoffReason(now, schedule.queueCutoffUtc, setup.zone) ??
      (hours === undefined ? undefined : resetBlackoutReason(now, await ports.nextReset(now), hours, setup.zone));
    if (refusal !== undefined) {
      return { kind: 'refuse', reason: refusal };
    }
    if (targets.length === 0) {
      return { kind: 'go' };
    }
    const read = await readClaims(ports.files, setup.places.claims);
    if (read.kind === 'unreadable') {
      return { kind: 'wait', reason: `the deploy freezes in ${setup.places.claims} are unreadable (${read.reason})` };
    }
    const covering = coveringClaims(read.claims, targets, now);
    return covering.length === 0 ? { kind: 'go' } : { kind: 'wait', reason: covering.map((claim) => freezeText(claim, setup.zone)).join('; ') };
  };
}

/**
 * Under the host lock `taking` holds: rebases onto the fresh default branch, runs the checks on what the rebase made
 * (see {@link checksOf}) and pushes, again from the rebase when origin moved meanwhile, unless the push was killed as
 * its launching shell ended (no one waits for it any more). The checks and the push get the lock's token, so a
 * pre-push hook that wraps its checks in `teamrig queue` runs them under this lock.
 */
async function mergeByPush(setup: MergeSetup, ports: MergePorts, plan: Plan, taking: Taking): Promise<MergeOutcome> {
  const { git } = ports;
  const { top, branch, defaultBranch, repo } = plan;
  const onto = `${ORIGIN}/${defaultBranch}`;
  for (let attempt = 1; ; attempt += 1) {
    const fetched = git.fetch(top, ORIGIN);
    if (!fetched.ok) {
      return { kind: 'failed', reason: `git fetch failed: ${fetched.reason}` };
    }
    const before = git.sha(top, onto);
    if (before === undefined) {
      return { kind: 'failed', reason: `${onto} is missing after the fetch` };
    }
    const rebased = git.rebase(top, onto);
    if (!rebased.ok) {
      return { kind: 'failed', reason: rebased.reason };
    }
    const head = git.sha(top, 'HEAD');
    if (head === undefined) {
      return { kind: 'failed', reason: `HEAD names no commit in ${top} after the rebase` };
    }
    const checked = await checksOf(setup, ports, plan, taking, before, head);
    if (checked.kind === 'refused') {
      return checked;
    }
    const startedAt = new Date(ports.clock.now()).toISOString();
    ports.say(`pushing ${branch} (${short(head)}) to ${defaultBranch}; the pre-push hook runs now`);
    const end = await runRecorded(ports, setup.places.ledger, {
      ...taking.markOf(`merge ${repo.name}: push ${branch} to ${defaultBranch}`),
      request: {
        command: commandLine(['git', 'push', 'origin', `HEAD:refs/heads/${defaultBranch}`], ports.platform),
        cwd: top,
        env: underLock(gitEnvironment(ports.env), taking.lock),
        timeoutMs: setup.delivery.queue.maxRunMinutes * MINUTE_MS,
      },
    });
    const endedAt = new Date(ports.clock.now()).toISOString();
    const after = git.remoteHead(top, ORIGIN, defaultBranch);
    if (after === head) {
      if (end.kind !== 'exited' || end.code !== 0) {
        ports.say(`the push ${endText(end)}, but origin's ${defaultBranch} is at ${short(head)}: it merged`);
      }
      return { kind: 'merged', via: 'push', range: rangeText(git.commits(top, before, after), after), after, startedAt, endedAt, merge: mergeOf(checked, plan, endedAt, before, head) };
    }
    const moved = after !== undefined && after !== before;
    if (moved && attempt < PUSH_ATTEMPTS && end.kind !== 'stopped') {
      ports.say(`origin's ${defaultBranch} moved to ${short(after)} meanwhile: rebasing and pushing again (attempt ${attempt + 1} of ${PUSH_ATTEMPTS})`);
      continue;
    }
    const where = after === undefined ? 'could not be read' : `is at ${short(after)}`;
    return { kind: 'failed', reason: `the push ${endText(end)}; origin's ${defaultBranch} ${where}, not at ${short(head)}` };
  }
}

/**
 * The default branch (`onto`'s commit) when one of its commits since `base` holds the branch's work: every path the
 * branch changed from `base` to `head` reads there as at `head`. That finds a rebase, a squash and a merge commit
 * alike, also once more commits came after it; a change to one of those files that reached the default branch first
 * hides it, and the branch is kept. One diff per commit, newest first, with no path list on the command line.
 * Undefined when no commit holds it, or the branch's changes cannot be read.
 */
function mergedAt(git: MergeGit, top: string, onto: string, base: string, head: string): string | undefined {
  const paths = git.changedPaths(top, base, head);
  const tip = git.sha(top, onto);
  if (paths === undefined || paths.length === 0 || tip === undefined) {
    return undefined;
  }
  const changed = new Set(paths);
  for (const commit of [...git.commits(top, base, tip)].reverse()) {
    const differs = git.changedPaths(top, commit, head);
    if (differs !== undefined && !differs.some((path) => changed.has(path))) {
      return tip;
    }
  }
  return undefined;
}

/**
 * Under the host lock `taking` holds, for a repository with a merge command: a merge an earlier run left waiting
 * is done once the merge remote's default branch holds it (see {@link mergedAt}); else rebases onto the fresh default
 * branch, runs the checks (see {@link checksRefusal}) and then the command (its contract: `MergeConfig`). Exit 0 must show on that
 * remote, 75 leaves a pending merge for the next run, anything else fails. The command's lines show redacted; its
 * last one is the reason given.
 */
async function mergeByCommand(setup: MergeSetup, ports: MergePorts, plan: Plan, taking: Taking, argv: readonly string[]): Promise<MergeOutcome> {
  const { git } = ports;
  const { top, branch, remote, defaultBranch, repo, pending } = plan;
  const onto = `${remote}/${defaultBranch}`;
  const fetched = git.fetch(top, remote);
  if (!fetched.ok) {
    return { kind: 'failed', reason: `git fetch failed: ${fetched.reason}` };
  }
  const startedAt = new Date(ports.clock.now()).toISOString();
  const merged = pending === undefined ? undefined : mergedAt(git, top, onto, pending.base, pending.head);
  if (pending !== undefined && merged !== undefined) {
    ports.say(`${branch} (${short(pending.head)}) is merged into ${defaultBranch}: ${onto} at ${short(merged)} holds it`);
    // The run that gave the command the change ran the self-merge gates; a pending merge does not keep their verdict,
    // so a merge finished here writes no merges row (T1514).
    return { kind: 'merged', via: 'command', range: rangeText(git.commits(top, pending.base, merged), merged), after: merged, startedAt: pending.since, endedAt: startedAt, merge: undefined };
  }
  const before = git.sha(top, onto);
  if (before === undefined) {
    return { kind: 'failed', reason: `${onto} is missing after the fetch` };
  }
  const rebased = git.rebase(top, onto);
  if (!rebased.ok) {
    return { kind: 'failed', reason: rebased.reason };
  }
  const head = git.sha(top, 'HEAD');
  if (head === undefined) {
    return { kind: 'failed', reason: `HEAD names no commit in ${top} after the rebase` };
  }
  const checked = await checksOf(setup, ports, plan, taking, before, head);
  if (checked.kind === 'refused') {
    return checked;
  }
  const command = argv.join(' ');
  ports.say(`merging ${branch} (${short(head)}) into ${defaultBranch} through the merge command ${command}`);
  let last: string | undefined;
  const end = await recordHeavy(
    ports,
    setup.places.ledger,
    taking.markOf(`merge ${repo.name}: merge ${branch} into ${defaultBranch}`),
    () =>
      ports.hooks.run({
        argv,
        cwd: top,
        env: { ...underLock(gitEnvironment(ports.env), taking.lock), [MERGE_ENV.branch]: branch, [MERGE_ENV.base]: defaultBranch, [MERGE_ENV.head]: head, [ENV.session]: taking.session },
        timeoutMs: setup.delivery.queue.maxRunMinutes * MINUTE_MS,
        onLine: (line) => {
          const shown = shownLine(ports.scanner, line);
          ports.say(`  ${shown}`);
          last = shown.trim() === '' ? last : shown.trim();
        },
      }),
    hookExitCode,
  );
  if (end.kind === 'exited' && end.code === HOOK_WAIT_EXIT) {
    await writePendingMerge(ports.files, setup.places, { session: taking.session, repo: repo.name, branch, head, base: before, since: pending?.since ?? startedAt, note: last ?? '' });
    return { kind: 'waiting', reason: last ?? `the merge command \`${command}\` says ${branch} waits to merge into ${defaultBranch}` };
  }
  if (!succeeded(end)) {
    return { kind: 'failed', reason: `the merge command \`${command}\` ${hookEndText(end)}, so ${branch} is not on ${defaultBranch}${last === undefined ? '' : `: ${last}`}` };
  }
  const refetched = git.fetch(top, remote);
  const after = refetched.ok ? mergedAt(git, top, onto, before, head) : undefined;
  if (after === undefined) {
    const why = refetched.ok ? `no commit on ${onto} since ${short(before)} holds its files at ${short(head)}` : `git fetch failed: ${refetched.reason}`;
    return { kind: 'failed', reason: `the merge command said ${branch} merged, but ${why}` };
  }
  const endedAt = new Date(ports.clock.now()).toISOString();
  return { kind: 'merged', via: 'command', range: rangeText(git.commits(top, before, after), after), after, startedAt: pending?.since ?? startedAt, endedAt, merge: mergeOf(checked, plan, endedAt, before, head) };
}

/** Merges the branch: through the repository's merge command when it has one, else by the push. */
async function pushOrMerge(setup: MergeSetup, ports: MergePorts, plan: Plan, taking: Taking): Promise<MergeOutcome> {
  const command = plan.repo.config.merge?.command;
  return command === undefined ? mergeByPush(setup, ports, plan, taking) : mergeByCommand(setup, ports, plan, taking, command);
}

/** Removes the merged branch on origin and here, and moves the local default branch to its remote's, as far as each step goes; a failed step is a warning. */
function tidy(ports: MergePorts, request: MergeRequest, plan: Plan): void {
  const { git, say } = ports;
  const { top, branch, defaultBranch } = plan;
  const warn = (what: string, reason: string): void => say(`WARNING could not ${what}: ${reason}`);
  if (!request.keepRemote && git.remoteHead(top, ORIGIN, branch) !== undefined) {
    const deleted = git.deleteRemoteBranch(top, branch);
    if (deleted.ok) {
      say(`deleted ${branch} on origin`);
    } else {
      warn(`delete ${branch} on origin`, deleted.reason);
    }
  }
  if (!request.keepLocal) {
    const detached = git.detach(top);
    const deleted = detached.ok ? git.deleteBranch(top, branch) : detached;
    if (deleted.ok) {
      say(`deleted the local ${branch}`);
    } else {
      warn(`delete the local ${branch}`, deleted.reason);
    }
  }
  const update = git.updateLocalBranch(top, plan.remote, defaultBranch);
  if (update.kind === 'failed') {
    warn(`move the local ${defaultBranch} to ${plan.remote}'s`, update.reason);
  } else if (update.kind === 'updated' && !plan.linked && !request.keepLocal) {
    const switched = git.checkout(top, defaultBranch);
    if (!switched.ok) {
      warn(`check out ${defaultBranch}`, switched.reason);
    }
  }
}

/** Fast-forwards the main checkout to what merged, only on the default branch with no tracked changes; it never fails the merge. */
async function updateMainCheckout(ports: MergePorts, plan: Plan, merged: string): Promise<void> {
  const { git, say } = ports;
  const main = plan.mainCheckout;
  if (!plan.repo.config.updateMainCheckout || main === undefined || !plan.linked) {
    return;
  }
  const note = (why: string): void => say(`NOTE left the main checkout ${main} as it is: ${why}`);
  const branch = git.checkoutOf(main)?.branch;
  if (branch !== plan.defaultBranch) {
    note(`it is on ${branch ?? 'a detached HEAD'}, not ${plan.defaultBranch}`);
    return;
  }
  const changes = git.changes(main, false);
  if (changes === undefined || changes.length > 0) {
    note(changes === undefined ? 'git status failed there' : 'it has uncommitted changes');
    return;
  }
  const was = git.sha(main, 'HEAD');
  if (was === undefined || !git.isAncestor(main, was, merged)) {
    note(`its ${plan.defaultBranch} has commits that are not on ${plan.remote}`);
    return;
  }
  const moved = git.fastForward(main, merged);
  if (!moved.ok) {
    note(moved.reason);
    return;
  }
  say(`fast-forwarded the main checkout ${main} to ${short(merged)}`);
  const touches = await rangeInstallTouches(git, main, was, merged);
  if (touches === undefined) {
    say(`NOTE could not read what the fast-forward changed: check whether ${main} needs npm ci --ignore-scripts`);
    return;
  }
  if (touches.length > 0) {
    say(`NOTE ${touches.join(', ')} changed: run npm ci --ignore-scripts in ${main}`);
  }
}

/** The step after a merged branch: removing its worktree. */
function nextStep(request: MergeRequest, plan: Plan): string | undefined {
  if (!plan.linked) {
    return undefined;
  }
  return request.keepLocal ? `next: teamrig worktree remove "${plan.top}" --delete-branch` : `next: teamrig worktree remove "${plan.top}"`;
}

/** Merges the branch of the checkout at `request.dir` into its remote's default branch (see the module comment). */
export async function mergeBranch(setup: MergeSetup, ports: MergePorts, request: MergeRequest): Promise<MergeEnd> {
  const planned = await planOf(setup, ports, request);
  if (planned.kind !== 'ready') {
    return planned;
  }
  const { plan } = planned;
  const { repo, defaultBranch } = plan;
  if (!repo.listed) {
    ports.say(`NOTE ${repo.name} is not in delivery.repos: no deploy targets, no dependency gate, no main checkout to follow`);
  }
  const { wait } = setup.delivery;
  const queuedAt = ports.clock.now();
  const clearance = await takeWhenClear(readinessOf(setup, ports, repo), ports, {
    session: request.session,
    purpose: `merge ${repo.name}`,
    maxWaitMs: wait.maxMinutes * MINUTE_MS,
    pollMs: wait.pollSeconds * 1_000,
    zone: setup.zone,
    onWait: (reason) => ports.say(`waiting: ${reason}`),
  });
  if (clearance.kind !== 'taken') {
    return { kind: 'refused', reason: clearance.reason };
  }
  let outcome: MergeOutcome;
  try {
    outcome = await pushOrMerge(setup, ports, plan, { lock: clearance.lock, session: request.session, markOf: marksOfTaking(request.session, queuedAt) });
    if (outcome.kind === 'merged' && repo.config.merge !== undefined) {
      await removePendingMerge(ports.files, setup.places, repo.name, plan.branch);
    }
    if (outcome.kind === 'merged' && repo.config.deploysOnPush.length > 0) {
      await appendDeploy(ports.files, setup.places, {
        type: 'deploy',
        kind: 'deploy',
        session: request.session,
        repo: repo.name,
        range: outcome.range,
        what: `merge ${plan.branch}`,
        note: `${outcome.via === 'push' ? 'pushed to' : 'merged by the merge command into'} ${defaultBranch}; ${repo.config.deploysOnPush.join(', ')} deploy on push, not watched by teamrig`,
        startedAt: outcome.startedAt,
        rolledAt: outcome.endedAt,
      });
    }
    if (outcome.kind === 'merged' && outcome.merge !== undefined) {
      await ports.merges.append(outcome.merge);
    }
  } finally {
    await ports.lock.release(clearance.lock);
  }
  if (outcome.kind === 'waiting') {
    ports.say(`next: run teamrig merge again in ${plan.top} once ${plan.branch} is merged`);
    return outcome;
  }
  if (outcome.kind !== 'merged') {
    return outcome;
  }
  if (repo.config.reviewGate) {
    await ports.reviewHolds.remove(repo.name, plan.branch);
  }
  if (setup.gated !== undefined) {
    await ports.gateHolds.remove(repo.name, plan.branch);
  }
  tidy(ports, request, plan);
  await updateMainCheckout(ports, plan, outcome.after);
  const next = nextStep(request, plan);
  if (next !== undefined) {
    ports.say(next);
  }
  const deploys = repo.config.deploysOnPush.length > 0 ? `; ${repo.config.deploysOnPush.join(', ')} deploy on push` : '';
  const how = outcome.via === 'push' ? `pushed ${outcome.range} to ${defaultBranch}` : `merged ${outcome.range} into ${defaultBranch} through the merge command`;
  return { kind: 'done', summary: `${how}${deploys}` };
}
