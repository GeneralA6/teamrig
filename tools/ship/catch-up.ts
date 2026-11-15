import { freeBranch } from './branch-names.ts';
import { pushOwnBranch } from './push.ts';

/**
 * Brings a pushed change branch that main moved past up to main, for `ship.ts merge` (T2809). A merge queued
 * behind other heavy steps runs up to an hour or two later, and on a busy day main moves every few minutes, so a
 * merge that only refused a stale head could not land at all. The head is rebased onto main's tip as a new branch
 * `<stem>-N` (branch-names.ts: a pushed branch is never rewritten) and goes on only when the rebase is clean and the
 * change's own diff is the same, so what merges is what was reviewed and approved; the new branch is pushed and its
 * checks run as any head's. Anything else is refused with the repo dir back on the head as it was.
 *
 * A change that raises the plugin version conflicts with main's own raise: it ships again with its plan
 * (`ship.ts <dir> <plan.json> --merge`), which sets the raise again on main's version (sync.ts).
 */

export interface CatchUpDeps {
  /** Runs git in the repo dir and returns its trimmed stdout; throws when git fails. */
  git: (...args: string[]) => string;
  log: (line: string) => void;
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
}

export type CatchUp = { readonly kind: 'rebased'; readonly head: string; readonly sha: string } | { readonly kind: 'refused'; readonly reason: string };

/** A hunk header's line numbers, which move with any line main added above; the counts and the context stay. */
const HUNK_LINES = /^@@ -\d+(,\d+)? \+\d+(,\d+)? @@/;

/**
 * What `from..to` changes, line for line, without the line numbers and blob ids that differ once the same change
 * sits on a newer main: two equal diffs add and remove the same lines in the same files, among the same lines
 * around them. The context is git's default 3 lines, as the reviewer and the lead saw the change: with none, a main
 * edit right above an added check (`parse(cmd)` becoming `parse(cmd).slice(1)`) left the diff equal while the check
 * now tests another value (the security review's F1).
 */
export function ownDiff(git: CatchUpDeps['git'], from: string, to: string): string {
  return git('diff', '--unified=3', '--no-color', '--no-ext-diff', '--no-renames', from, to)
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

  const own = ownDiff(git, git('merge-base', sha, tip), sha);
  const next = freeBranch(git, stem);
  git('switch', '--quiet', '--create', next);
  const giveUp = (why: string): CatchUp => {
    git('switch', '--quiet', head);
    git('branch', '--quiet', '--delete', '--force', next);
    return refuse(why);
  };
  try {
    git('rebase', '--quiet', tip);
  } catch {
    git('rebase', '--abort');
    return giveUp(
      `rebasing it onto that tip conflicts: rebase it by hand, push it under a new name and merge that (a change that raises the plugin version ships again with its plan, which sets the raise on main's)`,
    );
  }
  const rebased = git('rev-parse', 'HEAD');
  if (ownDiff(git, tip, rebased) !== own) return giveUp('its diff changes when rebased onto that tip: rebase it by hand, check it, push it under a new name and merge that');
  try {
    pushOwnBranch(git, main);
  } catch (error) {
    return giveUp(`pushing it rebased as ${next} failed: ${messageOf(error)}`);
  }
  log(`${past}: rebased it cleanly with the same diff and pushed it as ${next} ${rebased.slice(0, 7)}; merging that`);
  return { kind: 'rebased', head: next, sha: rebased };
}
