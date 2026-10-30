import { dirname } from 'node:path';
import type { DeliveryConfig } from '../config/types.ts';
import { coveringFreezes, freezeText, readFreezes } from '../delivery/freezes.ts';
import { takeWhenClear, type ClearancePhase, type Readiness } from '../delivery/clearance.ts';
import { underLock, type HostLock, type HostLockInfo } from '../delivery/host-lock.ts';
import { appendDeploy } from '../delivery/ledger.ts';
import type { DeliveryPlaces } from '../delivery/places.ts';
import { NOT_STARTED_EXIT, recordQueuedStep } from '../delivery/recorded-step.ts';
import { queueCutoffReason, resetBlackoutReason, type ResetTime } from '../delivery/schedule.ts';
import type { Files } from '../core/files.ts';
import type { GitOutcome } from '../core/git-run.ts';
import type { Env } from '../core/home.ts';
import type { Clock, Sleep } from '../core/lock.ts';
import { samePath } from '../core/paths.ts';
import type { SecretScanner } from '../core/secrets.ts';
import type { TimeZone } from '../core/zone.ts';
import { runDependencyCheck } from '../merge/dependencies.ts';
import { LOCKFILE } from '../merge/manifest.ts';
import { askChecks, shownLine } from './checks.ts';
import { hookEndText, hookExitCode, succeeded, type HookEnd, type HookRunner } from './hooks.ts';
import { deployRepos, plural, readPending, short, type DependencyStep, type DeployGit, type DeployRepo, type Pending, type PendingRead } from './pending.ts';

/**
 * `teamrig deploy`: brings what was pushed to a repository's default branch to the running system, one deploy on the host
 * at a time. It reads what is pending (the main checkout's `HEAD..origin/<default branch>`), refuses what it must not
 * pull (a main checkout off its default branch, with tracked changes or commits origin lacks, a dependency change the
 * gate holds), waits out the queue cutoff's refusal, deploy freezes on the deploy's targets and the team's checks, takes the
 * host lock, asks again, then pulls fast-forward to the sha it checked, checks and installs a dependency change, runs
 * the afterPull hooks and the deploy command, all one queued step in the ledger, and records the deploy. Nothing pending
 * is done with nothing run.
 */

const MINUTE_MS = 60_000;
/** The line a deploy command prints when nothing needed deploying: the pull stays, and no deploy is recorded. */
export const NO_DEPLOY_LINE = 'no-deploy';

export interface DeployRequest {
  readonly session: string;
  /** A key of `delivery.repos`; undefined picks the repository the folder is in, else the only one with a deploy block. */
  readonly repo: string | undefined;
  /** The folder the command runs in. */
  readonly dir: string;
}

export interface DeploySetup {
  /** The team's name, given to every hook as `TEAMRIG_TEAM`. */
  readonly team: string;
  readonly delivery: DeliveryConfig;
  readonly places: DeliveryPlaces;
  /** The team's clock, for the times its refusals and waits name. */
  readonly zone: TimeZone;
  /** A configured path as a place: a relative one is in the team's folder. */
  inTeam(path: string): string;
}

export interface DeployPorts {
  readonly git: DeployGit;
  readonly hooks: HookRunner;
  readonly files: Files;
  readonly clock: Clock;
  readonly sleep: Sleep;
  readonly lock: Pick<HostLock, 'acquire' | 'release'>;
  /** This process's environment, which every hook gets with the deploy's `TEAMRIG_*` variables. */
  readonly env: Env;
  readonly platform: NodeJS.Platform;
  /** Redacts each line a hook prints before it is shown or recorded. */
  readonly scanner: Pick<SecretScanner, 'redact'>;
  /** The next weekly token reset after `nowMs`, read again at every check; undefined when unknown. */
  nextReset(nowMs: number): Promise<ResetTime | undefined>;
  newId(): string;
  /** A progress line. */
  say(text: string): void;
}

export type DeployEnd = { readonly kind: 'done'; readonly summary: string } | { readonly kind: 'failed'; readonly reason: string } | { readonly kind: 'refused'; readonly reason: string };

/** What the readiness check saw under the lock, which the deploy goes on: the pending range and a check's tag. */
interface LockedView {
  read: PendingRead | undefined;
  tag: string | undefined;
  /** The range the checks are told of: the last one read. */
  range: Pending;
}

