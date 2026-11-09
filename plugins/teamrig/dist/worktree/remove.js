import { dirname, join, relative, sep } from 'node:path';
import { errorCode, errorMessage } from "../core/guards.js";
/**
 * `teamrig worktree remove`: drop a linked git worktree without touching what its links point to. On Windows,
 * `git worktree remove` follows a directory junction (such as a `node_modules` linked in from the main checkout)
 * and deletes what is inside it, which empties the main checkout's copy. So every link in the worktree goes first,
 * by unlink, which removes the link alone, and is confirmed gone before git runs. A removal that stops before the
 * worktree is gone puts each of them back, so the worktree keeps its modules.
 *
 * Every check runs before anything changes, and any doubt refuses: a path that is not a worktree's top folder, the
 * main checkout, a locked worktree, a run from inside it, a real `node_modules` folder where a link was expected,
 * files git tracks under a link, uncommitted changes, and, for `--delete-branch`, a branch with a commit whose
 * change is not on its base.
 *
 * A folder git no longer lists, directly in a folder worktrees are made in and holding only folders and links, is the
 * leftover of a removal git stopped partway (T1051): its links are unlinked, their targets shown untouched, and its
 * folders removed once empty, never by a recursive delete.
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
/** The default branch that holds every commit of the detached HEAD at `top`; undefined when it holds not all, or git cannot tell. */
function detachedMergedInto(git, top) {
    const base = git.defaultBase(top);
    return base !== undefined && git.headCommitsNotOn(top, base) === 0 ? base : undefined;
}
/** Every link and folder under `top`, each folder before the one that holds it and `top` last; undefined when anything else is there. */
async function scanLeftover(files, top) {
    const links = [];
    const folders = [];
    const toWalk = [top];
    for (let folder = toWalk.pop(); folder !== undefined; folder = toWalk.pop()) {
        folders.push(folder);
        // `.git` is not skipped: a leftover has none, and a file in it, or anywhere, makes the folder no leftover.
        for (const entry of await files.entries(folder)) {
            if (entry.kind === 'other') {
                return undefined;
            }
            (entry.kind === 'link' ? links : toWalk).push(join(folder, entry.name));
        }
    }
    // Each folder is walked after the one that holds it, so the reverse order removes it first.
    return { links: links.sort(), folders: folders.reverse() };
}
/** The worktree folder of `request` that is the folder `parent`, compared by canonical spelling. */
async function worktreeFolderAt(files, folders, parent) {
    for (const folder of folders) {
        if ((await files.canonical(folder.folder)) === parent) {
            return folder;
        }
    }
    return undefined;
}
/**
 * The leftover of a removal git stopped partway at `request.path`, or the refusal it needs; undefined when the folder is
 * no leftover, so the caller's own refusal stands. `top` is the worktree git places it in: undefined outside git, and
 * only the main checkout counts, as a worktree folder may sit in it; inside a linked worktree a folder is that one's.
 */
