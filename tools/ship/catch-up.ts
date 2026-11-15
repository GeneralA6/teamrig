import { freeBranch } from './branch-names.ts';
import { pushOwnBranch } from './push.ts';
import { type Regeneration, type ReplayPlan, planReplay, regenerate, regenerationFor, workPathspec } from './regenerate.ts';

/**
 * Brings a pushed change branch that main moved past up to main, for `ship.ts merge` (T2809). A merge queued
 * behind other heavy steps runs up to an hour or two later, and on a busy day main moves every few minutes, so a
 * merge that only refused a stale head could not land at all. The head is rebased onto main's tip as a new branch
 * `<stem>-N` (branch-names.ts: a pushed branch is never rewritten) and goes on only when the rebase is clean and the
 * change's own diff is the same, so what merges is what was reviewed and approved; the new branch is pushed and its
 * checks run as any head's. Anything else is refused with the repo dir back on the head as it was.
 *
 * In a repo whose profile calls teamrig's version files and dist regenerated, the change's commits of only those are
 * dropped instead, its work commits are replayed on main's tip, and the raise and the dist are made again on main
 * (regenerate.ts, T2988): every merge raises the version, so a rebase of a raise always conflicts. Its work diff is
 * held equal the same way. Elsewhere a change that raises the version conflicts with main's own raise: it ships
 * again with its plan (`ship.ts <dir> <plan.json> --merge`), which sets the raise again on main's version (sync.ts).
 */

export interface CatchUpDeps {
  /** Runs git in the repo dir and returns its trimmed stdout; throws when git fails. */
  git: (...args: string[]) => string;
  log: (line: string) => void;
  /** Writes a file of the repo dir, by its path in the repo (regenerate.ts). */
  writeText: (path: string, text: string) => void;
  /** Reads a file of the repo dir as it is on disk, by its path in the repo (regenerate.ts). */
  readText: (path: string) => string;
  /** Runs the repo's `npm run build` steps in the repo dir; throws when one fails (regenerate.ts). */
  build: () => void;
}

export interface CatchUpRequest {
  /** The branch main moved past, which should be checked out in the repo dir. */
  readonly head: string;
  /** The name new branches are numbered from: the head the merge began with. */
  readonly stem: string;
  /** main's tip on origin, which the head does not contain. */
  readonly tip: string;
  /** The branch merged into. */
  readonly main: string;
  /** The paths the repo's profile calls regenerated (repos.json), which regenerationFor reads. */
  readonly regenerated: readonly string[];
}

export type CatchUp = { readonly kind: 'rebased'; readonly head: string; readonly sha: string } | { readonly kind: 'refused'; readonly reason: string };

/** A hunk header's line numbers, which move with any line main added above; the counts and the context stay. */
const HUNK_LINES = /^@@ -\d+(,\d+)? \+\d+(,\d+)? @@/;

/**
 * What `from..to` changes, line for line, without the line numbers and blob ids that differ once the same change
 * sits on a newer main: two equal diffs add and remove the same lines in the same files, among the same lines
 * around them. The context is git's default 3 lines, as the reviewer and the lead saw the change: with none, a main
 * edit right above an added check (`parse(cmd)` becoming `parse(cmd).slice(1)`) left the diff equal while the check
 * now tests another value (the security review's F1). `pathspec`, when given, limits it to those paths.
 */
