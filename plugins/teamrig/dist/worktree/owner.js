/**
 * Who may remove a team's worktree (T1319): the session that owns the task its branch is named for (`t12-parser` is
 * T12's), and that session's leaders up to the lead; the lead may remove any. A worktree on a branch named for no task,
 * or for one the register lacks, is the lead's alone to remove.
 */
/** The task a branch is named for: `T12` for `t12-parser` or `T12`; undefined for a branch named for none. */
export function branchTaskOf(branch) {
    const digits = branch === undefined ? undefined : /^t(\d+)(?:-|$)/i.exec(branch)?.[1];
    return digits === undefined ? undefined : `T${digits}`;
}
/** Undefined when the caller may remove the worktree; else why not, naming who may. */
export function removalRefusal({ caller, branch, ownerOf, tree }) {
    if (caller === tree.lead) {
        return undefined;
    }
    const task = branchTaskOf(branch);
    const owner = task === undefined ? undefined : ownerOf(task);
    if (owner === caller || (owner !== undefined && tree.leads(caller, owner))) {
        return undefined;
    }
    const leadAlone = `so only the lead (${tree.lead}) removes it`;
    if (branch === undefined) {
        return `the worktree is on no branch, ${leadAlone}`;
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
