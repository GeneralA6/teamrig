import { createHash } from 'node:crypto';
import type { KitReader } from '../../src/cli/kit.ts';
import { RefusedError } from '../../src/cli/runtime.ts';
import { mergeStandingOf, type MergeStanding } from '../../src/cli/ship-approval.ts';
import { ENV, type Env } from '../../src/core/home.ts';
import { approvedTaskOf } from '../../src/register/approval.ts';

/**
 * Whether a merge may go ahead (T2788, security verdict on T2763): refused with why; the caller's own say (a root
 * team's lead, whom nobody approves); or the approval of `by`, one of the caller's leaders, given in the register.
 */
export type MergeClearance =
  | { readonly kind: 'refused'; readonly reason: string }
  | { readonly kind: 'self' }
  | { readonly kind: 'approved'; readonly by: string };

const BRANCH_TASK = /^t(\d+)-/;
const SHA = /^[0-9a-f]{7,40}$/;
const SHA_RUN = /\b[0-9a-f]{7,40}\b/g;

/** The task a branch is cut for, from its `t<id>-` prefix (`t2788-ship-approval` → `T2788`); null for any other name. */
export function taskOfBranch(branch: string): string | null {
  const match = BRANCH_TASK.exec(branch);
  return match === null ? null : `T${match[1]}`;
}

const refused = (reason: string): MergeClearance => ({ kind: 'refused', reason });

/**
 * Whether `standing.caller` may merge `head`, the branch tip of task `taskId`, on the approval it names (`--approved`).
 * In order:
 * - the task must exist and be the caller's own: only the session that made a change merges it (rule 2), the lead too;
 * - a caller nobody approves (a root team's lead) clears itself;
 * - else `approved` must be a sha `head` starts with, the task must hold one of its approvers' approval
 *   (`approvedTaskOf`, as the push guard reads it), and that answer's note must name a sha `head` starts with, so an
 *   approval of an earlier head never clears a later one.
 */
export function mergeClearance(standing: MergeStanding, taskId: string, head: string, approved: string | null): MergeClearance {
  const { caller, task, approvers } = standing;
  if (task === undefined) {
    return refused(`the register holds no task ${taskId}, the branch's task`);
  }
  if (task.owner !== caller) {
    return refused(`${taskId} is ${task.owner}'s: only its owner merges it, not ${caller}`);
  }
  if (approvers.length === 0) {
    return { kind: 'self' };
  }
  if (approved === null) {
    return refused(`name the approved head with --approved <sha>: ${caller}'s merge needs the approval of ${approvers.join(' or ')}`);
  }
  if (!SHA.test(approved) || !head.startsWith(approved)) {
    return refused(`--approved ${approved} is not the branch head ${head}`);
  }
  const answered = approvedTaskOf([task], caller, approvers);
  if (answered === undefined) {
    return refused(`${taskId} (${task.status}) holds no approval of ${approvers.join(' or ')}: set it waiting approval:${approvers[0]} and ask for it naming ${head}`);
  }
  const named = task.answer?.note?.match(SHA_RUN) ?? [];
  if (!named.some((sha) => head.startsWith(sha))) {
    return refused(`${answered.by}'s approval of ${taskId} names no sha of the head ${head}: ask ${answered.by} to approve naming it`);
  }
  return { kind: 'approved', by: answered.by };
}

/** The caller and team a merge runs for, from `$TEAMRIG_SESSION` and `$TEAMRIG_TEAM`. */
export interface MergeCaller {
  readonly session: string | undefined;
  readonly team: string | undefined;
}

/** Reads a merge's standing from the register (`mergeStandingOf`); rejects with `RefusedError` when it cannot. */
export type StandingOf = (team: string, caller: string, taskId: string) => Promise<MergeStanding>;

/**
 * The clearance of a merge of `branch` at `head`: refused when the branch names no task, the caller or team is not
 * set, or the register cannot be read for them (a `RefusedError`, its message kept); else `mergeClearance`.
 */
export async function clearMerge(caller: MergeCaller, standingOf: StandingOf, branch: string, head: string, approved: string | null): Promise<MergeClearance> {
  const taskId = taskOfBranch(branch);
  if (taskId === null) {
    return refused(`branch ${branch} names no task: a merged branch is t<id>-<name>`);
  }
  if (caller.session === undefined || caller.session === '' || caller.team === undefined || caller.team === '') {
    return refused('TEAMRIG_SESSION and TEAMRIG_TEAM must name the merging session and its team');
  }
  let standing: MergeStanding;
  try {
    standing = await standingOf(caller.team, caller.session, taskId);
  } catch (error) {
    if (error instanceof RefusedError) {
      return refused(error.message);
    }
    throw error;
  }
  return mergeClearance(standing, taskId, head, approved);
}

/** The clearance of a merge of `branch` at `head`, on the approved sha the caller names (`--approved`) or null. */
export type ClearMerge = (branch: string, head: string, approved: string | null) => Promise<MergeClearance>;

/**
 * `clearMerge` for the session and team `env` names (`$TEAMRIG_SESSION`, `$TEAMRIG_TEAM`), reading the register
 * through `reader`. The env is the caller's own claim, so this stops a mistaken or stale merge, not a session that
 * lies about who it is: the guard stays the trust boundary.
 */
