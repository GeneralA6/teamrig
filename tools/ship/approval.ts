import { createHash } from 'node:crypto';
import type { KitReader } from '../../src/cli/kit.ts';
import { RefusedError } from '../../src/cli/runtime.ts';
import { mergeStandingOf, tabCallerOf, type MergeStanding } from '../../src/cli/ship-approval.ts';
import { ENV, type Env } from '../../src/core/home.ts';
import { approvedTaskOf } from '../../src/register/approval.ts';
import type { VersionFile } from './version-bump.ts';

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

/** The caller and team a merge runs for, from `$TEAMRIG_SESSION` and `$TEAMRIG_TEAM`, and its tab, from `$CLAUDE_CODE_SESSION_ID`. */
export interface MergeCaller {
  readonly session: string | undefined;
  readonly team: string | undefined;
  readonly claudeSession: string | undefined;
}

/** Reads a merge's standing from the register (`mergeStandingOf`); rejects with `RefusedError` when it cannot. */
export type StandingOf = (team: string, caller: string, taskId: string) => Promise<MergeStanding>;

/** The session the merging tab is bound to, which must be the one the caller names (`tabCallerOf`); rejects with `RefusedError` otherwise. */
export type TabCallerOf = (team: string, claudeSession: string, caller: string) => Promise<string>;

/** What a merge's clearance reads: the tab's session, then that session's standing. */
export interface MergeReads {
  readonly tabCallerOf: TabCallerOf;
  readonly standingOf: StandingOf;
}

/**
 * The clearance of a merge of `branch` at `head`: refused when the branch names no task, the caller, team or tab is
 * not set, the tab is not bound to the caller alone (T2984, security condition C4), or the register cannot be read for
 * them (a `RefusedError`, its message kept); else `mergeClearance`.
 */