/** How a failed dependency install was undone: the main checkout moved back and its old dependencies installed again, or not moved back. */
type InstallUndo = { readonly kind: 'reinstalled'; readonly end: HookEnd } | { readonly kind: 'notMovedBack'; readonly reason: string };

/** How the work under the lock went, with the exit code the ledger records for it. */
type DeployRun =
  | { readonly kind: 'notPulled'; readonly reason: string }
  | { readonly kind: 'checkFailed'; readonly touches: readonly string[]; readonly argv: readonly string[]; readonly end: HookEnd; readonly back: GitOutcome }
  | { readonly kind: 'installFailed'; readonly touches: readonly string[]; readonly argv: readonly string[]; readonly end: HookEnd; readonly undo: InstallUndo }
  | { readonly kind: 'afterPullFailed'; readonly argv: readonly string[]; readonly end: HookEnd }
  | { readonly kind: 'ran'; readonly end: HookEnd; readonly lastLine: string | undefined; readonly noDeploy: boolean };

function runExitCode(run: DeployRun): number {
  switch (run.kind) {
    case 'notPulled':
      return NOT_STARTED_EXIT;
    case 'checkFailed':
    case 'installFailed':
    case 'afterPullFailed':
    case 'ran':
      return hookExitCode(run.end);
  }
}

/** The repository to deploy: the one named, else the one the folder is in, else the only one with a deploy block. */
export function chosenRepo(setup: DeploySetup, ports: DeployPorts, request: DeployRequest): { readonly kind: 'chosen'; readonly repo: DeployRepo } | { readonly kind: 'refused'; readonly reason: string } {
  const repos = Object.entries(setup.delivery.repos);
  const deployable = deployRepos(setup.delivery, (path) => setup.inTeam(path));
  const names = deployable.length === 0 ? 'none has a deploy block' : `with a deploy block: ${deployable.map((repo) => repo.name).join(', ')}`;
  if (request.repo !== undefined) {
    const named = deployable.find((repo) => repo.name === request.repo);
    if (named !== undefined) {
      return { kind: 'chosen', repo: named };
    }
    const listed = repos.some(([name]) => name === request.repo);
    return { kind: 'refused', reason: listed ? `delivery.repos.${request.repo} has no deploy block, so there is nothing to deploy it with (${names})` : `${request.repo} is not in delivery.repos (${names})` };
  }
  const here = ports.git.checkoutOf(request.dir);
  const folderMain = here === undefined ? undefined : (here.mainCheckout ?? here.top);
  const inFolder = folderMain === undefined ? undefined : deployable.find((repo) => samePath(repo.main, folderMain, ports.platform));
  const only = deployable.length === 1 ? deployable[0] : undefined;
  const chosen = inFolder ?? only;
  if (chosen !== undefined) {
    return { kind: 'chosen', repo: chosen };
  }
  return { kind: 'refused', reason: deployable.length === 0 ? 'no repository in delivery.repos has a deploy block' : `name the repository to deploy with --repo (${names})` };
}

/** Every hook's environment: this process's, with the deploy's `TEAMRIG_*` variables and `extra`. */
function hookEnv(setup: DeploySetup, ports: DeployPorts, request: DeployRequest, repo: DeployRepo, pending: Pending, extra: Env = {}): Env {
  return {
    ...ports.env,
    TEAMRIG_TEAM: setup.team,
    TEAMRIG_SESSION: request.session,
    TEAMRIG_VERB: 'deploy',
    TEAMRIG_REPO: repo.name,
    TEAMRIG_PENDING_RANGE: `${pending.head}..${pending.target}`,
    ...extra,
  };
}

/**
 * What stops any change to `targets` before its checks are asked: the queue cutoff and the reset blackout refuse it, a
 * deploy freeze on one of them holds it; undefined when none does.
 */
export async function scheduleReadiness(setup: DeploySetup, ports: DeployPorts, targets: readonly string[]): Promise<Readiness | undefined> {
  const { schedule } = setup.delivery;
  const now = ports.clock.now();
  const hours = schedule.resetBlackoutHours;
  const refusal =
    queueCutoffReason(now, schedule.queueCutoffUtc, setup.zone) ??
    (hours === undefined ? undefined : resetBlackoutReason(now, await ports.nextReset(now), hours, setup.zone));
  if (refusal !== undefined) {
    return { kind: 'refuse', reason: refusal };
  }
  if (targets.length === 0) {
    return undefined;
  }
  const read = await readFreezes(ports.files, setup.places.freezes);
  if (read.kind === 'unreadable') {
    return { kind: 'wait', reason: `the deploy freezes in ${setup.places.freezes} are unreadable (${read.reason})` };
  }
  const covering = coveringFreezes(read.freezes, targets, now);
  return covering.length === 0 ? undefined : { kind: 'wait', reason: covering.map((freeze) => freezeText(freeze, setup.zone)).join('; ') };
}

