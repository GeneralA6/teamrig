import { basename, dirname, join } from 'node:path';
import type { CoordinatorConfig, CoordinatorRepoConfig } from '../config/types.ts';
import { claimText, coveringClaims, readClaims } from '../coordinator/claims.ts';
import { takeWhenClear, type Readiness } from '../coordinator/clearance.ts';
import { underLock, type HostLock, type HostLockInfo } from '../coordinator/host-lock.ts';
import { appendDeploy, rangeText } from '../coordinator/ledger.ts';
import type { CoordinatorPlaces } from '../coordinator/places.ts';
import { recordHeavy, runRecorded } from '../coordinator/recorded-step.ts';
import { heavyCutoffReason, resetBlackoutReason, type ResetTime } from '../coordinator/schedule.ts';
import { exitCodeOf, type StepEnd, type StepRunner } from '../coordinator/steps.ts';
import type { Files } from '../core/files.ts';
import { gitEnvironment } from '../core/git-run.ts';
import type { Env } from '../core/home.ts';
import type { Clock, Sleep } from '../core/lock.ts';
import { samePath } from '../core/paths.ts';
import type { SecretScanner } from '../core/secrets.ts';
import { shownLine } from '../roll/gates.ts';
import { hookEndText, hookExitCode, succeeded, type HookRunner } from '../roll/hooks.ts';
import { commandLine } from '../test-run/shell.ts';
import { rangeInstallTouches } from './dependencies.ts';
import type { Checkout, IntegrateGit } from './git.ts';
import { LOCKFILE } from './manifest.ts';

/**
 * `teamrig integrate`: lands a finished branch on origin's default branch, one push on the host at a time. It refuses
 * a branch it must not land (detached, the default branch, uncommitted changes, nothing new, a dependency change the
 * gate holds and no dependency check clears), waits out quiet claims on what the push deploys, takes the host lock,
 * rebases onto the fresh default branch, runs the dependency check when the branch changes the package files, and
 * pushes (the pre-push hook runs as a heavy step), then tidies the branch away and, when configured, fast-forwards the
 * main checkout. It never deploys: a push a host deploys by itself is recorded as that deploy.
 */

const MINUTE_MS = 60_000;
/** Names, for the dependency check, the file holding the default branch's package-lock.json. */
export const BASELINE_LOCK_ENV = 'TEAMRIG_BASELINE_LOCK';
/** A push origin rejects because its default branch moved meanwhile is rebased and pushed again, this many times in all. */
export const PUSH_ATTEMPTS = 3;
/** Branch names never integrated, whatever origin's default branch is. */
const PROTECTED_BRANCHES: readonly string[] = ['main', 'master'];

export interface IntegrateRequest {
  readonly session: string;
  /** The folder the command runs in: any folder of the branch's checkout. */
  readonly dir: string;
  /** Keep the branch on origin after landing it. */
  readonly keepRemote: boolean;
  /** Keep the local branch (and the checkout on it) after landing it. */
  readonly keepLocal: boolean;
}

export interface IntegrateSetup {
  readonly coordinator: CoordinatorConfig;
  readonly places: CoordinatorPlaces;
  /** A configured path as a place: a relative one is in the team's folder. */
  inTeam(path: string): string;
}

export interface IntegratePorts {
  readonly git: IntegrateGit;
  readonly steps: StepRunner;
  /** Runs the dependency check, without a shell. */
  readonly hooks: HookRunner;
  /** Redacts the dependency check's lines before they show. */
  readonly scanner: Pick<SecretScanner, 'redact'>;
  readonly files: Files;
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

export type IntegrateEnd = { readonly kind: 'done'; readonly summary: string } | { readonly kind: 'failed'; readonly reason: string } | { readonly kind: 'refused'; readonly reason: string };

/** The repository a checkout belongs to: its `coordinator.repos` entry, else one named after its main checkout's folder with nothing configured. */
export interface RepoMatch {
  readonly name: string;
  readonly config: CoordinatorRepoConfig;
  readonly listed: boolean;
}

export function repoOf(checkout: Checkout, setup: IntegrateSetup, platform: NodeJS.Platform): RepoMatch {
  const main = checkout.mainCheckout ?? checkout.top;
  const listed = Object.entries(setup.coordinator.repos).find(([, config]) => samePath(setup.inTeam(config.mainCheckout), main, platform));
  if (listed !== undefined) {
    const [name, config] = listed;
    return { name, config, listed: true };
  }
  return { name: basename(main), config: { mainCheckout: main, deploysOnPush: [], dependencyGate: false, followMainCheckout: false }, listed: false };
}

/** What integrate lands: a branch of a checkout, onto origin's default branch. */
interface Plan {
  readonly top: string;
  readonly branch: string;
  readonly linked: boolean;
  readonly mainCheckout: string | undefined;
  readonly defaultBranch: string;
  readonly repo: RepoMatch;
}

/** The checks before the lock: a plan to land, or why not. */
type Planned = { readonly kind: 'ready'; readonly plan: Plan } | Exclude<IntegrateEnd, { kind: 'done' }>;

/** How the push went: landed (the commits it landed, as `rangeText` names them, and when), refused by the dependency check, or failed. */
type Landing =
  | { readonly kind: 'landed'; readonly range: string; readonly after: string; readonly startedAt: string; readonly endedAt: string }
  | { readonly kind: 'refused'; readonly reason: string }
  | { readonly kind: 'failed'; readonly reason: string };

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
  }
}