export function clearMergeFrom(env: Env, reader: KitReader): ClearMerge {
  const caller = { session: env[ENV.session]?.trim(), team: env[ENV.team]?.trim() };
  const standingOf: StandingOf = (team, session, taskId) => mergeStandingOf(reader, team, session, taskId);
  return (branch, head, approved) => clearMerge(caller, standingOf, branch, head, approved);
}

/** Runs git in the repo and returns its stdout; throws when git fails. */
export type GitText = (args: readonly string[]) => string;

/**
 * The fingerprint of what `rev` changes over `mainRef`, the paths in `regenerated` apart (a folder ends in `/`): the
 * sha256 of its zero-context diff from their merge base, with blob ids and hunk positions dropped, so a rebase over
 * other lines keeps it and any change to the branch's own lines moves it. A merge checks the branch it pushes against
 * the fingerprint of the head its approver named.
 */
export function changePatch(git: GitText, rev: string, mainRef: string, regenerated: readonly string[]): string {
  const from = git(['merge-base', rev, mainRef]).trim();
  return diffHash(git(['diff', '--unified=0', '--no-renames', '--no-color', '--no-ext-diff', from, rev, '--', '.', ...excludedOf(regenerated)]));
}

const excludedOf = (regenerated: readonly string[]): string[] => regenerated.map((path) => `:(exclude)${path}`);

/** The sha256 of a diff with its blob ids and hunk positions dropped, so moving the lines it changes keeps it. */
function diffHash(diff: string): string {
  const normalized = diff
    .split('\n')
    .filter((line) => !line.startsWith('index '))
    .map((line) => (line.startsWith('@@') ? '@@' : line))
    .join('\n');
  return createHash('sha256').update(normalized).digest('hex');
}

/** One commit a branch carries over main. */
export interface WorkCommit {
  readonly sha: string;
  readonly subject: string;
  /** A merge commit, whose own changes no patch shows. */
  readonly merge: boolean;
  /**
   * The commit's patch id, like `git patch-id` (what `git range-diff` marks `=`): the hash of its diff with 3 lines of
   * context, blob ids and hunk positions dropped, so a rebase over other lines keeps it; whitespace counts, unlike in
   * git's, so a whitespace edit moves it too. Empty for a merge commit.
   */
  readonly patch: string;
}

/**
 * The work commits `rev` carries over `mainRef`, oldest first: every commit not on main that changes a path outside
 * `regenerated` (a folder ends in `/`), with its patch id over those paths, and every merge commit. A commit that
 * changes only regenerated paths (the version raise, the dist) is no work commit: a ship sets those again each run.
 */
export function workCommitsOf(git: GitText, rev: string, mainRef: string, regenerated: readonly string[]): WorkCommit[] {
  const rows = git(['rev-list', '--reverse', '--parents', rev, `^${mainRef}`]).split('\n').filter((row) => row.trim() !== '');
  return rows.flatMap((row): WorkCommit[] => {
    const [sha = '', ...parents] = row.trim().split(' ');
    const subject = (): string => git(['log', '-1', '--format=%s', sha]).trim();
    if (parents.length > 1) return [{ sha, subject: subject(), merge: true, patch: '' }];
    const diff = git(['diff-tree', '-p', '-r', '--root', '--no-commit-id', '--unified=3', '--no-renames', '--no-color', '--no-ext-diff', sha, '--', '.', ...excludedOf(regenerated)]);
    return diff.trim() === '' ? [] : [{ sha, subject: subject(), merge: false, patch: diffHash(diff) }];
  });
}

const named = (commit: WorkCommit): string => `${commit.sha.slice(0, 9)} "${commit.subject}"`;

/**
 * How `head`'s work commits differ from `approved`'s, each change named (changed, dropped, added, reordered); empty
 * when they are the same patches in the same order, all a rebase leaves that `git range-diff` marks `=` throughout.
 * A merge commit on either side always differs: its own changes have no patch to compare.
 */
export function workChanges(approved: readonly WorkCommit[], head: readonly WorkCommit[]): string[] {
  const merges = [...approved, ...head].filter((commit) => commit.merge).map((commit) => `merge commit ${named(commit)}: rebase it away`);
  const unmatched = head.filter((commit) => !commit.merge);
  const missing: WorkCommit[] = [];
  for (const commit of approved.filter((one) => !one.merge)) {
    const at = unmatched.findIndex((other) => other.patch === commit.patch);
    if (at === -1) missing.push(commit);
    else unmatched.splice(at, 1);
  }
  const changes = [...merges];
  for (const commit of missing) {
    const at = unmatched.findIndex((other) => other.subject === commit.subject);
    if (at === -1) {
      changes.push(`dropped ${named(commit)}`);
    } else {
      changes.push(`changed ${named(commit)}, now ${unmatched[at]?.sha.slice(0, 9) ?? ''}`);
      unmatched.splice(at, 1);
    }
  }
  changes.push(...unmatched.map((commit) => `added ${named(commit)}`));
  if (changes.length === 0 && approved.some((commit, i) => commit.patch !== head[i]?.patch)) {
    changes.push(`reordered, now ${head.map((commit) => commit.sha.slice(0, 9)).join(', ')}`);
  }
  return changes;
}
