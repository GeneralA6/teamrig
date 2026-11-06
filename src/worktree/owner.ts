import type { LeadTree } from '../config/lead-tree.ts';

/**
 * Who may remove a team's worktree (T1319): the session that owns the task its branch is named for (`t12-parser` is
 * T12's), and that session's leaders up to the lead; the lead may remove any. A worktree on a branch named for no task,
 * or for one the register lacks, is the lead's alone to remove.
 *
 * A worktree on a detached HEAD names no task. When the default branch holds every commit of that HEAD, as `teamrig
 * merge` leaves the worktree it merged from (it detaches, then deletes the branch: T1856), the clean worktree holds
 * nothing to lose, so any session may remove it. A rebase stopped before its first new commit looks the same; removing
 * it ends that rebase, but its branch keeps every commit. Any other detached HEAD is the lead's alone to remove.
 */

/** The task a branch is named for: `T12` for `t12-parser` or `T12`; undefined for a branch named for none. */
export function branchTaskOf(branch: string | undefined): string | undefined {
  const digits = branch === undefined ? undefined : /^t(\d+)(?:-|$)/i.exec(branch)?.[1];
  return digits === undefined ? undefined : `T${digits}`;
}

/** Who asks to remove a worktree on `branch`, and what tells whose it is. */
export interface WorktreeRemover {
  readonly caller: string;
  /** The branch checked out in the worktree; undefined on a detached HEAD. */
  readonly branch: string | undefined;
  /** On a detached HEAD, the default branch that holds every commit of it (as of the last fetch); else undefined. */
  readonly mergedInto: string | undefined;
  /** The session that owns a task; undefined for a task the register lacks. */
  readonly ownerOf: (task: string) => string | undefined;
  readonly tree: LeadTree;
}

/** Undefined when the caller may remove the worktree; else why not, naming who may. */
export function removalRefusal({ caller, branch, mergedInto, ownerOf, tree }: WorktreeRemover): string | undefined {
  if (caller === tree.lead || (branch === undefined && mergedInto !== undefined)) {
    return undefined;
  }
  const task = branchTaskOf(branch);
  const owner = task === undefined ? undefined : ownerOf(task);
  if (owner === caller || (owner !== undefined && tree.leads(caller, owner))) {
    return undefined;
  }
  const leadAlone = `so only the lead (${tree.lead}) removes it`;
  if (branch === undefined) {
    return `the worktree is on no branch, and git does not show every commit of its HEAD on the default branch (as of the last fetch), ${leadAlone}: if it merged, fetch and run this again`;
  }
  if (task === undefined || owner === undefined) {
    const named = task === undefined ? 'names no task (t<id>-<name>)' : `names ${task}, which the register lacks`;
    return `the worktree's branch ${branch} ${named}, ${leadAlone}`;
  }
  const may = [owner, ...tree.chainOf(owner)];
  if (!may.includes(tree.lead)) {
    may.push(tree.lead);
  }
  return `the worktree's branch ${branch} is ${task}'s, which ${owner} owns: only ${may.join(' or ')} removes it`;
}
