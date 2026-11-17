import { dirname, isAbsolute, resolve } from 'node:path';
import { DEFAULT_WORKTREE_FOLDER } from "../config/defaults.js";
import { taskFolder } from "../core/home.js";
import { isAtOrBelow, samePath } from "../core/paths.js";
import { teamPlace } from "../delivery/places.js";
import { takesShipSlot } from "../delivery/process-request.js";
import { FALLBACK_BRANCH, ORIGIN } from "../merge/git.js";
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
/** The state of a tool in no checkout, or none of a configured repository: never main's current code. */
function toolInNoCheckout(tool) {
    return { top: dirname(tool), mainRef: `${ORIGIN}/${FALLBACK_BRANCH}`, head: undefined, landed: false };
}
/**
 * The tool's checkout as C5 reads it, or which git read did not answer (T3368): a git that did not start, was stopped
 * or died starting tells nothing of the tool, so it is never read as a tool that is not main's current code.
 */
function toolStateOf(git, tool, mainDir) {
    const repository = git.repositoryOf(mainDir);
    if (!repository.ok) {
        return repository;
    }
    const read = git.fileCheckout(tool);
    if (!read.ok) {
        return read;
    }
    const checkout = read.value;
    if (checkout === undefined) {
        return { ok: true, value: toolInNoCheckout(tool) };
    }
    const ours = repository.value !== undefined && samePath(checkout.commonDir, repository.value);
    const head = ours && checkout.clean && checkout.tracked ? checkout.head : undefined;
    const landed = head !== undefined && checkout.headTree !== undefined && checkout.headTree === checkout.mainTree;
    return { ok: true, value: { top: checkout.top, mainRef: checkout.mainRef, head, landed } };
}
/** The ship tool check's read of a configured or unconfigured tool. */
function shipToolStateOf(git, kit, config, tool) {
    const repo = shipRepoOf(kit, config, tool);
    return repo === undefined ? { ok: true, value: toolInNoCheckout(tool) } : toolStateOf(git, tool, repo.mainDir);
}
/** C5, failing closed: the tool is a clean, tracked file of a checkout of the repository that holds main's current code. */
function toolIsLanded(git, tool, mainDir) {
    const state = toolStateOf(git, tool, mainDir);
    return state.ok && state.value.landed;
}
/** How many times the start check reads a checkout git does not answer, and how long it waits between reads (T3368). */
export const SHIP_TOOL_READS = 4;
export const SHIP_TOOL_REREAD_MS = 15_000;
/** The configured ship tool a step's words run, each word read from the step's folder; undefined when they run none. */
export function shipToolOfWords(kit, config, words, cwd) {
    return words.map((word) => placeOfWord(word, cwd)).find((word) => shipRepoOf(kit, config, word) !== undefined);
}
/** A step's word as a place: as it is when absolute, else read from the step's folder `cwd`. */
function placeOfWord(word, cwd) {
    return isAbsolute(word) ? word : resolve(cwd, word);
}
/**
 * The task a step that runs a configured ship tool ships (T3286): the one its worktree's branch names, the worktree
 * being the word after the tool (after its `merge` in the merge form), read from the step's folder. A ship line names
 * no task of its own, so its ticket takes this one's priority and class; undefined for a step that runs no ship tool
 * or a worktree on no task branch.
 */
export function shipTaskOfWords(git, kit, config, words, cwd) {
    const [first, second] = shipToolArgsOf(kit, config, words, cwd) ?? [];
    const worktree = first === 'merge' ? second : first;
    const branch = worktree === undefined ? undefined : git.checkoutOf(placeOfWord(worktree, cwd))?.branch;
    return branch === undefined ? undefined : taskBranchOf(branch, config.pushGuard.protectedBranches);
}
/** The words after the configured ship tool a step's words run; undefined when they run none. */
function shipToolArgsOf(kit, config, words, cwd) {
    const at = words.findIndex((word) => shipRepoOf(kit, config, placeOfWord(word, cwd)) !== undefined);
    return at < 0 ? undefined : words.slice(at + 1);
}
/**
 * Why a step that runs a configured ship tool may not run under `kind` (T3414); undefined when the kind fits it, or
 * the step runs no ship tool. A run that merges (`--merge`, or the `merge` form) moves main, so it takes the host's
 * one ship slot (process-request.ts); one that does not only commits and checks a worktree, so it is a test step,
 * run beside the others while another ship holds the slot.
 */
export function shipKindRefusal(kit, config, words, cwd, kind) {
    const args = shipToolArgsOf(kit, config, words, cwd);
    if (args === undefined) {
        return undefined;
    }
    const merges = args[0] === 'merge' || args.includes('--merge');
    if (merges && !takesShipSlot(kind)) {
        return `a ship tool run that merges moves main, so it holds the ship slot: queue it with --kind ship or --kind merge, not --kind ${kind}`;
    }
    if (!merges && takesShipSlot(kind)) {
        return `a ship tool run without --merge moves no main branch, so it takes no ship slot: queue it with --kind test, not --kind ${kind}`;
    }
    return undefined;
}
/** A stale or changed ship tool's refusal: what it is not, and how to move its checkout to the newest main. */
function staleToolReason(tool, state, since) {
    return `the ship tool ${tool}${since} is not ${state.mainRef}'s current code in a checkout with no change: run git -C ${state.top} fetch -q ${ORIGIN} && git -C ${state.top} checkout -q --detach ${state.mainRef}, then queue the step again`;
}
/**
 * Pins a ship tool a step is queued to run (T3223): it must hold main's current code as C5 reads it, so a queued ship
 * runs the same reviewed tool whether a role's allow or a person let the line through; a reason when it does not.
 * When git did not answer, it pins no commit and the start check, which reads again, decides (T3368).
 */
export function shipToolPinOf(git, kit, config, tool) {
    const state = shipToolStateOf(git, kit, config, tool);
    if (!state.ok) {
        return { tool, head: undefined };
    }
    return state.value.landed ? { tool, head: state.value.head } : { refused: staleToolReason(tool, state.value, '') };
}
/**
 * Why a pinned ship tool may not run when its step starts, after waiting in the host lock's line; undefined when it
 * may. Its checkout must still be clean and at the pinned commit, or at main's current code if it moved on, so a
 * checkout moved to another commit while the step waited never runs that commit's tool. A read git does not answer is
 * read again, {@link SHIP_TOOL_READS} times in all, then refused naming that read, never as a changed tool (T3368).
 */
export async function shipToolStartRefusal(git, kit, config, pin, sleep) {
    for (let reads = 1;; reads += 1) {
        const state = shipToolStateOf(git, kit, config, pin.tool);
        if (state.ok) {
            const { head, landed } = state.value;
            const since = pin.head === undefined ? '' : ` changed from ${pin.head.slice(0, 9)} while the step waited and`;
            return head !== undefined && (head === pin.head || landed) ? undefined : staleToolReason(pin.tool, state.value, since);
        }
        if (reads >= SHIP_TOOL_READS) {
            return `could not read the checkout of the ship tool ${pin.tool}, so the step did not run: ${state.reason}, at each of ${reads} reads ${SHIP_TOOL_REREAD_MS / 1000} s apart; git gave no answer, which says nothing of the tool, so queue the step again once git answers on this host`;
        }
        await sleep(SHIP_TOOL_REREAD_MS);
    }
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
