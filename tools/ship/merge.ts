import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { type CheckOutcome, type Gh, type RequiredChecks, ghWithToken, readChecks, rerunFailedJobs, verdictOf } from './github.ts';
import { type Credential, SHIP_TOKEN_TARGET, readCredential, windowsPowerShell } from './keychain.ts';
import { type MergeOutcome, type PullRequest, findOpenPull, openPull, rebaseMerge } from './pulls.ts';
import { type MergedHead, pullsOfHead, sweepAfterMerge } from './leftovers.ts';
import { type GateDeps, proveTree, realGateDeps } from './local-gate.ts';
import { realRenamedCallersDeps, renamedCallersRefusal } from './renamed-callers.ts';
import { type LocalChecks, type RepoProfile, profileFor, readProfiles, slugOf } from './repos.ts';
import { describeCredential } from './token-check.ts';

/**
 * `ship.ts merge`, the only merge route the auto-mode briefing grants for these repos.
 * Merges a pushed change branch (by default the one checked out in the repo dir, never main itself) into
 * a repo's main through a pull request: refuse a branch that main moved past, find or open the PR, prove the
 * PR's head sha by the repo's gate in repos.json, refuse again if main moved meanwhile, then rebase-merge
 * pinned to that sha and confirm main's new tree is the tree the checks ran on. The gate is `ci` (wait until
 * every listed check passed on GitHub; a failed one stops at once, a missing or running one at the deadline
 * is a fail, and a job GitHub cancelled before any step ran is re-run once) or `local` (the head checked out
 * clean in the repo dir, with a pass record for its tree, else the local checks run there; see local-gate.ts). Before any GitHub call it refuses a change that renames a teamrig
 * command while a consumer on this machine still calls only the old name (see renamed-callers.ts). Once merged,
 * it deletes on origin the merged head while it is still at the merged sha, the branches an earlier push of the
 * same task left with no work main lacks, and every closed, unmerged pull request's head (leftovers.ts).
 *
 * A rebase merge replays the branch onto main as it is at merge time, and GitHub merges a stale branch
 * whenever it does not conflict: what lands is then a tree no check ran on, and a commit that repeats one
 * already on main (a same-edit plugin version bump) is dropped. So the branch must contain main's tip.
 */