/** A hook's line as it is shown and recorded: redacted, and said as it comes. */
export function shownBy(ports: Pick<DeployPorts, 'scanner' | 'say'>): (line: string) => string {
  return (line) => {
    const shown = shownLine(ports.scanner, line);
    ports.say(`  ${shown}`);
    return shown;
  };
}

/**
 * Whether the deploy may start: {@link scheduleReadiness} for its targets, then its checks. Under the lock the pending
 * range is read again, so the checks judge what is pulled; a range with nothing left, refused or unreadable is not the
 * checks' to judge, so the readiness check passes and the deploy ends under the lock.
 */
function readinessOf(setup: DeploySetup, ports: DeployPorts, request: DeployRequest, repo: DeployRepo, view: LockedView): (phase: ClearancePhase) => Promise<Readiness> {
  const { targets, checks } = repo.deploy;
  return async (phase) => {
    const stopped = await scheduleReadiness(setup, ports, targets);
    if (stopped !== undefined) {
      return stopped;
    }
    if (phase === 'locked') {
      view.read = await readPending(ports.git, repo);
      view.tag = undefined;
      if (view.read.kind !== 'pending') {
        return { kind: 'go' };
      }
      view.range = view.read.pending;
    }
    const answer = await askChecks(checks, phase, {
      hooks: ports.hooks,
      scanner: ports.scanner,
      cwd: repo.main,
      env: hookEnv(setup, ports, request, repo, view.range),
      timeoutSeconds: setup.delivery.checkTimeoutSeconds,
    });
    if (phase === 'locked') {
      view.tag = answer.tag;
    }
    return answer.readiness;
  };
}

/**
 * Under the lock, right after the pull of a range that changes the package files: the dependency check on what was
 * pulled, the old HEAD's package-lock.json its baseline, then the install. A failed check moves the main checkout back
 * to the old HEAD with nothing installed; a failed install moves it back and installs the old HEAD's dependencies
 * again, so the node_modules every worktree links to matches the checkout. Undefined goes on to the afterPull hooks.
 */
async function installDeps(setup: DeploySetup, ports: DeployPorts, repo: DeployRepo, head: string, deps: DependencyStep, env: Env, show: (line: string) => string): Promise<DeployRun | undefined> {
  const { touches, check } = deps;
  const timeoutMs = setup.delivery.queue.maxRunMinutes * MINUTE_MS;
  const changed = `deps changed (${touches.join(', ')})`;
  if (check !== undefined) {
    ports.say(`${changed}: dependency check ${check.join(' ')}`);
    const baseline = ports.git.fileAt(repo.main, head, LOCKFILE);
    const end = await runDependencyCheck(ports, { argv: check, cwd: repo.main, baseline, folder: dirname(setup.places.ledger), env, timeoutMs, onLine: show });
    if (!succeeded(end)) {
      return { kind: 'checkFailed', touches, argv: check, end, back: ports.git.resetTo(repo.main, head) };
    }
  }
  const install = { argv: deps.install, cwd: repo.main, env, timeoutMs, onLine: show };
  ports.say(`${changed}: dependency install ${deps.install.join(' ')}`);
  const end = await ports.hooks.run(install);
  if (succeeded(end)) {
    ports.say(`installed: the worktrees that link to the node_modules in ${repo.main} have the new dependencies now`);
    return undefined;
  }
  const back = ports.git.resetTo(repo.main, head);
  if (!back.ok) {
    return { kind: 'installFailed', touches, argv: deps.install, end, undo: { kind: 'notMovedBack', reason: back.reason } };
  }
  ports.say(`moved ${repo.main} back to ${short(head)}; installing its dependencies again`);
  return { kind: 'installFailed', touches, argv: deps.install, end, undo: { kind: 'reinstalled', end: await ports.hooks.run(install) } };
}

