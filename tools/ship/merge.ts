import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { nodeFiles } from '../../src/core/files.ts';
import { realSleep, systemClock } from '../../src/core/lock.ts';
import { type ClearMerge, clearMergeFrom } from './approval.ts';
import { buildScriptOf, buildSteps } from './build-steps.ts';
import { type CatchUp, type CatchUpRequest, catchUp } from './catch-up.ts';
import { type CheckOutcome, type Gh, type RequiredChecks, ghWithToken, readChecks, rerunFailedJobs, verdictOf } from './github.ts';
import { type Credential, SHIP_TOKEN_TARGET, readCredential, windowsPowerShell } from './keychain.ts';
import { type MergeOutcome, type PullRequest, findOpenPull, openPull, rebaseMerge } from './pulls.ts';
import { type MergedHead, pullsOfHead, sweepAfterMerge } from './leftovers.ts';
import { type GateDeps, proveTree, realGateDeps } from './local-gate.ts';
import { realRenamedCallersDeps, renamedCallersRefusal } from './renamed-callers.ts';
import { type LocalChecks, type RepoProfile, profileFor, readProfiles, slugOf } from './repos.ts';
import { APPROVED_SHA } from './ship-plan.ts';
import { describeCredential } from './token-check.ts';

/**
 * `ship.ts merge`, the only merge route the auto-mode briefing grants for these repos.
 * Merges a pushed change branch (by default the one checked out in the repo dir, never main itself) into
 * a repo's main through a pull request: catch up a branch that main moved past (runMerge), find or open the PR, prove the
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

const awaitsRerun = (outcome: CheckOutcome): boolean => outcome.state === 'unstarted' || outcome.state === 'flaky';

/** The checks that wait on a re-run, failed for the re-run call's error: nothing else can prove them. */
const rerunRefused = (outcomes: readonly CheckOutcome[], message: string): ChecksResult => ({
  verdict: 'failed',
  outcomes: outcomes.map(outcome => (awaitsRerun(outcome) ? { ...outcome, state: 'failed', detail: `${outcome.detail}; the re-run failed: ${message}`, reruns: [] } : outcome)),
});

/** Why a run is re-run: what its checks that wait on it show. */
const rerunWhy = (outcomes: readonly CheckOutcome[]): string =>
  outcomes.some(outcome => outcome.state === 'flaky') ? 'failed on a check listed as flaky (repos.json), so the same sha goes once more' : 'cancelled before any step ran (no runner came)';

/**
 * The required checks of `sha`, or the error of a read GitHub gave no answer to (a 5xx, a timeout, a reset: T2988),
 * which the wait reads once more at its next poll, so one bad read does not end a wait of up to 45 minutes. GitHub's
 * own refusal (a 4xx) and a second bad read in a row throw.
 */
function readOnceMore(read: () => CheckOutcome[], failedBefore: boolean, log: (line: string) => void): CheckOutcome[] | Error {
  try {
    return read();
  } catch (error) {
    const message = messageOf(error);
    if (failedBefore || REFUSAL.test(message)) throw error;
    log(`reading the checks got no answer from GitHub (${message}): reading them once more at the next poll`);
    return error instanceof Error ? error : new Error(message);
  }
}

/**
 * Polls the required checks until they pass, one fails, or the deadline. A run whose required jobs GitHub cancelled
 * before any step ran (no runner came), or whose only failures are checks listed as flaky (T2532, T2988), is re-run
 * once, then waited on again; `evaluate` fails the same in a later attempt, and a run already re-run here is not
 * re-run again while GitHub starts the new attempt. A read with no answer from GitHub is tried once more (readOnceMore).
 */
