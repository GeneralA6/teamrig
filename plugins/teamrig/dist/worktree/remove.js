import { join, relative, sep } from 'node:path';
/**
 * `teamrig worktree remove`: drop a linked git worktree without touching what its links point to. On Windows,
 * `git worktree remove` follows a directory junction (such as a `node_modules` linked in from the main checkout)
 * and deletes what is inside it, which empties the main checkout's copy. So every link in the worktree goes first,
 * by unlink, which removes the link alone, and is confirmed gone before git runs.
 *
 * Every check runs before anything changes, and any doubt refuses: a path that is not a worktree's top folder, the
 * main checkout, a locked worktree, a run from inside it, a real `node_modules` folder where a link was expected,
 * files git tracks under a link, uncommitted changes, and, for `--delete-branch`, a branch with a commit whose
 * change is not on its base.
 */
const MODULES = 'node_modules';
/** How many changed paths a refusal names before it says how many more. */
const NAMED_CHANGES = 5;
function refused(reason) {
    return { kind: 'refused', reason };
}
/** A path under `top` as git names it: relative and `/`-separated. */
function gitName(top, path) {
    return relative(top, path).split(sep).join('/');
}
/** Whether `inner` is `outer` or a path inside it; both canonical. */
function within(inner, outer) {
    return inner === outer || inner.startsWith(outer.endsWith(sep) ? outer : `${outer}${sep}`);
}
/** Every link in the worktree and every real `node_modules` folder, walking real folders only and skipping `.git`. */
async function scanTree(files, top) {
    const links = [];
    const moduleFolders = [];
    const folders = [top];
    for (let folder = folders.pop(); folder !== undefined; folder = folders.pop()) {
        for (const entry of await files.entries(folder)) {
            const path = join(folder, entry.name);
            if (entry.name === '.git') {
                continue;
            }
            if (entry.kind === 'link') {
                links.push(path);
            }
            else if (entry.kind === 'folder') {
                (entry.name === MODULES ? moduleFolders : folders).push(path);
            }
        }
    }
    return { links: links.sort(), moduleFolders: moduleFolders.sort() };
}
/** The worktree git lists at the folder `canonicalTop`, compared by canonical spelling. */
async function entryAt(files, entries, canonicalTop) {
    for (const entry of entries) {
        if ((await files.canonical(entry.path)) === canonicalTop) {
            return entry;
        }
    }
    return undefined;
}
function describeChanges(changes) {
    const named = changes.slice(0, NAMED_CHANGES).join(', ');
    return changes.length > NAMED_CHANGES ? `${named} and ${changes.length - NAMED_CHANGES} more` : named;
}
/** The branch step: which branch goes and the base that holds every commit of it, or why it may not go. */
function planBranch(git, request, top, branch) {
    if (branch === undefined) {
        return `${top} has no branch checked out (a detached HEAD): run without --delete-branch`;
    }
    const base = request.base ?? git.defaultBase(top);
    if (base === undefined) {
        return 'origin/HEAD names no branch: give the branch it merged into with --base <ref>';
    }
    if (base.startsWith('-')) {
        return `--base ${base} reads as an option to git: give a branch or ref name`;
    }
    if (base === branch || base.endsWith(`/${branch}`)) {
        return `${branch} is the branch it merges into (${base}): it is kept`;
    }
    const notOn = git.commitsNotOn(top, branch, base);
    if (notOn === undefined) {
        return `git cannot compare ${branch} with ${base}: check that both exist`;
    }
    if (notOn > 0) {
        return `${branch} has ${notOn} commit(s) whose change is not on ${base} (as of the last fetch): merge it, or run without --delete-branch to keep the branch`;
    }
    return { name: branch, base };
}
/** Every check, before anything changes: the plan to carry out, or the reason to refuse. */
export async function planRemoval(request, ports) {
    const { git, files } = ports;
    const { path } = request;
    const kind = await files.kindOf(path);
    if (kind !== 'folder') {
        return refused(kind === 'missing' ? `no folder at ${path}` : `${path} is a ${kind === 'link' ? 'link' : 'file'}, not a worktree folder`);
    }
    const top = git.topOf(path);
    const canonicalPath = await files.canonical(path);
    const canonicalTop = top === undefined ? undefined : await files.canonical(top);
    if (top === undefined || canonicalTop === undefined || canonicalPath === undefined) {
        return refused(`${path} is not in a git worktree`);
    }
    if (canonicalPath !== canonicalTop) {
        return refused(`${path} is inside the worktree ${top}: give its top folder`);
    }
    const worktrees = git.worktrees(top);
    const [main] = worktrees ?? [];
    if (worktrees === undefined || main === undefined) {
        return refused(`git cannot list the worktrees of ${top}`);
    }
    const mine = await entryAt(files, worktrees, canonicalTop);
    if (mine === main) {
        return refused(`${top} is the main checkout: only a linked worktree is removed`);
    }
    if (mine === undefined) {
        return refused(`git does not list ${top} as a worktree of its repository`);
    }
    if (mine.locked !== undefined) {
        return refused(`${top} is locked${mine.locked === '' ? '' : ` (${mine.locked})`}: unlock it with git worktree unlock first`);
    }
    const canonicalCwd = await files.canonical(request.cwd);
    if (canonicalCwd !== undefined && within(canonicalCwd, canonicalTop)) {
        return refused(`this runs inside ${top}, which a running program keeps from being deleted: run it from another folder`);
    }
    const scan = await scanTree(files, top);
    const linkNames = scan.links.map((link) => gitName(top, link));
    const moduleNames = scan.moduleFolders.map((folder) => gitName(top, folder));
    const tracked = git.tracked(top, [...linkNames, ...moduleNames]);
    if (tracked === undefined) {
        return refused(`git cannot list the files it tracks in ${top}`);
    }
    const holdsTracked = (name) => tracked.some((file) => file.startsWith(`${name}/`));
    const realModules = moduleNames.find((name) => !holdsTracked(name));
    if (realModules !== undefined) {
        return refused(`${realModules} in ${top} is a real folder, not a link: removing the worktree would delete it. ` +
            'Check it holds only this worktree\'s own packages, delete it yourself, then run this again');
    }
    const holding = linkNames.find(holdsTracked);
    if (holding !== undefined) {
        return refused(`${holding} in ${top} is a link, but git tracks files under it: remove the worktree by hand`);
    }
    // A link git tracks is one git made, and git removes its own links without following them.
    const untracked = scan.links.filter((_, index) => !tracked.includes(linkNames[index] ?? ''));
    const untrackedNames = untracked.map((link) => gitName(top, link));
    const changes = git.changes(top, untrackedNames);
    if (changes === undefined) {
        return refused(`git cannot read the status of ${top}`);
    }
    if (changes.length > 0) {
        return refused(`${top} has uncommitted changes or untracked files (${describeChanges(changes)}): commit or remove them first`);
    }
    let branch;
    if (request.deleteBranch) {
        const planned = planBranch(git, request, top, mine.branch);
        if (typeof planned === 'string') {
            return refused(planned);
        }
        branch = planned;
    }
    const links = [];
    for (const [index, link] of untracked.entries()) {
        const target = await files.linkTarget(link);
        links.push({ path: link, name: untrackedNames[index] ?? link, target, targetEntries: await files.entryCount(target) });
    }
    return { kind: 'ready', plan: { top, mainDir: main.path, links, branch } };
}
function entriesText(count) {
    return count === undefined ? 'missing' : `${count} ${count === 1 ? 'entry' : 'entries'}`;
}
/** What a dry run would do, one line per step. */
export function describePlan(plan) {
    return [
        ...plan.links.map((link) => `would unlink ${link.name} (the link only; its target ${link.target} holds ${entriesText(link.targetEntries)})`),
        `would remove the worktree ${plan.top}`,
        ...(plan.branch === undefined ? [] : [`would delete branch ${plan.branch.name}: every commit of it is on ${plan.branch.base}`]),
    ];
}
/**
 * Carries out a plan, telling each step as it is done. A link still there after its unlink stops it before git
 * runs; a target that changed after the removal, or a git step that fails, is thrown with what was already done.
 */