export async function clearMerge(caller: MergeCaller, reads: MergeReads, branch: string, head: string, approved: string | null): Promise<MergeClearance> {
  const taskId = taskOfBranch(branch);
  if (taskId === null) {
    return refused(`branch ${branch} names no task: a merged branch is t<id>-<name>`);
  }
  if (caller.session === undefined || caller.session === '' || caller.team === undefined || caller.team === '') {
    return refused('TEAMRIG_SESSION and TEAMRIG_TEAM must name the merging session and its team');
  }
  if (caller.claudeSession === undefined || caller.claudeSession === '') {
    return refused("CLAUDE_CODE_SESSION_ID must name the merging Claude Code tab: a merge runs from the merging session's own tab");
  }
  let standing: MergeStanding;
  try {
    const session = await reads.tabCallerOf(caller.team, caller.claudeSession, caller.session);
    standing = await reads.standingOf(caller.team, session, taskId);
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
 * `clearMerge` for the session, team and tab `env` names (`$TEAMRIG_SESSION`, `$TEAMRIG_TEAM`,
 * `$CLAUDE_CODE_SESSION_ID`), reading the inbox marks and the register through `reader`. The session must be the one
 * the tab is bound to, so a typed name merges no other session's task; the marks are files of the shared account
 * (stopgap T791), so the guards stay the trust boundary.
 */
export function clearMergeFrom(env: Env, reader: KitReader): ClearMerge {
  const caller = { session: env[ENV.session]?.trim(), team: env[ENV.team]?.trim(), claudeSession: env[ENV.claudeSession]?.trim() };
  const reads: MergeReads = {
    tabCallerOf: (team, claudeSession, session) => tabCallerOf(reader, team, claudeSession, session),
    standingOf: (team, session, taskId) => mergeStandingOf(reader, team, session, taskId),
  };
  return (branch, head, approved) => clearMerge(caller, reads, branch, head, approved);
}

/** Runs git in the repo and returns its stdout; throws when git fails. */
export type GitText = (args: readonly string[]) => string;

/**
 * The paths a ship writes again on every run, split by how an approval hashes them (security verdict T2914, F1):
 * - `generated`: folders the build empties and rebuilds (each ends in `/`), left out of every hash, since no
 *   committed edit in them survives to the push;
 * - `versionFiles`: files of which the ship rewrites only the version token, hashed with that token masked, so a
 *   version raise drops out while any other edit (code in version.ts, a hooks key in plugin.json) counts as work.
 */
export interface ShipWrites {
  readonly generated: readonly string[];
  readonly versionFiles: readonly VersionFile[];
}

/**
 * Splits a repo profile's regenerated paths (repos.json) into `ShipWrites`, a file by the version files the ship
 * knows (`known`). Throws on a file that is neither a folder nor a known version file: leaving it out of the hash
 * would let any edit to it ship on an earlier approval.
 */
export function shipWritesOf(regenerated: readonly string[], known: readonly VersionFile[]): ShipWrites {
  const generated: string[] = [];
  const versionFiles: VersionFile[] = [];
  for (const path of regenerated) {
    const file = known.find((one) => one.path === path);
    if (file !== undefined) versionFiles.push(file);
    else if (path.endsWith('/')) generated.push(path);
    else throw new Error(`regenerated path ${path} is no folder the build rebuilds and no version file the ship rewrites: an approval cannot skip it`);
  }
  return { generated, versionFiles };
}

/**
 * The options every hashed diff runs with: no rename pairing, colour or external diff, and every path diffed as text
 * with no textconv (security verdict T2914, F2), so a binary path, or one a .gitattributes line marks -diff, is hashed
 * by its content, never by a "Binary files differ" line that any swap keeps.
 */
const DIFF_OPTIONS = ['--no-renames', '--no-color', '--no-ext-diff', '--text', '--no-textconv'] as const;

/**
 * The fingerprint of what `rev` changes over `mainRef`, read as `writes` says: the sha256 of its zero-context diff
 * from their merge base, with blob ids, hunk positions and version tokens dropped, so a rebase over other lines keeps
 * it and any change to the branch's own lines moves it. A merge checks the branch it pushes against the fingerprint
 * of the head its approver named.
 */
export function changePatch(git: GitText, rev: string, mainRef: string, writes: ShipWrites): string {
  const from = git(['merge-base', rev, mainRef]).trim();
  return diffHash(git(['diff', '--unified=0', ...DIFF_OPTIONS, from, rev, '--', '.', ...excludedOf(writes.generated)]), writes.versionFiles);
}

const excludedOf = (generated: readonly string[]): string[] => generated.map((path) => `:(exclude)${path}`);

/** A diff's sections, each version file's masked (`maskedSection`); a version-only change leaves no line. */
function normalizedOf(diff: string, versionFiles: readonly VersionFile[]): string[] {
  return sectionsOf(diff.split('\n')).flatMap((section) => {
    const file = versionFiles.find((one) => section[0] === `diff --git a/${one.path} b/${one.path}`);
    return file === undefined ? section : maskedSection(section, file);
  });
}

/**
 * The sha256 of a diff with its blob ids and hunk positions dropped, so moving the lines it changes keeps it, and
 * each version file's version token masked.
 */
function diffHash(diff: string, versionFiles: readonly VersionFile[]): string {
  const normalized = normalizedOf(diff, versionFiles)
    .filter((line) => !line.startsWith('index '))
    .map((line) => (line.startsWith('@@') ? '@@' : line))
    .join('\n');
  return createHash('sha256').update(normalized).digest('hex');
}

/** A diff's lines cut into one list per file, each starting at its `diff --git` line. */
function sectionsOf(lines: readonly string[]): string[][] {
  const sections: string[][] = [];
  for (const line of lines) {
    const last = sections.at(-1);
    if (line.startsWith('diff --git ') || last === undefined) sections.push([line]);
    else last.push(line);
  }
  return sections;
}

/**
 * A version file's diff section with its version token masked on every line, less each hunk that changes nothing but
 * that token (its removed and added lines equal once masked); no line at all when no hunk is left, as for a commit
 * that only raises the version.
 */
function maskedSection(section: readonly string[], file: VersionFile): string[] {
  const token = new RegExp(file.pattern.source, `${file.pattern.flags.replace('g', '')}g`);
  const masked = section.map((line) => line.replace(token, (_match, before: string, _version: string, after: string) => `${before}<version>${after}`));
  const first = masked.findIndex((line) => line.startsWith('@@'));
  if (first === -1) return masked;
  const hunks: string[][] = [];
  for (const line of masked.slice(first)) {
    const last = hunks.at(-1);
    if (line.startsWith('@@') || last === undefined) hunks.push([line]);
    else last.push(line);
  }
  const kept = hunks.filter((hunk) => !changesNothing(hunk));
  return kept.length === 0 ? [] : [...masked.slice(0, first), ...kept.flat()];
}

/** Whether a hunk's removed lines are its added lines, in order. */
function changesNothing(hunk: readonly string[]): boolean {
  const side = (mark: string): string[] => hunk.slice(1).filter((line) => line.startsWith(mark)).map((line) => line.slice(1));
  const removed = side('-');
  const added = side('+');
  return removed.length === added.length && removed.every((line, i) => line === added[i]);
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
 * The work commits `rev` carries over `mainRef`, oldest first: every commit not on main whose diff, read as `writes`
 * says, changes anything, with its patch id, and every merge commit. A commit that only rebuilds a generated folder or
 * raises the version is no work commit: a ship sets those again each run.
 */
export function workCommitsOf(git: GitText, rev: string, mainRef: string, writes: ShipWrites): WorkCommit[] {
  const rows = git(['rev-list', '--reverse', '--parents', rev, `^${mainRef}`]).split('\n').filter((row) => row.trim() !== '');
  return rows.flatMap((row): WorkCommit[] => {
    const [sha = '', ...parents] = row.trim().split(' ');
    const subject = (): string => git(['log', '-1', '--format=%s', sha]).trim();
    if (parents.length > 1) return [{ sha, subject: subject(), merge: true, patch: '' }];
    const diff = git(['diff-tree', '-p', '-r', '--root', '--no-commit-id', '--unified=3', ...DIFF_OPTIONS, sha, '--', '.', ...excludedOf(writes.generated)]);
    const changes = normalizedOf(diff, writes.versionFiles).some((line) => line.trim() !== '');
    return changes ? [{ sha, subject: subject(), merge: false, patch: diffHash(diff, writes.versionFiles) }] : [];
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