/**
 * Under the host lock `lock`: pulls fast-forward to the checked sha, checks and installs a dependency change (see
 * {@link installDeps}), then runs the afterPull hooks and the deploy command, each line shown redacted. They get the
 * lock's token, so a `teamrig queue` they start runs under this lock.
 */
async function pullAndDeploy(setup: DeploySetup, ports: DeployPorts, request: DeployRequest, repo: DeployRepo, pending: Pending, tag: string | undefined, lock: HostLockInfo): Promise<DeployRun> {
  const pulled = ports.git.fastForward(repo.main, pending.target);
  if (!pulled.ok) {
    return { kind: 'notPulled', reason: pulled.reason };
  }
  ports.say(`pulled ${repo.main} to ${short(pending.target)}`);
  const env = underLock(hookEnv(setup, ports, request, repo, pending, { TEAMRIG_DEPLOY_TO: pending.target, ...(tag === undefined ? {} : { TEAMRIG_DEPLOY_TAG: tag }) }), lock);
  const timeoutMs = setup.delivery.queue.maxRunMinutes * MINUTE_MS;
  const show = shownBy(ports);
  if (pending.deps !== undefined) {
    const failed = await installDeps(setup, ports, repo, pending.head, pending.deps, env, show);
    if (failed !== undefined) {
      return failed;
    }
  }
  for (const argv of repo.deploy.afterPull) {
    ports.say(`afterPull: ${argv.join(' ')}`);
    const end = await ports.hooks.run({ argv, cwd: repo.main, env, timeoutMs, onLine: show });
    if (!succeeded(end)) {
      return { kind: 'afterPullFailed', argv, end };
    }
  }
  ports.say(`deploy: ${repo.deploy.command.join(' ')}`);
  let lastLine: string | undefined;
  let noDeploy = false;
  const end = await ports.hooks.run({
    argv: repo.deploy.command,
    cwd: repo.main,
    env,
    timeoutMs,
    onLine: (line) => {
      const shown = show(line);
      noDeploy ||= line.trim() === NO_DEPLOY_LINE;
      if (shown.trim() !== '') {
        lastLine = shown.trim();
      }
    },
  });
  return { kind: 'ran', end, lastLine, noDeploy };
}

/** What a pulled range ends as, and its deploy record when the deploy command deployed something or failed trying. */
async function settle(setup: DeploySetup, ports: DeployPorts, request: DeployRequest, repo: DeployRepo, pending: Pending, tag: string | undefined, startedAt: string, run: DeployRun): Promise<DeployEnd> {
  const { range, commits } = pending;
  const byHand = `a new deploy finds nothing pending, so run \`${repo.deploy.command.join(' ')}\` in ${repo.main} by hand once it is fixed`;
  switch (run.kind) {
    case 'notPulled':
      return { kind: 'failed', reason: `the pull of ${range} into ${repo.main} failed (${run.reason}): nothing pulled, nothing deployed; deploy again` };
    case 'checkFailed':
    case 'installFailed':
      return dependencyEnd(repo, pending, run);
    case 'afterPullFailed':
      return { kind: 'failed', reason: `${range} pulled, but afterPull \`${run.argv.join(' ')}\` ${hookEndText(run.end)}, so nothing deployed; ${byHand}` };
    case 'ran':
      break;
  }
  const ok = succeeded(run.end);
  const said = run.lastLine === undefined || run.lastLine === NO_DEPLOY_LINE ? '' : `: ${run.lastLine}`;
  if (ok && run.noDeploy) {
    return { kind: 'done', summary: `${range} pulled; nothing needed deploying${said}` };
  }
  const carried = plural(commits.length, 'commit');
  const what = `deploy ${repo.deploy.targets.length > 0 ? repo.deploy.targets.join(', ') : repo.name}${tag === undefined ? '' : ` (${tag})`}`;
  await appendDeploy(ports.files, setup.places, {
    type: 'deploy',
    kind: 'deploy',
    session: request.session,
    repo: repo.name,
    range,
    what,
    note: ok ? `${carried}; ${run.lastLine ?? 'deployed'}` : `${carried}; the deploy command ${hookEndText(run.end)}${said}`,
    startedAt,
    rolledAt: new Date(ports.clock.now()).toISOString(),
  });
  if (ok) {
    return { kind: 'done', summary: `${range} deployed${said}` };
  }
  return { kind: 'failed', reason: `${range} pulled, but the deploy command ${hookEndText(run.end)}${said}; its owners fix forward or roll back, and ${byHand}` };
}