/** The checks that need no lock: what to land, and whether it may land at all. */
async function planOf(setup: IntegrateSetup, ports: IntegratePorts, request: IntegrateRequest): Promise<Planned> {
  const { git } = ports;
  const checkout = git.checkoutOf(request.dir);
  if (checkout === undefined) {
    return { kind: 'refused', reason: `${request.dir} is not in a git checkout` };
  }
  const { top, branch } = checkout;
  if (branch === undefined) {
    return { kind: 'refused', reason: `${top} has a detached HEAD: check out the branch to integrate` };
  }
  const changes = git.changes(top, true);
  if (changes === undefined) {
    return { kind: 'refused', reason: `git status failed in ${top}` };
  }
  if (changes.length > 0) {
    return { kind: 'refused', reason: `${top} has ${changes.length} uncommitted change${changes.length === 1 ? '' : 's'}: commit or stash them first` };
  }
  const fetched = git.fetch(top);
  if (!fetched.ok) {
    return { kind: 'failed', reason: `git fetch failed: ${fetched.reason}` };
  }
  const defaultBranch = git.defaultBranch(top);
  if (branch === defaultBranch || PROTECTED_BRANCHES.includes(branch)) {
    return { kind: 'refused', reason: `${branch} is a default branch: integrate a feature branch` };
  }
  const onto = `origin/${defaultBranch}`;
  if (git.isAncestor(top, 'HEAD', onto)) {
    return { kind: 'refused', reason: `nothing to integrate: every commit of ${branch} is already on ${onto}` };
  }
  const repo = repoOf(checkout, setup, ports.platform);
  const held = repo.config.dependencyGate && repo.config.dependencyCheck === undefined ? await dependencyHold(git, top, onto, repo.name) : undefined;
  if (held !== undefined) {
    return { kind: 'refused', reason: held };
  }
  return { kind: 'ready', plan: { top, branch, linked: checkout.linked, mainCheckout: checkout.mainCheckout, defaultBranch, repo } };
}

/** Why the dependency gate, with no check to clear a change, holds the branch: its package files need an install; undefined when they do not. */
async function dependencyHold(git: IntegrateGit, top: string, onto: string, repo: string): Promise<string | undefined> {
  const base = git.mergeBase(top, onto, 'HEAD');
  const touches = base === undefined ? undefined : await rangeInstallTouches(git, top, base, 'HEAD');
  if (touches === undefined) {
    return `could not read what the branch changes against ${onto}, so the dependency gate cannot clear it`;
  }
  if (touches.length === 0) {
    return undefined;
  }
  return (
    `deps changed (${touches.join(', ')}): coordinator.repos.${repo}.dependencyGate holds a dependency change, since landing it changes, unreviewed, ` +
    `the node_modules every worktree links to; set coordinator.repos.${repo}.dependencyCheck to the check that clears one, or push it and install by hand`
  );
}

/** Runs `work` with `file` written, and removes it after, however `work` ends; with no file, just `work`. */
async function withFile<T>(files: Files, file: { readonly path: string; readonly text: string } | undefined, work: () => Promise<T>): Promise<T> {
  if (file === undefined) {
    return work();
  }
  await files.write(file.path, file.text);
  try {
    return await work();
  } finally {
    await files.remove(file.path);
  }
}

/**
 * Under the host lock `lock`, after the rebase onto `base`: runs the repository's dependency check when the gate is on
 * and the rebased branch changes the package files, with `base`'s package-lock.json in the file
 * {@link BASELINE_LOCK_ENV} names, kept only while the check runs. Undefined lets the push go; else the refusal, the
 * check's output shown above it.
 */
