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
/** C5: the tool is a tracked file of a checkout of the repository, with no change at all and a HEAD on its default branch. */
function toolIsLanded(git, tool, mainDir) {
    const checkout = git.checkoutOf(dirname(tool));
    if (checkout === undefined || !sameRepository(git, checkout.top, mainDir)) {
        return false;
    }
    const path = relative(checkout.top, tool).replaceAll('\\', '/');
    if (path === '' || path.startsWith('../') || isAbsolute(path)) {
        return false;
    }
    const changes = git.changes(checkout.top, true);
    const tracked = git.blobsAt(checkout.top, 'HEAD', [path])?.has(path) === true;
    return changes?.length === 0 && tracked && git.isAncestor(checkout.top, 'HEAD', `${ORIGIN}/${git.defaultBranch(checkout.top, ORIGIN)}`);
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