export async function carryOut(plan, ports, tell) {
    const { git, files } = ports;
    for (const link of plan.links) {
        await files.unlinkLink(link.path);
        const left = await files.kindOf(link.path);
        if (left !== 'missing') {
            throw new Error(`${link.name} is still in ${plan.top} after its unlink, so git was not run; nothing else changed`);
        }
        tell(`unlinked ${link.name} (the link only, to ${link.target})`);
    }
    const removed = git.removeWorktree(plan.mainDir, plan.top);
    if (!removed.ok) {
        const unlinked = plan.links.length === 0 ? '' : ` (its links are already gone: ${plan.links.map((link) => link.name).join(', ')})`;
        throw new Error(`git worktree remove ${plan.top}: ${removed.reason}${unlinked}`);
    }
    tell(`removed the worktree ${plan.top}`);
    for (const link of plan.links) {
        const after = await files.entryCount(link.target);
        if (after !== link.targetEntries) {
            throw new Error(`${link.target}, the target of ${link.name}, held ${entriesText(link.targetEntries)} before and ${entriesText(after)} after the removal`);
        }
        tell(`target ${link.target} untouched: ${entriesText(after)}, as before`);
    }
    if (plan.branch !== undefined) {
        const deleted = git.deleteBranch(plan.mainDir, plan.branch.name);
        if (!deleted.ok) {
            throw new Error(`the worktree is removed, but git branch -D ${plan.branch.name}: ${deleted.reason}`);
        }
        tell(`deleted branch ${plan.branch.name}: every commit of it is on ${plan.branch.base}`);
    }
}