async function leftoverDecision(request, ports, canonicalPath, top) {
    const { git, files } = ports;
    const { path } = request;
    const parent = await files.canonical(dirname(path));
    const folder = canonicalPath === undefined || parent === undefined ? undefined : await worktreeFolderAt(files, request.worktreeFolders, parent);
    if (canonicalPath === undefined || folder === undefined) {
        return undefined;
    }
    // A worktree git still lists, its .git file lost, is git's to prune; one git cannot list is in doubt.
    const listed = git.worktrees(folder.mainDir);
    if (listed === undefined || (await entryAt(files, listed, canonicalPath)) !== undefined) {
        return undefined;
    }
    if (top !== undefined) {
        const [main] = git.worktrees(top) ?? [];
        const canonicalTop = await files.canonical(top);
        if (main === undefined || canonicalTop === undefined || (await files.canonical(main.path)) !== canonicalTop || git.tracked(top, [gitName(top, path)])?.length !== 0) {
            return undefined;
        }
    }
    const scan = await scanLeftover(files, path);
    if (scan === undefined) {
        return undefined;
    }
    const canonicalCwd = await files.canonical(request.cwd);
    if (canonicalCwd !== undefined && within(canonicalCwd, canonicalPath)) {
        return refused(`this runs inside ${path}, which a running program keeps from being deleted: run it from another folder`);
    }
    if (request.deleteBranch) {
        return refused(`git no longer knows which branch ${path} had: clear it without --delete-branch, then delete the branch with git branch -d <name>`);
    }
    const links = [];
    for (const link of scan.links) {
        const target = await files.linkTarget(link);
        links.push({ path: link, name: gitName(path, link), target, targetEntries: await files.entryCount(target) });
    }
    return { kind: 'leftover', plan: { top: path, links, folders: scan.folders } };
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
        return (await leftoverDecision(request, ports, canonicalPath, undefined)) ?? refused(`${path} is not in a git worktree`);
    }
    if (canonicalPath !== canonicalTop) {
        return (await leftoverDecision(request, ports, canonicalPath, top)) ?? refused(`${path} is inside the worktree ${top}: give its top folder`);
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
    const mergedInto = mine.branch === undefined ? detachedMergedInto(git, top) : undefined;
    return { kind: 'ready', plan: { top, mainDir: main.path, links, branch, onBranch: mine.branch, mergedInto } };
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
/** What a dry run on a leftover would do, one line per step. */
export function describeLeftover(plan) {
    const under = plan.folders.length - 1;
    return [
        ...plan.links.map((link) => `would unlink ${link.name} (the link only; its target ${link.target} holds ${entriesText(link.targetEntries)})`),
        under === 0 ? `would remove the empty folder ${plan.top}` : `would remove ${plan.top} and the ${under} empty folder${under === 1 ? '' : 's'} under it`,
    ];
}
/** Why Windows most often keeps a folder it was asked to delete. */
const HELD_BY_A_PROGRAM = 'a program with its working folder inside it (often a Claude Code tab started there) keeps Windows from deleting it';
/** Why an empty folder of a leftover could not be removed, and what to do. */
function folderFailure(folder, error) {
    const code = errorCode(error);
    if (code === 'ENOTEMPTY') {
        return `something was put in ${folder} after the check, so it is kept: run this again to check it anew`;
    }
    const cause = code === 'EBUSY' || code === 'EPERM' ? `; most often ${HELD_BY_A_PROGRAM}: close that program or move it out, then run this again` : '';
    return `cannot remove ${folder}: ${errorMessage(error)}${cause}`;
}
/**
 * Clears a leftover, telling each step: unlinks each link and sees it gone, proves each target untouched, then removes
 * each folder once empty, deepest first. A link is never put back on a failure: the folder is no worktree, and a rerun
 * clears what is left.
 */
export async function clearLeftover(plan, files, tell) {
    for (const link of plan.links) {
        try {
            await files.unlinkLink(link.path);
        }
        catch (error) {
            throw new Error(`cannot unlink ${link.name} in ${plan.top}: ${errorMessage(error)}`, { cause: error });
        }
        if ((await files.kindOf(link.path)) !== 'missing') {
            throw new Error(`${link.name} is still in ${plan.top} after its unlink`);
        }
        tell(`unlinked ${link.name} (the link only, to ${link.target})`);
    }
    await proveTargets(plan.links, files, tell);
    for (const folder of plan.folders) {
        try {
            await files.removeEmptyFolder(folder);
        }
        catch (error) {
            throw new Error(folderFailure(folder, error), { cause: error });
        }
    }
    tell(`removed ${plan.top}`);
}
/** Why the link cannot be put back where it was; undefined once it is back. */
async function relinkFailure(files, link) {
    if ((await files.kindOf(dirname(link.path))) !== 'folder') {
        return 'its folder is gone';
    }
    if ((await files.kindOf(link.path)) !== 'missing') {
        return 'something else is at its path';
    }
    try {
        await files.makeLink(link.path, link.target);
    }
    catch (error) {
        return errorMessage(error);
    }
    return undefined;
}
/**
 * Puts back each link unlinked for a removal that then failed, so the worktree keeps its `node_modules` instead of
 * failing its next build or test run on a missing module.
 */
async function putBack(files, links, tell) {
    const back = [];
    const lost = [];
    for (const link of links) {
        const failure = await relinkFailure(files, link);
        if (failure === undefined) {
            back.push(link.name);
            tell(`put back ${link.name} (a link to ${link.target})`);
        }
        else {
            lost.push(`${link.name}, a link to ${link.target}: ${failure}`);
        }
    }
    return { back, lost };
}
function putBackText({ back, lost }) {
    const parts = [...(back.length === 0 ? [] : [`its links are back: ${back.join(', ')}`]), ...(lost.length === 0 ? [] : [`still gone: ${lost.join('; ')}`])];
    return parts.length === 0 ? '' : ` (${parts.join('; ')})`;
}
/**
 * Whether a git removal that failed went past its point of no return: git deletes its record of the worktree even when
 * it cannot delete the folder (Windows keeps a folder a program has as its working folder), so the folder stays on
 * disk while git no longer lists it. False when the folder is gone, git still lists it, or git cannot tell.
 */
async function removedPartway(plan, ports) {
    const canonicalTop = await ports.files.canonical(plan.top);
    const worktrees = canonicalTop === undefined ? undefined : ports.git.worktrees(plan.mainDir);
    return canonicalTop !== undefined && worktrees !== undefined && (await entryAt(ports.files, worktrees, canonicalTop)) === undefined;
}
/** Tells each link's target as untouched, or throws the first that changed. */
async function proveTargets(links, files, tell) {
    for (const link of links) {
        const after = await files.entryCount(link.target);
        if (after !== link.targetEntries) {
            throw new Error(`${link.target}, the target of ${link.name}, held ${entriesText(link.targetEntries)} before and ${entriesText(after)} after the removal`);
        }
        tell(`target ${link.target} untouched: ${entriesText(after)}, as before`);
    }
}
/** Deletes the plan's branch, proven on its base when the plan was made, telling it; why the delete failed, else undefined. */
function deletePlannedBranch(plan, git, tell) {
    if (plan.branch === undefined) {
        return undefined;
    }
    const deleted = git.deleteBranch(plan.mainDir, plan.branch.name);
    if (!deleted.ok) {
        return `git branch -D ${plan.branch.name}: ${deleted.reason}`;
    }
    tell(`deleted branch ${plan.branch.name}: every commit of it is on ${plan.branch.base}`);
    return undefined;
}
/**
 * Carries out a plan, telling each step as it is done. A link that fails its unlink or is still there after it stops
 * it before git runs; that, or a git removal that fails, first puts back every link already unlinked, unless git
 * stopped partway, past dropping its record of the worktree; the branch is then deleted all the same. A target that
 * changed after the removal, or a branch delete that fails, is thrown with what was already done.
 */
export async function carryOut(plan, ports, tell) {
    const { git, files } = ports;
    const unlinked = [];
    for (const link of plan.links) {
        try {
            await files.unlinkLink(link.path);
        }
        catch (error) {
            const put = await putBack(files, unlinked, tell);
            throw new Error(`cannot unlink ${link.name} in ${plan.top}, so git was not run: ${errorMessage(error)}${putBackText(put)}`, { cause: error });
        }
        if ((await files.kindOf(link.path)) !== 'missing') {
            const put = await putBack(files, unlinked, tell);
            const unchanged = put.lost.length === 0 ? '; nothing else changed' : '';
            throw new Error(`${link.name} is still in ${plan.top} after its unlink, so git was not run${putBackText(put)}${unchanged}`);
        }
        unlinked.push(link);
        tell(`unlinked ${link.name} (the link only, to ${link.target})`);
    }
    const removed = git.removeWorktree(plan.mainDir, plan.top);
    if (!removed.ok && (await removedPartway(plan, ports))) {
        // The worktree is no more: links put back would leave a folder holding only them, which a rerun could not tell
        // from any other folder (T1051). A changed target is thrown first, as the graver fault.
        await proveTargets(plan.links, files, tell);
        // The branch is checked out nowhere now, and a rerun on the folder git no longer lists cannot tell which branch it
        // had (T743): delete it here or never.
        const branchFailure = deletePlannedBranch(plan, git, tell);
        const branchKept = branchFailure === undefined ? '' : `. Its branch is kept: ${branchFailure}`;
        throw new Error(`git worktree remove ${plan.top} stopped partway: ${removed.reason}. git no longer lists it, and ${plan.top} is left on disk: ` +
            `${HELD_BY_A_PROGRAM}. Close that program or move it out, then run teamrig worktree remove ${plan.top} again to clear what is left` +
            branchKept);
    }
    if (!removed.ok) {
        const put = await putBack(files, unlinked, tell);
        throw new Error(`git worktree remove ${plan.top}: ${removed.reason}${putBackText(put)}`);
    }
    tell(`removed the worktree ${plan.top}`);
    await proveTargets(plan.links, files, tell);
    const branchFailure = deletePlannedBranch(plan, git, tell);
    if (branchFailure !== undefined) {
        throw new Error(`the worktree is removed, but ${branchFailure}`);
    }
}