export async function waitForChecks(
  gh: Gh,
  repo: string,
  sha: string,
  branch: string,
  required: RequiredChecks,
  waiter: Waiter,
  polling: Polling,
  log: (line: string) => void = () => {},
): Promise<ChecksResult> {
  const deadline = waiter.now() + polling.timeoutMs;
  const rerun = new Set<number>();
  let readFailed = false;
  for (;;) {
    const read = readOnceMore(() => readChecks(gh, repo, sha, branch, required), readFailed, log);
    readFailed = read instanceof Error;
    if (read instanceof Error) {
      if (waiter.now() >= deadline) throw read;
      await waiter.sleep(Math.min(polling.intervalMs, Math.max(deadline - waiter.now(), 0)));
      continue;
    }
    const outcomes = read;
    const verdict = verdictOf(outcomes);
    if (verdict === 'passed' || verdict === 'failed') return { verdict, outcomes };
    if (verdict === 'rerun') {
      for (const runId of new Set(outcomes.flatMap(outcome => outcome.reruns))) {
        if (rerun.has(runId)) continue;
        rerun.add(runId);
        const waiting = outcomes.filter(outcome => outcome.reruns.includes(runId));
        const names = waiting.map(outcome => outcome.name);
        try {
          rerunFailedJobs(gh, repo, runId);
        } catch (error) {
          return rerunRefused(outcomes, error instanceof Error ? error.message : String(error));
        }
        log(`re-ran run ${runId}: ${names.join(', ')} ${rerunWhy(waiting)}; waiting again, once`);
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

/** The `ci` gate: every check in `required` green on GitHub for the sha, in the runs of `branch` (the head merged). */
export function ciProof(gh: Gh, repo: string, branch: string, required: RequiredChecks, waiter: Waiter, polling: Polling): Proof {
  return {
    before: () => null,
    prove: async (sha, log) => {
      const checks = await waitForChecks(gh, repo, sha, branch, required, waiter, polling, log);
      for (const outcome of checks.outcomes) log(`check ${outcome.state}: ${outcome.name} (${outcome.detail})`);
      if (checks.verdict === 'failed') return `failed: ${listed(checks.outcomes, 'failed')}`;
      if (checks.verdict === 'timeout') {
        const open = [listed(checks.outcomes, 'pending'), listed(checks.outcomes, 'missing'), listed(checks.outcomes, 'unstarted'), listed(checks.outcomes, 'flaky')].filter(part => part !== '').join('; ');
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
function behindMain(main: MainBranch, { head, base, sha }: MergeRequest, tip: string = main.tip()): MainMove | null {
  if (main.contains(sha, tip)) return null;
  return { tip, reason: `${base} moved to ${tip.slice(0, 7)}, which ${head} ${sha.slice(0, 7)} does not contain: rebase ${head} onto origin/${base}, push it and run merge again` };
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Why main's merged tip differs from the checked head's tree, or null when it holds that very tree. */
function driftAfter(main: MainBranch, request: MergeRequest, merged: string): string | null {
  try {
    main.tip();
    if (main.treeOf(merged) === main.treeOf(request.sha)) return null;
    return `${request.base} moved just before the merge: ${merged.slice(0, 7)} is not the tree the checks passed on ${request.sha.slice(0, 7)}; check it (a plugin version bump may be lost) and ship a fix`;
  } catch (error) {
    return `could not compare ${merged.slice(0, 7)} with the checked ${request.sha.slice(0, 7)}: ${messageOf(error)}`;
  }
}

/** A merge GitHub refuses for a rule set on the repo (required checks, branch protection), not for the change. */
const REPO_RULE = /required status check|protected branch|branch protection|repository rule/i;

/** GitHub's 405 when main moved between the last read and the merge call. */
const BASE_MODIFIED = /base branch was modified/i;

/** A gh failure carrying GitHub's own refusal; any other (a 5xx, a timeout, a reset) leaves the merge unknown. */
const REFUSAL = /\bHTTP 4\d\d\b/;

/** The merge call's answer, or the failure that left GitHub's answer unknown. */
type MergeCall = MergeOutcome | { merged: 'unknown'; message: string };

function callMerge(gh: Gh, repo: string, pull: number, sha: string): MergeCall {
  try {
    return rebaseMerge(gh, repo, pull, sha);
  } catch (error) {
    // 405 not mergeable (protection, conflict) and 409 head moved come back as a gh failure.
    const message = messageOf(error);
    return REFUSAL.test(message) ? { merged: false, message } : { merged: 'unknown', message };
  }
}

/** main's tip when it moved past `checkedTip` onto the checked tree, which only this merge lands; null otherwise. */
function landedTip(main: MainBranch, sha: string, checkedTip: string, log: (line: string) => void): string | null {
  try {
    const tip = main.tip();
    return tip !== checkedTip && main.treeOf(tip) === main.treeOf(sha) ? tip : null;
  } catch (error) {
    log(`could not read main after the merge call: ${messageOf(error)}`);
    return null;
  }
}

/**
 * Rebase-merges the pull request pinned to the checked head. A call with no answer from GitHub may still have
 * merged (T2709: a 502 while main took the rebase and the pull request stayed open), so main is read: its new tip
 * holding the checked tree is the merge. Otherwise the call goes once more, still pinned, and main is read again
 * whatever it answers, since a late landing of the first call makes the second fail.
 */
function mergeOrLanded(gh: Gh, main: MainBranch, request: MergeRequest, pull: number, checkedTip: string, log: (line: string) => void): MergeOutcome {
  const landed = (failure: string): MergeOutcome | null => {
    const tip = landedTip(main, request.sha, checkedTip, log);
    if (tip === null) return null;
    log(`the merge call failed (${failure}), but ${request.base} moved to ${tip.slice(0, 7)} holding the checked tree: #${pull} merged; GitHub may show it open until its head is deleted`);
    return { merged: true, sha: tip };
  };
  const first = callMerge(gh, request.repo, pull, request.sha);
  if (first.merged !== 'unknown') return first;
  const late = landed(first.message);
  if (late !== null) return late;
  log(`the merge call failed (${first.message}) and ${request.base} does not hold the checked tree: trying once more`);
  const second = callMerge(gh, request.repo, pull, request.sha);
  if (second.merged === true) return second;
  const later = landed(second.message);
  if (later !== null) return later;
  if (second.merged === false) return second;
  return { merged: false, message: `${first.message}; again: ${second.message}; ${request.base} does not hold the checked tree, so check #${pull} on GitHub before shipping again` };
}

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
  const checkedTip = main.tip();
  const moved = behindMain(main, request, checkedTip);
  if (moved !== null) return { kind: 'moved', pull, ...moved };

  const merged = mergeOrLanded(gh, main, request, pull.number, checkedTip, log);
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
  /** The head sha the caller's approver approved (T2788); a merge of any other head is refused. */
  approved: string | null;
}

export function parseArgs(argv: readonly string[]): MergeArgs {
  const usage = 'usage: ship.ts merge <repo dir> [--head <branch>] [--approved <sha>] [--timeout-min <n>] [--interval-s <n>] [--note-file <path>]';
  const [dir, ...rest] = argv;
  if (dir === undefined || dir.startsWith('--')) throw new Error(usage);
  const parsed: MergeArgs = { dir, head: null, timeoutMin: 45, intervalS: 30, noteFile: null, approved: null };
  for (let i = 0; i < rest.length; i += 2) {
    const [flag, value] = [rest[i], rest[i + 1]];
    if (value === undefined) throw new Error(`${flag ?? ''} needs a value`);
    if (flag === '--head' && /^[\w./-]+$/.test(value)) parsed.head = value;
    else if (flag === '--timeout-min' && /^\d+$/.test(value) && Number(value) > 0) parsed.timeoutMin = Number(value);
    else if (flag === '--interval-s' && /^\d+$/.test(value) && Number(value) > 0) parsed.intervalS = Number(value);
    else if (flag === '--note-file' && !value.startsWith('--')) parsed.noteFile = value;
    else if (flag === '--approved' && APPROVED_SHA.test(value)) parsed.approved = value;
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
  /** Whether the caller may merge the branch at its head on the approval it names (approval.ts, T2788). */
  clearMerge: ClearMerge;
  /** A head main moved past, rebased onto main's tip and pushed as a new branch when its diff stays the same (catch-up.ts). */
  catchUp: (request: CatchUpRequest) => CatchUp;
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

/**
 * Why the merge of `head` at `sha` may not go on, or null when it may. Checked once the head is pushed, before any
 * credential is read or pull request opened.
 */
export type MergeGate = (head: string, sha: string) => Promise<string | null>;

/** The gate of a ship's own merge: the ship cleared the head and checked its change before it pushed (ship-commits.ts). */
const CLEARED_BY_SHIP: MergeGate = () => Promise.resolve(null);

/**
 * The gate of `ship.ts merge`: the caller's clearance of the first head on the approval `args` names. runMerge calls
 * it again only for a head catch-up.ts made from that cleared head, which carries the same diff with its context
 * lines (a rebase onto main's tip, nothing else), so that head merges on the first one's clearance: the approval
 * names the first sha, and asking again for a sha nobody could approve beforehand would stop every caught-up merge
 * (T2809). A refused first head never reaches a catch-up, since mergeRun returns its refusal as done.
 */
function approvalGate(args: MergeArgs, deps: MergeDeps): MergeGate {
  let cleared: { head: string; sha: string; by: string } | null = null;
  return async (head, sha) => {
    if (cleared !== null) {
      deps.out(`merge of ${head} ${sha.slice(0, 9)}: caught up from ${cleared.head} ${cleared.sha.slice(0, 9)}, ${cleared.by}`);
      return null;
    }
    const clearance = await deps.clearMerge(head, sha, args.approved);
    if (clearance.kind === 'refused') return clearance.reason;
    const by = clearance.kind === 'self' ? "the caller's own, a root team's lead" : `approved by ${clearance.by}`;
    deps.out(`merge of ${head} ${sha.slice(0, 9)}: ${by}`);
    cleared = { head, sha, by };
    return null;
  };
}

/** How many heads a `ship.ts merge` tries in all when main keeps moving past them (T2809). */
export const MERGE_ATTEMPTS = 3;

/**
 * `ship.ts merge` as a command. A merge waits in the queue behind other heavy steps, often past another merge, so a
 * head main moved past is caught up (catch-up.ts: rebased onto main as `<head>-N` when clean with the same diff,
 * pushed) and merged in its place, at most MERGE_ATTEMPTS heads in all; anything else main's move does is refused
 * (T2809). A ship's own merge (mergeBranch) gets the move back instead and goes again from its plan (T2696).
 */
export async function runMerge(args: MergeArgs, deps: MergeDeps): Promise<number> {
  let stem: string | null = null;
  let current = args;
  const gate = approvalGate(args, deps);
  for (let attempt = 1; ; attempt++) {
    const exit = await mergeRun(current, deps, gate);
    if (exit.kind === 'done') return exit.code;
    if (attempt === MERGE_ATTEMPTS) {
      deps.err(`REFUSED ${exit.reason} (main moved past ${MERGE_ATTEMPTS} heads during this merge)`);
      return 1;
    }
    // The checkout has not changed since the run read it.
    const head = current.head ?? checkedOutBranch(deps.git);
    stem ??= head;
    const { main, regenerated } = profileFor(deps.profiles, slugOf(deps.git('remote', 'get-url', 'origin')));
    const caught = deps.catchUp({ head, stem, tip: exit.tip, main, regenerated });
    if (caught.kind === 'refused') {
      deps.err(`REFUSED ${caught.reason}`);
      return 1;
    }
    current = { ...current, head: caught.head };
  }
}

/** The merge itself; prints every outcome but a move of main past the head, which it returns to the caller. */
export async function mergeRun(args: MergeArgs, deps: MergeDeps, gate: MergeGate): Promise<MergeExit> {
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
  const unapproved = await gate(head, sha);
  if (unapproved !== null) {
    deps.err(`REFUSED ${unapproved}`);
    return done(1);
  }
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
      ? ciProof(gh, repo, head, { names: profile.checks, summary: profile.summary, flaky: profile.flaky }, deps.waiter, { timeoutMs: args.timeoutMin * 60_000, intervalMs: args.intervalS * 1000 })
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
    clearMerge: clearMergeFrom(process.env, { env: process.env, userHome: homedir(), files: nodeFiles(realSleep), clock: systemClock }),
    catchUp: request =>
      catchUp(
        {
          git,
          log: out,
          readText: (path) => readFileSync(join(dir, path), 'utf8'),
          writeText: (path, text) => writeFileSync(join(dir, path), text),
          build: () => {
            for (const step of buildSteps(buildScriptOf(readFileSync(join(dir, 'package.json'), 'utf8')))) {
              execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', ...step], { cwd: dir, stdio: 'inherit' });
            }
          },
        },
        request,
      ),
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
  return fromArgv(argv, depsFor, (args, deps) => mergeRun(args, deps, CLEARED_BY_SHIP), done(1));
}