async function dependencyCheckRefusal(setup: IntegrateSetup, ports: IntegratePorts, request: IntegrateRequest, plan: Plan, lock: HostLockInfo, base: string): Promise<Landing | undefined> {
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
  const lockfile = ports.git.fileAt(top, base, LOCKFILE);
  const baseline = lockfile === undefined ? undefined : { path: join(dirname(setup.places.ledger), `baseline-${ports.newId()}.${LOCKFILE}`), text: lockfile };
  const changed = `deps changed (${touches.join(', ')})`;
  ports.say(`${changed}: dependency check ${argv.join(' ')}`);
  const end = await withFile(ports.files, baseline, () =>
    recordHeavy(
      ports,
      setup.places.ledger,
      { session: request.session, what: `integrate ${repo.name}: dependency check of ${branch}` },
      () =>
        ports.hooks.run({
          argv,
          cwd: top,
          env: underLock({ ...gitEnvironment(ports.env), [BASELINE_LOCK_ENV]: baseline?.path }, lock),
          timeoutMs: setup.coordinator.heavy.maxRunMinutes * MINUTE_MS,
          onLine: (line) => ports.say(`  ${shownLine(ports.scanner, line)}`),
        }),
      hookExitCode,
    ),
  );
  if (succeeded(end)) {
    return undefined;
  }
  return { kind: 'refused', reason: `${changed}: the dependency check \`${argv.join(' ')}\` ${hookEndText(end)}, so ${branch} stays off ${defaultBranch}; its output is above` };
}

/** Whether the push may start now: the heavy cutoff and the reset blackout refuse it, a quiet claim on what it deploys holds it. */
function readinessOf(setup: IntegrateSetup, ports: IntegratePorts, repo: RepoMatch): () => Promise<Readiness> {
  const { schedule } = setup.coordinator;
  const targets = repo.config.deploysOnPush;
  return async () => {
    const now = ports.clock.now();
    const hours = schedule.resetBlackoutHours;
    const refusal = heavyCutoffReason(now, schedule.heavyCutoffUtc) ?? (hours === undefined ? undefined : resetBlackoutReason(now, await ports.nextReset(now), hours));
    if (refusal !== undefined) {
      return { kind: 'refuse', reason: refusal };
    }
    if (targets.length === 0) {
      return { kind: 'go' };
    }
    const read = await readClaims(ports.files, setup.places.claims);
    if (read.kind === 'unreadable') {
      return { kind: 'wait', reason: `the quiet claims in ${setup.places.claims} are unreadable (${read.reason})` };
    }
    const covering = coveringClaims(read.claims, targets, now);
    return covering.length === 0 ? { kind: 'go' } : { kind: 'wait', reason: covering.map(claimText).join('; ') };
  };
}

/**
 * Under the host lock `lock`: rebases onto the fresh default branch, runs the dependency check on what the rebase made
 * (see {@link dependencyCheckRefusal}) and pushes, again from the rebase when origin moved meanwhile. The check and the
 * push get the lock's token, so a pre-push hook that wraps its checks in `teamrig heavy` runs them under this lock.
 */
async function land(setup: IntegrateSetup, ports: IntegratePorts, request: IntegrateRequest, plan: Plan, lock: HostLockInfo): Promise<Landing> {
  const { git } = ports;
  const { top, branch, defaultBranch, repo } = plan;
  const onto = `origin/${defaultBranch}`;
  for (let attempt = 1; ; attempt += 1) {
    const fetched = git.fetch(top);
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
    const refused = await dependencyCheckRefusal(setup, ports, request, plan, lock, before);
    if (refused !== undefined) {
      return refused;
    }
    const startedAt = new Date(ports.clock.now()).toISOString();
    ports.say(`pushing ${branch} (${short(head)}) to ${defaultBranch}; the pre-push hook runs now`);
    const end = await runRecorded(ports, setup.places.ledger, {
      session: request.session,
      what: `integrate ${repo.name}: push ${branch} to ${defaultBranch}`,
      request: {
        command: commandLine(['git', 'push', 'origin', `HEAD:refs/heads/${defaultBranch}`], ports.platform),
        cwd: top,
        env: underLock(gitEnvironment(ports.env), lock),
        timeoutMs: setup.coordinator.heavy.maxRunMinutes * MINUTE_MS,
      },
    });
    const endedAt = new Date(ports.clock.now()).toISOString();
    const after = git.remoteHead(top, defaultBranch);
    if (after === head) {
      if (end.kind !== 'exited' || end.code !== 0) {
        ports.say(`the push ${endText(end)}, but origin's ${defaultBranch} is at ${short(head)}: it landed`);
      }
      return { kind: 'landed', range: rangeText(git.commits(top, before, after), after), after, startedAt, endedAt };
    }
    const moved = after !== undefined && after !== before;
    if (moved && attempt < PUSH_ATTEMPTS) {
      ports.say(`origin's ${defaultBranch} moved to ${short(after)} meanwhile: rebasing and pushing again (attempt ${attempt + 1} of ${PUSH_ATTEMPTS})`);
      continue;
    }
    const where = after === undefined ? 'could not be read' : `is at ${short(after)}`;
    return { kind: 'failed', reason: `the push ${endText(end)}; origin's ${defaultBranch} ${where}, not at ${short(head)}` };
  }
}