export function ownDiff(git: CatchUpDeps['git'], from: string, to: string, pathspec: readonly string[] = []): string {
  return git('diff', '--unified=3', '--no-color', '--no-ext-diff', '--no-renames', from, to, ...(pathspec.length > 0 ? ['--', ...pathspec] : []))
    .split('\n')
    .filter((line) => !line.startsWith('index '))
    .map((line) => line.replace(HUNK_LINES, (_header, old: string | undefined, now: string | undefined) => `@@ -${old ?? ''} +${now ?? ''} @@`))
    .join('\n');
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export function catchUp(deps: CatchUpDeps, request: CatchUpRequest): CatchUp {
  const { git, log } = deps;
  const { head, stem, tip, main } = request;
  const sha = git('rev-parse', `refs/heads/${head}`);
  const past = `${main} moved to ${tip.slice(0, 7)}, which ${head} ${sha.slice(0, 7)} does not contain`;
  const refuse = (why: string): CatchUp => ({ kind: 'refused', reason: `${past}, and ${why}` });
  if (git('rev-parse', '--abbrev-ref', 'HEAD') !== head) {
    return refuse(`it is not checked out in the repo dir to be rebased there: rebase it onto origin/${main}, push it under a new name and merge that`);
  }
  if (git('status', '--porcelain') !== '') return refuse('the repo dir has uncommitted changes: commit them or set them aside, then merge again');

  const base = git('merge-base', sha, tip);
  const regeneration = regenerationFor(request.regenerated);
  const plan = regeneration === null ? null : planReplay(git, regeneration, base, sha, tip);
  if (typeof plan === 'string') return refuse(`${plan}: ${WITH_PLAN}`);
  const next = freeBranch(git, stem);
  const caught = regeneration === null || plan === null ? rebase(deps, request, base, sha, next) : replay(deps, regeneration, plan, { head, base, sha, tip, next });
  if (caught.kind === 'refused') return refuse(caught.why);
  const rebased = git('rev-parse', 'HEAD');
  try {
    pushOwnBranch(git, main);
  } catch (error) {
    caught.undo();
    return refuse(`pushing it ${caught.done === null ? 'rebased' : 'caught up'} as ${next} failed: ${messageOf(error)}`);
  }
  log(`${past}: ${caught.done === null ? 'rebased it cleanly with the same diff' : `replayed its work with the same diff, ${caught.done},`} and pushed it as ${next} ${rebased.slice(0, 7)}; merging that`);
  return { kind: 'rebased', head: next, sha: rebased };
}

const WITH_PLAN = "ship it again with its plan (ship.ts <dir> <plan.json> --merge), which sets the raise on main's version";

/** The head brought onto the tip as `next` (checked out), what was made again on it (null: a plain rebase), and how to drop it; or why not. */
type Caught = { readonly kind: 'caught'; readonly done: string | null; readonly undo: () => void } | { readonly kind: 'refused'; readonly why: string };

/** The whole head rebased onto the tip, as before regeneration (a repo with no version files and dist to make again). */
function rebase(deps: CatchUpDeps, request: CatchUpRequest, base: string, sha: string, next: string): Caught {
  const { git } = deps;
  const own = ownDiff(git, base, sha);
  git('switch', '--quiet', '--create', next);
  const undo = (): void => {
    git('switch', '--quiet', request.head);
    git('branch', '--quiet', '--delete', '--force', next);
  };
  const giveUp = (why: string): Caught => {
    undo();
    return { kind: 'refused', why };
  };
  try {
    git('rebase', '--quiet', request.tip);
  } catch {
    git('rebase', '--abort');
    return giveUp(
      `rebasing it onto that tip conflicts: rebase it by hand, push it under a new name and merge that (a change that raises the plugin version ships again with its plan, which sets the raise on main's)`,
    );
  }
  if (ownDiff(git, request.tip, git('rev-parse', 'HEAD')) !== own) return giveUp('its diff changes when rebased onto that tip: rebase it by hand, check it, push it under a new name and merge that');
  return { kind: 'caught', done: null, undo };
}

interface Replay {
  readonly head: string;
  readonly base: string;
  readonly sha: string;
  readonly tip: string;
  readonly next: string;
}

/** The head's work commits replayed on the tip as `next`, then its raise and dist made again there (regenerate.ts). */
function replay(deps: CatchUpDeps, regeneration: Regeneration, plan: ReplayPlan, at: Replay): Caught {
  const { git } = deps;
  const pathspec = workPathspec(regeneration);
  const own = ownDiff(git, at.base, at.sha, pathspec);
  git('switch', '--quiet', '--create', at.next, at.tip);
  // A failed build may leave new files in the dist, which are this branch's own until it is dropped.
  const undo = (): void => {
    git('clean', '-fdq', '--', regeneration.dist);
    git('switch', '--quiet', '--discard-changes', at.head);
    git('branch', '--quiet', '--delete', '--force', at.next);
  };
  const giveUp = (why: string): Caught => {
    undo();
    return { kind: 'refused', why };
  };
  for (const commit of plan.work) {
    try {
      git('cherry-pick', '--allow-empty', commit);
    } catch {
      git('cherry-pick', '--abort');
      return giveUp(`replaying its commit ${commit.slice(0, 9)} onto that tip conflicts: rebase it by hand, ${WITH_PLAN}`);
    }
  }
  if (ownDiff(git, at.tip, git('rev-parse', 'HEAD'), pathspec) !== own) return giveUp(`its work diff changes when replayed onto that tip: rebase it by hand, check it, ${WITH_PLAN}`);
  try {
    return { kind: 'caught', done: regenerate(deps, regeneration, plan, at.tip), undo };
  } catch (error) {
    return giveUp(`making its version raise or dist again on that tip failed: ${messageOf(error)}`);
  }
}
