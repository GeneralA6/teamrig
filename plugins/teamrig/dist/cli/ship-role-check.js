import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { DEFAULT_WORKTREE_FOLDER } from "../config/defaults.js";
import { taskFolder } from "../core/home.js";
import { isAtOrBelow, samePath } from "../core/paths.js";
import { teamPlace } from "../delivery/places.js";
import { ORIGIN } from "../merge/git.js";
import { taskBranchOf } from "../permissions/route-git.js";
import { JsonlEventLog } from "../register/store.js";
/** The repository whose configured ship tool `tool` names; undefined when none does. */
function shipRepoOf(kit, config, tool) {
    for (const repo of Object.values(config.delivery.repos)) {
        const mainDir = teamPlace(kit.paths, repo.mainCheckout);
        if (repo.shipTool !== undefined && samePath(resolve(mainDir, repo.shipTool), tool)) {
            return { mainDir, config: repo };
        }
    }
    return undefined;
}
/** Whether a word names a ship tool the team configured, for reading a line as a ship call. */
export function shipToolTest(kit, config) {
    return (word) => shipRepoOf(kit, config, word) !== undefined;
}
/** True when `path` is a place strictly inside `folder`. */
function isInside(path, folder) {
    return isAtOrBelow(path, folder) && !samePath(path, folder);
}
/** True when git reads both places as one repository. */
function sameRepository(git, a, b) {
    const first = git.commonDir(a);
    const second = git.commonDir(b);
    return first !== undefined && second !== undefined && samePath(first, second);
}
/** The tool's checkout when the tool is a tracked file of a checkout of the repository with no change at all; undefined otherwise. */
function cleanToolCheckout(git, tool, mainDir) {
    const checkout = git.checkoutOf(dirname(tool));
    if (checkout === undefined || !sameRepository(git, checkout.top, mainDir)) {
        return undefined;
    }
    const path = relative(checkout.top, tool).replaceAll('\\', '/');
    if (path === '' || path.startsWith('../') || isAbsolute(path)) {
        return undefined;
    }
    const changes = git.changes(checkout.top, true);
    const tracked = git.blobsAt(checkout.top, 'HEAD', [path])?.has(path) === true;
    const head = git.sha(checkout.top, 'HEAD');
    return changes?.length === 0 && tracked && head !== undefined ? { top: checkout.top, head } : undefined;
}
/** The default branch as of the checkout's last fetch, such as `origin/main`. */
function defaultRefOf(git, top) {
    return `${ORIGIN}/${git.defaultBranch(top, ORIGIN)}`;
}
/** True when the checkout's HEAD makes the default branch's tree: main's current code, where any past main's has another tree. */
function holdsMainsCode(git, top) {
    const tree = git.treeOf(top, 'HEAD');
    return tree !== undefined && tree === git.treeOf(top, defaultRefOf(git, top));
}
/** C5: the tool is a clean, tracked file of a checkout of the repository that holds main's current code. */
function toolIsLanded(git, tool, mainDir) {
    const checkout = cleanToolCheckout(git, tool, mainDir);
    return checkout !== undefined && holdsMainsCode(git, checkout.top);
}
/** The configured ship tool a step's words run, each word read from the step's folder; undefined when they run none. */
export function shipToolOfWords(kit, config, words, cwd) {
    return words.map((word) => (isAbsolute(word) ? word : resolve(cwd, word))).find((word) => shipRepoOf(kit, config, word) !== undefined);
}
/** A stale or changed ship tool's refusal: what it is not, and how to move its checkout to the newest main. */
function staleToolReason(git, tool, since) {
    const top = git.checkoutOf(dirname(tool))?.top ?? dirname(tool);
    const main = defaultRefOf(git, top);
    return `the ship tool ${tool}${since} is not ${main}'s current code in a checkout with no change: run git -C ${top} fetch -q ${ORIGIN} && git -C ${top} checkout -q --detach ${main}, then queue the step again`;
}
/**
 * Pins a ship tool a step is queued to run (T3223): it must hold main's current code as C5 reads it, so a queued ship
 * runs the same reviewed tool whether a role's allow or a person let the line through; a reason when it does not.
 */
export function shipToolPinOf(git, kit, config, tool) {
    const repo = shipRepoOf(kit, config, tool);
    const checkout = repo === undefined ? undefined : cleanToolCheckout(git, tool, repo.mainDir);
    return checkout !== undefined && holdsMainsCode(git, checkout.top) ? { tool, head: checkout.head } : { refused: staleToolReason(git, tool, '') };
}
/**
 * Why a pinned ship tool may not run when its step starts, after waiting in the host lock's line; undefined when it
 * may. Its checkout must still be clean and at the pinned commit, or at main's current code if it moved on, so a
 * checkout moved to another commit while the step waited never runs that commit's tool.
 */
export function shipToolStartRefusal(git, kit, config, pin) {
    const repo = shipRepoOf(kit, config, pin.tool);
    const checkout = repo === undefined ? undefined : cleanToolCheckout(git, pin.tool, repo.mainDir);
    if (checkout !== undefined && (checkout.head === pin.head || holdsMainsCode(git, checkout.top))) {
        return undefined;
    }
    return staleToolReason(git, pin.tool, ` changed from ${pin.head.slice(0, 9)} while the step waited and`);
}
/**
 * The branch a ship call runs on, when `holder` may run it (C4, C5 above); undefined otherwise, so the permission check
 * decides. The register is read only after the line's places pass, and git last.
 */
export async function shipBranchOf(runtime, kit, config, holder, run) {
    const repo = shipRepoOf(kit, config, run.tool);
    if (repo === undefined || !isInside(run.worktree, resolve(repo.mainDir, repo.config.worktreeFolder ?? DEFAULT_WORKTREE_FOLDER))) {
        return undefined;
    }
    const git = runtime.mergeGit;
    const checkout = git.checkoutOf(run.worktree);
    const branch = checkout?.branch;
    const task = branch === undefined ? undefined : taskBranchOf(branch, config.pushGuard.protectedBranches);
    if (checkout === undefined || !checkout.linked || !samePath(checkout.top, run.worktree) || task === undefined || (run.task !== undefined && run.task !== task)) {
        return undefined;
    }
    const owner = (await new JsonlEventLog(runtime.files, kit.paths.events).read()).state.tasks.get(task)?.owner;
    const folder = taskFolder(kit.paths.kitHome, kit.paths.team, task);
    if (owner !== holder || !run.files.every((file) => isInside(file, folder))) {
        return undefined;
    }
    return sameRepository(git, run.worktree, repo.mainDir) && toolIsLanded(git, run.tool, repo.mainDir) ? branch : undefined;
}