/** Removes the landed branch on origin and here, and moves the local default branch, as far as each step goes; a failed step is a warning. */
function tidy(ports: IntegratePorts, request: IntegrateRequest, plan: Plan): void {
  const { git, say } = ports;
  const { top, branch, defaultBranch } = plan;
  const warn = (what: string, reason: string): void => say(`WARNING could not ${what}: ${reason}`);
  if (!request.keepRemote && git.remoteHead(top, branch) !== undefined) {
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
  const update = git.updateLocalBranch(top, defaultBranch);
  if (update.kind === 'failed') {
    warn(`move the local ${defaultBranch} to origin's`, update.reason);
  } else if (update.kind === 'updated' && !plan.linked && !request.keepLocal) {
    const switched = git.checkout(top, defaultBranch);
    if (!switched.ok) {
      warn(`check out ${defaultBranch}`, switched.reason);
    }
  }
}

/** Fast-forwards the main checkout to what landed, only on the default branch with no tracked changes; it never fails the integrate. */
async function followMainCheckout(ports: IntegratePorts, plan: Plan, landed: string): Promise<void> {
  const { git, say } = ports;
  const main = plan.mainCheckout;
  if (!plan.repo.config.followMainCheckout || main === undefined || !plan.linked) {
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
  if (was === undefined || !git.isAncestor(main, was, landed)) {
    note(`its ${plan.defaultBranch} has commits that are not on origin`);
    return;
  }
  const moved = git.fastForward(main, landed);
  if (!moved.ok) {
    note(moved.reason);
    return;
  }
  say(`fast-forwarded the main checkout ${main} to ${short(landed)}`);
  const touches = await rangeInstallTouches(git, main, was, landed);
  if (touches === undefined) {
    say(`NOTE could not read what the fast-forward changed: check whether ${main} needs npm ci --ignore-scripts`);
    return;
  }
  if (touches.length > 0) {
    say(`NOTE ${touches.join(', ')} changed: run npm ci --ignore-scripts in ${main}`);
  }
}

/** The step after a landed branch: removing its worktree. */
function nextStep(request: IntegrateRequest, plan: Plan): string | undefined {
  if (!plan.linked) {
    return undefined;
  }
  return request.keepLocal ? `next: teamrig worktree remove "${plan.top}" --delete-branch` : `next: teamrig worktree remove "${plan.top}"`;
}

/** Lands the branch of the checkout at `request.dir` on origin's default branch (see the module comment). */
export async function integrateBranch(setup: IntegrateSetup, ports: IntegratePorts, request: IntegrateRequest): Promise<IntegrateEnd> {
  const planned = await planOf(setup, ports, request);
  if (planned.kind !== 'ready') {
    return planned;
  }
  const { plan } = planned;
  const { repo, defaultBranch } = plan;
  if (!repo.listed) {
    ports.say(`NOTE ${repo.name} is not in coordinator.repos: no deploy targets, no dependency gate, no main checkout to follow`);
  }
  const { wait } = setup.coordinator;
  const clearance = await takeWhenClear(readinessOf(setup, ports, repo), ports, {
    session: request.session,
    purpose: `integrate ${repo.name}`,
    maxWaitMs: wait.maxMinutes * MINUTE_MS,
    pollMs: wait.pollSeconds * 1_000,
    onWait: (reason) => ports.say(`waiting: ${reason}`),
  });
  if (clearance.kind !== 'taken') {
    return { kind: 'refused', reason: clearance.reason };
  }
  let landing: Landing;
  try {
    landing = await land(setup, ports, request, plan, clearance.lock);
    if (landing.kind === 'landed' && repo.config.deploysOnPush.length > 0) {
      await appendDeploy(ports.files, setup.places, {
        type: 'deploy',
        kind: 'deploy',
        session: request.session,
        repo: repo.name,
        range: landing.range,
        what: `integrate ${plan.branch}`,
        note: `pushed to ${defaultBranch}; ${repo.config.deploysOnPush.join(', ')} deploy on push, not watched by teamrig`,
        startedAt: landing.startedAt,
        rolledAt: landing.endedAt,
      });
    }
  } finally {
    await ports.lock.release(clearance.lock);
  }
  if (landing.kind !== 'landed') {
    return landing;
  }
  tidy(ports, request, plan);
  await followMainCheckout(ports, plan, landing.after);
  const next = nextStep(request, plan);
  if (next !== undefined) {
    ports.say(next);
  }
  const deploys = repo.config.deploysOnPush.length > 0 ? `; ${repo.config.deploysOnPush.join(', ')} deploy on push` : '';
  return { kind: 'done', summary: `pushed ${landing.range} to ${defaultBranch}${deploys}` };
}