export interface Waiter {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export interface Polling {
  timeoutMs: number;
  intervalMs: number;
}

export type ChecksResult = { verdict: 'passed' | 'failed' | 'timeout'; outcomes: CheckOutcome[] };

/** The checks that wait on a re-run, failed for the re-run call's error: nothing else can prove them. */
const rerunRefused = (outcomes: readonly CheckOutcome[], message: string): ChecksResult => ({
  verdict: 'failed',
  outcomes: outcomes.map(outcome => (outcome.state === 'unstarted' ? { ...outcome, state: 'failed', detail: `${outcome.detail}; the re-run failed: ${message}`, reruns: [] } : outcome)),
});

/**
 * Polls the required checks until they pass, one fails, or the deadline. A run whose required jobs GitHub cancelled
 * before any step ran (no runner came) is re-run once, then waited on again; `evaluate` fails the same in a later
 * attempt, and a run already re-run here is not re-run again while GitHub starts the new attempt.
 */
export async function waitForChecks(gh: Gh, repo: string, sha: string, required: RequiredChecks, waiter: Waiter, polling: Polling, log: (line: string) => void = () => {}): Promise<ChecksResult> {
  const deadline = waiter.now() + polling.timeoutMs;
  const rerun = new Set<number>();
  for (;;) {
    const outcomes = readChecks(gh, repo, sha, required);
    const verdict = verdictOf(outcomes);
    if (verdict === 'passed' || verdict === 'failed') return { verdict, outcomes };
    if (verdict === 'rerun') {
      for (const runId of new Set(outcomes.flatMap(outcome => outcome.reruns))) {
        if (rerun.has(runId)) continue;
        rerun.add(runId);
        const names = outcomes.filter(outcome => outcome.reruns.includes(runId)).map(outcome => outcome.name);
        try {
          rerunFailedJobs(gh, repo, runId);
        } catch (error) {
          return rerunRefused(outcomes, error instanceof Error ? error.message : String(error));
        }
        log(`re-ran run ${runId}: ${names.join(', ')} cancelled before any step ran (no runner came); waiting again, once`);
      }
    }
    if (waiter.now() >= deadline) return { verdict: 'timeout', outcomes };
    await waiter.sleep(Math.min(polling.intervalMs, Math.max(deadline - waiter.now(), 0)));
  }
}

export interface MergeRequest {
  repo: string;
  head: string;
  base: string;
  /** The sha the caller pushed and means to merge; a PR whose head differs is refused. */
  sha: string;
  title: string;
  body: string;
}

/** What proves a pull request's head before it merges: the repo's gate. */
export interface Proof {
  /** Why `sha` cannot be proven here at all, checked before any pull request is found or opened; null when it can. */
  before(sha: string): string | null;
  /** Why `sha` did not pass, or null when it did. */
  prove(sha: string, log: (line: string) => void): Promise<string | null>;
}

const listed = (outcomes: readonly CheckOutcome[], state: CheckOutcome['state']): string =>
  outcomes
    .filter(outcome => outcome.state === state)
    .map(outcome => `${outcome.name} (${outcome.detail})`)
    .join('; ');

/** The `ci` gate: every check in `required` green on GitHub for the sha. */
export function ciProof(gh: Gh, repo: string, required: RequiredChecks, waiter: Waiter, polling: Polling): Proof {
  return {
    before: () => null,
    prove: async (sha, log) => {
      const checks = await waitForChecks(gh, repo, sha, required, waiter, polling, log);
      for (const outcome of checks.outcomes) log(`check ${outcome.state}: ${outcome.name} (${outcome.detail})`);
      if (checks.verdict === 'failed') return `failed: ${listed(checks.outcomes, 'failed')}`;
      if (checks.verdict === 'timeout') {
        const open = [listed(checks.outcomes, 'pending'), listed(checks.outcomes, 'missing'), listed(checks.outcomes, 'unstarted')].filter(part => part !== '').join('; ');
        return `not green after ${Math.round(polling.timeoutMs / 60_000)} min: ${open}`;
      }
      return null;
    },
  };
}

/**
 * The `local` gate: the sha checked out with no changes in the repo dir, and its tree proven there (a pass
 * record, else every local check run). The record lives in the repo's git folder, so it proves this
 * machine's run of exactly that tree.
 */
export function localProof(dir: string, checks: LocalChecks, gate: GateDeps): Proof {
  const before = (sha: string): string | null => {
    const checkedOut = gate.git('rev-parse', 'HEAD');
    if (checkedOut !== sha) return `${dir} has ${checkedOut.slice(0, 7)} checked out, not ${sha.slice(0, 7)}: the local checks prove the checked-out tree, so check out the branch to merge`;
    return gate.git('status', '--porcelain') === '' ? null : `${dir} has uncommitted changes: commit or stash them, the local checks prove only a committed tree`;
  };
  return {
    before,
    prove: async sha => {
      const unready = before(sha);
      if (unready !== null) return unready;
      const verdict = proveTree(dir, checks, gate);
      return verdict.passed ? null : verdict.reason;
    },
  };
}

/** main on origin, as git in the repo dir sees it, so a test can stand in for it. */
export interface MainBranch {
  /** Fetches main and returns its sha on origin. */
  tip(): string;
  /** Whether `ancestor` is in `sha`'s history. */
  contains(sha: string, ancestor: string): boolean;
  /** The tree a fetched commit holds. */
  treeOf(sha: string): string;
}

/** main's tip that a head does not contain, and why that stops the merge. */
export interface MainMove {
  tip: string;
  reason: string;
}

/**
 * Merged, refused, moved past (main's tip is not in the head's history, before the merge or as GitHub merged: a
 * ship can rebase and go again, T2696), or merged onto a main that moved between the last check and the merge
 * (GitHub's merge call cannot pin the base): main then holds a tree no check ran on.
 */
export type MergeResult =
  | { kind: 'merged'; pull: PullRequest; sha: string }
  | { kind: 'refused'; pull: PullRequest | null; reason: string }
  | ({ kind: 'moved'; pull: PullRequest | null } & MainMove)
  | { kind: 'drifted'; pull: PullRequest; sha: string; reason: string };

/** main's tip and why `head` cannot merge as checked, when that tip is not in its history; null when it is. */
function behindMain(main: MainBranch, { head, base, sha }: MergeRequest): MainMove | null {
  const tip = main.tip();
  if (main.contains(sha, tip)) return null;
  return { tip, reason: `${base} moved to ${tip.slice(0, 7)}, which ${head} ${sha.slice(0, 7)} does not contain: rebase ${head} onto origin/${base}, push it and run merge again` };
}

/** Why main's merged tip differs from the checked head's tree, or null when it holds that very tree. */
function driftAfter(main: MainBranch, request: MergeRequest, merged: string): string | null {
  try {
    main.tip();
    if (main.treeOf(merged) === main.treeOf(request.sha)) return null;
    return `${request.base} moved just before the merge: ${merged.slice(0, 7)} is not the tree the checks passed on ${request.sha.slice(0, 7)}; check it (a plugin version bump may be lost) and ship a fix`;
  } catch (error) {
    return `could not compare ${merged.slice(0, 7)} with the checked ${request.sha.slice(0, 7)}: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/** A merge GitHub refuses for a rule set on the repo (required checks, branch protection), not for the change. */
const REPO_RULE = /required status check|protected branch|branch protection|repository rule/i;

/** GitHub's 405 when main moved between the last read and the merge call. */
const BASE_MODIFIED = /base branch was modified/i;

export async function mergeThroughPull(request: MergeRequest, gh: Gh, main: MainBranch, proof: Proof, log: (line: string) => void): Promise<MergeResult> {
  const { repo, head, base, sha } = request;
  const stale = behindMain(main, request);
  if (stale !== null) return { kind: 'moved', pull: null, ...stale };
  const unready = proof.before(sha);
  if (unready !== null) return { kind: 'refused', pull: null, reason: unready };
  const found = findOpenPull(gh, repo, head, base);
  const pull = found ?? openPull(gh, repo, head, base, request.title, request.body);
  log(`${found === null ? 'opened' : 'found'} pull request #${pull.number} ${pull.url}`);
  if (pull.headSha !== sha) return { kind: 'refused', pull, reason: `the pull request head ${pull.headSha.slice(0, 7)} is not ${head} ${sha.slice(0, 7)}: push ${head} first` };

  const failed = await proof.prove(sha, log);
  if (failed !== null) return { kind: 'refused', pull, reason: failed };
  // main may have moved while the checks ran.
  const moved = behindMain(main, request);
  if (moved !== null) return { kind: 'moved', pull, ...moved };

  let merged: MergeOutcome;
  try {
    merged = rebaseMerge(gh, repo, pull.number, sha);
  } catch (error) {
    // 405 not mergeable (protection, conflict) and 409 head moved come back as a gh failure.
    merged = { merged: false, message: error instanceof Error ? error.message : String(error) };
  }
  if (!merged.merged) {
    // Read main only for this answer: it names main's move, and the head is then simply behind it.
    const raced = BASE_MODIFIED.test(merged.message) ? behindMain(main, request) : null;
    if (raced !== null) return { kind: 'moved', pull, ...raced };
    const rule = REPO_RULE.test(merged.message) ? " (a rule set on the repo, not the change: changing it is the repo owner's call, so report it and stop)" : '';
    return { kind: 'refused', pull, reason: `GitHub refused the merge: ${merged.message}${rule}` };
  }
  const drift = driftAfter(main, request, merged.sha);
  return drift === null ? { kind: 'merged', pull, sha: merged.sha } : { kind: 'drifted', pull, sha: merged.sha, reason: drift };
}

/** main on origin through git in the repo dir. */
export function mainBranchOf(git: MergeDeps['git'], main: string): MainBranch {
  return {
    tip: () => {
      git('fetch', '--quiet', 'origin', main);
      return git('rev-parse', `refs/remotes/origin/${main}`);
    },
    contains: (sha, ancestor) => git('merge-base', sha, ancestor) === ancestor,
    treeOf: sha => git('rev-parse', `${sha}^{tree}`),
  };
}

export interface MergeArgs {
  dir: string;
  /** The branch to merge; null means the one checked out in the repo dir. */
  head: string | null;
  timeoutMin: number;
  intervalS: number;
  /** A Markdown file whose text opens the body of a pull request the merge opens (a gap, a follow-up); null for none. */
  noteFile: string | null;
}

export function parseArgs(argv: readonly string[]): MergeArgs {
  const usage = 'usage: ship.ts merge <repo dir> [--head <branch>] [--timeout-min <n>] [--interval-s <n>] [--note-file <path>]';
  const [dir, ...rest] = argv;
  if (dir === undefined || dir.startsWith('--')) throw new Error(usage);
  const parsed: MergeArgs = { dir, head: null, timeoutMin: 45, intervalS: 30, noteFile: null };
  for (let i = 0; i < rest.length; i += 2) {
    const [flag, value] = [rest[i], rest[i + 1]];
    if (value === undefined) throw new Error(`${flag ?? ''} needs a value`);
    if (flag === '--head' && /^[\w./-]+$/.test(value)) parsed.head = value;
    else if (flag === '--timeout-min' && /^\d+$/.test(value) && Number(value) > 0) parsed.timeoutMin = Number(value);
    else if (flag === '--interval-s' && /^\d+$/.test(value) && Number(value) > 0) parsed.intervalS = Number(value);
    else if (flag === '--note-file' && !value.startsWith('--')) parsed.noteFile = value;
    else throw new Error(`${usage} (got ${flag} ${value})`);
  }
  return parsed;
}

/** The PR body: the note when there is one, the commits it ships, then the attribution line. */
export function pullBody(subjects: readonly string[], note: string | null = null, limit = 60): string {
  const shown = subjects.slice(0, limit).map(subject => `- ${subject}`);
  if (subjects.length > limit) shown.push(`- … and ${subjects.length - limit} more`);
  const opening = note === null || note.trim() === '' ? [] : [note.trim(), '', '## Commits'];
  return [...opening, ...shown, '', '🤖 Generated with [Claude Code](https://claude.com/claude-code)'].join('\n');
}

/** What the command reaches outside itself, so a test can stand in for each. */
export interface MergeDeps {
  /** Runs git in the repo dir and returns its trimmed stdout; throws when git fails. */
  git: (...args: string[]) => string;
  profiles: ReadonlyMap<string, RepoProfile>;
  credential: () => Credential;
  ghFor: (token: string) => Gh;
  /** GitHub check polling, for a repo whose gate is `ci`. */
  waiter: Waiter;
  /** The repo dir's files and processes, for a repo whose gate is `local`. */
  gate: GateDeps;
  /** Why the change from main (`base`) to `tip` may not merge for a renamed command a consumer still calls, or null. */
  renamedCallers: (base: string, tip: string, repo: string) => string | null;
  /** After a head merged: deletes it, its task's leftovers and the closed heads on origin, and names the rest (leftovers.ts); never throws. */
  sweep: (merged: MergedHead, profile: RepoProfile, gh: Gh) => void;
  out: (line: string) => void;
  err: (line: string) => void;
}

/** The branch checked out in the repo dir; a detached HEAD has none. */
function checkedOutBranch(git: MergeDeps['git']): string {
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
  if (branch === 'HEAD') throw new Error('the repo dir has a detached HEAD: pass --head <branch>');
  return branch;
}

/** How a merge run ended: its exit code once it said why, or main moved past the head and nothing was said yet. */
export type MergeExit = { kind: 'done'; code: number } | ({ kind: 'moved' } & MainMove);

const done = (code: number): MergeExit => ({ kind: 'done', code });

/** `ship.ts merge` as a run: a move of main comes back unsaid, so a ship can rebase and go again (T2696). */
export async function runMerge(args: MergeArgs, deps: MergeDeps): Promise<number> {
  const exit = await mergeRun(args, deps);
  if (exit.kind === 'done') return exit.code;
  deps.err(`REFUSED ${exit.reason}`);
  return 1;
}

/** The merge itself; prints every outcome but a move of main past the head, which it returns to the caller. */
export async function mergeRun(args: MergeArgs, deps: MergeDeps): Promise<MergeExit> {
  const { git } = deps;
  const repo = slugOf(git('remote', 'get-url', 'origin'));
  const profile = profileFor(deps.profiles, repo);
  const head = args.head ?? checkedOutBranch(git);
  if (head === profile.main) throw new Error(`${head} is the branch merged into: ship a change branch`);
  git('fetch', '--quiet', 'origin', head, profile.main);
  const sha = git('rev-parse', `refs/heads/${head}`);
  if (git('rev-parse', `refs/remotes/origin/${head}`) !== sha) throw new Error(`${head} ${sha.slice(0, 7)} is not pushed: push it first`);
  const subjects = git('log', '--reverse', '--format=%s', `refs/remotes/origin/${profile.main}..${sha}`).split('\n').filter(line => line !== '');
  if (subjects.length === 0) throw new Error(`${head} has nothing that ${profile.main} lacks`);
  const note = args.noteFile === null ? null : deps.gate.readText(args.noteFile);
  if (args.noteFile !== null && note === null) throw new Error(`--note-file ${args.noteFile}: no such file`);
  const callers = deps.renamedCallers(`refs/remotes/origin/${profile.main}`, sha, repo);
  if (callers !== null) {
    deps.err(`REFUSED ${callers}`);
    return done(1);
  }

  const credential = deps.credential();
  if (credential.kind !== 'found') {
    deps.err(describeCredential(credential));
    return done(1);
  }
  const gh = deps.ghFor(credential.secret);
  const proof =
    profile.gate === 'ci'
      ? ciProof(gh, repo, { names: profile.checks, summary: profile.summary }, deps.waiter, { timeoutMs: args.timeoutMin * 60_000, intervalMs: args.intervalS * 1000 })
      : localProof(args.dir, profile.local, deps.gate);
  const result = await mergeThroughPull(
    { repo, head, base: profile.main, sha, title: `Merge ${head} into ${profile.main}: ${subjects.length} commit(s)`, body: pullBody(subjects, note) },
    gh,
    mainBranchOf(git, profile.main),
    proof,
    deps.out,
  );
  if (result.kind === 'moved') return { kind: 'moved', tip: result.tip, reason: result.reason };
  if (result.kind === 'refused') {
    deps.err(`REFUSED ${result.reason}`);
    return done(1);
  }
  deps.out(`MERGED #${result.pull.number} into ${profile.main}, now at ${result.sha.slice(0, 7)}`);
  // A drifted merge landed too: head's work is on main either way.
  deps.sweep({ repo, head, sha }, profile, gh);
  if (result.kind === 'drifted') {
    deps.err(`DRIFTED ${result.reason}`);
    return done(1);
  }
  return done(0);
}

/** The real git, keychain, gh, clock and local checks for a repo dir. */
export function realMergeDeps(dir: string): MergeDeps {
  const out = (line: string): void => console.log(line);
  const err = (line: string): void => console.error(line);
  const git = (...gitArgs: string[]): string => execFileSync('git', ['-C', dir, ...gitArgs], { encoding: 'utf8' }).trim();
  return {
    git,
    profiles: readProfiles(),
    credential: () => readCredential(SHIP_TOKEN_TARGET, windowsPowerShell),
    ghFor: token => ghWithToken(token),
    waiter: { now: () => Date.now(), sleep: ms => new Promise(done => setTimeout(done, ms)) },
    gate: realGateDeps(dir, out),
    renamedCallers: (base, tip, repo) => renamedCallersRefusal({ base, tip, repo }, { env: process.env, userHome: homedir() }, realRenamedCallersDeps(dir, out)),
    sweep: (merged, profile, gh) => sweepAfterMerge(merged, profile, { git, pullsOf: pullsOfHead(gh, merged.repo), out, err }),
    out,
    err,
  };
}

/** Parses `argv` and runs `run` on its deps; a usage or git error is one line, never a stack, and ends as `failed`. */
async function fromArgv<T>(argv: readonly string[], depsFor: (dir: string) => MergeDeps, run: (args: MergeArgs, deps: MergeDeps) => Promise<T>, failed: T): Promise<T> {
  let err: (line: string) => void = line => console.error(line);
  try {
    const args = parseArgs(argv);
    const deps = depsFor(args.dir);
    err = deps.err;
    return await run(args, deps);
  } catch (error) {
    err(error instanceof Error ? error.message : String(error));
    return failed;
  }
}

/** `ship.ts merge ...`: the exit code. */
export function mergeCommand(argv: readonly string[], depsFor: (dir: string) => MergeDeps = realMergeDeps): Promise<number> {
  return fromArgv(argv, depsFor, runMerge, 1);
}

/** The merge a ship runs (ship.ts): like `mergeCommand`, but a move of main past the branch comes back to the ship. */
export function mergeBranch(argv: readonly string[], depsFor: (dir: string) => MergeDeps = realMergeDeps): Promise<MergeExit> {
  return fromArgv(argv, depsFor, mergeRun, done(1));
}