/** How a range whose dependency check or install failed ends: nothing deployed, and the main checkout back at its old HEAD or what to do by hand. */
function dependencyEnd(repo: DeployRepo, pending: Pending, run: Extract<DeployRun, { kind: 'checkFailed' | 'installFailed' }>): DeployEnd {
  const { main } = repo;
  const head = short(pending.head);
  const step = `deps changed (${run.touches.join(', ')}): the dependency ${run.kind === 'checkFailed' ? 'check' : 'install'} \`${run.argv.join(' ')}\` ${hookEndText(run.end)}`;
  if (run.kind === 'checkFailed') {
    return run.back.ok
      ? { kind: 'refused', reason: `${step}, so ${main} is back at ${head} and nothing deployed; its output is above` }
      : { kind: 'failed', reason: `${step}, and moving ${main} back to ${head} failed (${run.back.reason}): it is at ${short(pending.target)} with the old dependencies, so reset it to ${pending.head} by hand, else a new deploy finds nothing pending` };
  }
  const byHand = `run \`${run.argv.join(' ')}\` in ${main} by hand`;
  switch (run.undo.kind) {
    case 'notMovedBack':
      return { kind: 'failed', reason: `${step}, and moving ${main} back to ${head} failed (${run.undo.reason}): the node_modules every worktree links to may be broken; reset it to ${pending.head} and ${byHand}` };
    case 'reinstalled':
      return succeeded(run.undo.end)
        ? { kind: 'failed', reason: `${step}, so ${main} is back at ${head} with its dependencies installed again and nothing deployed; fix the install and deploy again` }
        : { kind: 'failed', reason: `${step}, and installing ${head}'s dependencies again ${hookEndText(run.undo.end)}: the node_modules every worktree links to may be broken; ${byHand}` };
  }
}

/** Deploys what was pushed to a repository's default branch (see the module comment). */
export async function deployRepo(setup: DeploySetup, ports: DeployPorts, request: DeployRequest): Promise<DeployEnd> {
  const chosen = chosenRepo(setup, ports, request);
  if (chosen.kind === 'refused') {
    return chosen;
  }
  const { repo } = chosen;
  const nothing = (head: string): DeployEnd => ({ kind: 'done', summary: `nothing to deploy: the ${repo.name} main checkout is at its origin's default branch (${short(head)})` });
  const early = await readPending(ports.git, repo);
  if (early.kind === 'none') {
    return nothing(early.head);
  }
  if (early.kind !== 'pending') {
    return early;
  }
  ports.say(`${plural(early.pending.commits.length, 'commit')} pending in ${repo.name} (${early.pending.range})`);
  const view: LockedView = { read: undefined, tag: undefined, range: early.pending };
  const { wait } = setup.delivery;
  const queuedAt = ports.clock.now();
  const clearance = await takeWhenClear(readinessOf(setup, ports, request, repo, view), ports, {
    session: request.session,
    purpose: `deploy ${repo.name}`,
    maxWaitMs: wait.maxMinutes * MINUTE_MS,
    pollMs: wait.pollSeconds * 1_000,
    zone: setup.zone,
    onWait: (reason) => ports.say(`waiting: ${reason}`),
  });
  if (clearance.kind !== 'taken') {
    return { kind: 'refused', reason: clearance.reason };
  }
  try {
    const latest = view.read ?? (await readPending(ports.git, repo));
    if (latest.kind === 'none') {
      return nothing(latest.head);
    }
    if (latest.kind !== 'pending') {
      return latest;
    }
    const { pending } = latest;
    const { tag } = view;
    const startedAt = new Date(ports.clock.now()).toISOString();
    ports.say(`clear; pulling ${plural(pending.commits.length, 'commit')} (${pending.range}) into ${repo.main}`);
    const run = await recordQueuedStep(ports, setup.places.ledger, { session: request.session, what: `deploy ${repo.name} ${pending.range}`, queuedAt }, () => pullAndDeploy(setup, ports, request, repo, pending, tag, clearance.lock), runExitCode);
    return await settle(setup, ports, request, repo, pending, tag, startedAt, run);
  } finally {
    await ports.lock.release(clearance.lock);
  }
}
