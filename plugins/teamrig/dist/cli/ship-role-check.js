import { dirname, isAbsolute, posix, resolve } from 'node:path';
import { taskFolder } from "../core/home.js";
import { isAtOrBelow, samePath } from "../core/paths.js";
import { teamPlace } from "../delivery/places.js";
import { takesShipSlot } from "../delivery/process-request.js";
import { FALLBACK_BRANCH, ORIGIN, pathInCheckout } from "../merge/git.js";
import { taskBranchOf } from "../permissions/route-git.js";
import { JsonlEventLog } from "../register/store.js";
import { moduleSpecifiersOf } from "./module-specifiers.js";
import { worktreeFolderOf } from "./worktree-folder.js";
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
/** The first git whose `rev-parse` takes `--path-format`, which every checkout read of the check runs. */
const PATH_FORMAT_GIT = { major: 2, minor: 31 };
/** Whether `version`, such as `2.30.2`, is a git older than {@link PATH_FORMAT_GIT}; false when git could not tell. */
function predatesPathFormat(version) {
    if (version === undefined) {
        return false;
    }
    const [major = 0, minor = 0] = version.split('.').map(Number);
    return major < PATH_FORMAT_GIT.major || (major === PATH_FORMAT_GIT.major && minor < PATH_FORMAT_GIT.minor);
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
        const version = git.gitVersion(mainDir);
        return { ok: true, value: predatesPathFormat(version) ? { ...toolInNoCheckout(tool), oldGit: version } : toolInNoCheckout(tool) };
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
/** Words that point git, gh or a shell at another place than the step's folder. */
const ELSEWHERE_WORDS = new Set(['-C', '-R', '--repo', '--git-dir', '--work-tree', 'cd', 'pushd']);
/** A word the shell reads as a script, not one argument: it holds whitespace, an operator or an expansion. */
const SHELL_SCRIPT_WORD = /[\s;&|$`]/;
/**
 * True when `word` may point the step at another repository than `own`, its folder's: an option naming a repository or
 * folder (`-C <dir>`, `-R <owner/repo>`, `--git-dir=`), an environment setting (`GIT_DIR=...`), a shell script in one
 * word, or a path whose folder lies in another repository or in none.
 */
function pointsElsewhere(git, word, cwd, own) {
    if (ELSEWHERE_WORDS.has(word) || /^-[CR]./.test(word) || /^--(repo|git-dir|work-tree)=/.test(word) || /^[A-Za-z_]\w*=/.test(word) || SHELL_SCRIPT_WORD.test(word)) {
        return true;
    }
    if (!/[/\\]/.test(word)) {
        return false;
    }
    const place = placeOfWord(word, cwd);
    const repo = git.commonDir(place) ?? git.commonDir(dirname(place));
    return repo === undefined || !samePath(repo, own);
}
/**
 * The repository a step that holds the ship slot moves (#1711), as its shared git folder: for a step that runs a
 * configured ship tool, its target worktree's (the word after the tool, after its `merge` in the merge form); for any
 * other, the step's folder's, unless a word after the program may point it elsewhere (`pointsElsewhere`), the
 * program is a path in another repository, or the program word is a whole shell line (a step of one word runs as one,
 * `commandLine`), whose words are not read. Undefined when that is in doubt, so the step holds the slot of every
 * repository, as before.
 */
export function shipSlotRepoOf(git, kit, config, words, cwd) {
    const args = shipToolArgsOf(kit, config, words, cwd);
    if (args !== undefined) {
        const worktree = args[0] === 'merge' ? args[1] : args[0];
        return worktree === undefined || worktree.startsWith('-') ? undefined : git.commonDir(placeOfWord(worktree, cwd));
    }
    const program = words[0] ?? '';
    const own = git.commonDir(cwd);
    if (own === undefined || SHELL_SCRIPT_WORD.test(program) || words.slice(1).some((word) => pointsElsewhere(git, word, cwd, own))) {
        return undefined;
    }
    // The program word by its path: a script of another repository run straight moves that one; a program in no
    // repository (`/usr/bin/git`) is a tool, which moves the folder's.
    const place = placeOfWord(program, cwd);
    const programRepo = /[/\\]/.test(program) ? (git.commonDir(place) ?? git.commonDir(dirname(place))) : undefined;
    return programRepo === undefined || samePath(programRepo, own) ? own : undefined;
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
/** The most files the code a ship tool runs is read to; a larger closure tells nothing, so the start check fails closed. */
export const TOOL_CODE_MAX_FILES = 2000;
/** A file a module loads whose own imports are followed: JavaScript or TypeScript code, not a data file. */
const MODULE_FILE = /\.(?:[cm]?[jt]s|[jt]sx)$/;
/**
 * The file beside a ship tool that names, as data, the files it runs beside its imports (T3419): a CLI it spawns by a
 * joined path, the package files that set how its modules load. `tools/ship/ship.ts` has `tools/ship/ship.roots.json`.
 */
export function toolRootsPath(tool) {
    const extension = posix.extname(tool);
    return `${extension === '' ? tool : tool.slice(0, -extension.length)}.roots.json`;
}
const isPathList = (value) => Array.isArray(value) && value.every((path) => typeof path === 'string');
/**
 * A roots file's shape: `{ "roots": ["src/cli/main.ts", "package.json"], "staticOnly": ["src/cli/run.ts"] }`, each path
 * from the checkout's top, `staticOnly` optional.
 */
function isRootsFile(value) {
    return (typeof value === 'object' &&
        value !== null &&
        'roots' in value &&
        isPathList(value.roots) &&
        (!('staticOnly' in value) || isPathList(value.staticOnly)));
}
/** A path from the checkout's top: not the top itself, not absolute, not leaving it. */
const inCheckout = (path) => path !== '.' && !path.startsWith('../') && !posix.isAbsolute(path) && !/^[A-Za-z]:/.test(path);
/**
 * What a roots file names, as paths in the checkout; undefined when it is no JSON of that shape, or a path is absolute
 * or leaves the checkout, so the caller cannot tell what the tool runs.
 */
export function toolRootsOf(text) {
    let value;
    try {
        value = JSON.parse(text);
    }
    catch {
        return undefined;
    }
    if (!isRootsFile(value)) {
        return undefined;
    }
    const roots = value.roots.map((root) => posix.normalize(root));
    const staticOnly = (value.staticOnly ?? []).map((path) => posix.normalize(path));
    return [...roots, ...staticOnly].every(inCheckout) ? { roots, staticOnly } : undefined;
}
/**
 * The repository paths a module at `path` loads by a relative specifier: an import (`from './x.ts'`, `import('../y.ts')`)
 * or a file it reads beside it (`new URL('./repos.json', import.meta.url)`), so a data file the tool runs on is its code
 * too, its `import('…')` calls left out with `dynamic: false`. Read from the module's code, never its comments or
 * strings (see {@link moduleSpecifiersOf}); undefined when the code cannot be read apart from its text.
 */
export function relativeImportsOf(text, path, dynamic = true) {
    const specifiers = moduleSpecifiersOf(text, { dynamic });
    return specifiers
        ?.filter((specifier) => specifier.startsWith('./') || specifier.startsWith('../'))
        .map((specifier) => posix.normalize(posix.join(posix.dirname(path), specifier)));
}
/**
 * The code a ship tool runs at `ref` (T3419): the tool's file, the roots its roots file names ({@link toolRootsPath}),
 * that file's own path whether it is there or not (so adding or removing it is a change), and every module they
 * import, followed through relative imports, as paths in its checkout. Undefined when one is not a file there, leaves
 * the checkout, cannot be read apart from its text, or the closure passes {@link TOOL_CODE_MAX_FILES}, so the caller
 * cannot tell the code is the same.
 */
export function toolCodeAt(git, top, ref, tool) {
    const rootsPath = toolRootsPath(tool);
    const rootsRead = git.filesAt(top, ref, [rootsPath]);
    const named = rootsRead === undefined ? undefined : toolRootsOf(rootsRead.get(rootsPath) ?? '{"roots":[]}');
    if (named === undefined) {
        return undefined;
    }
    const { roots, staticOnly } = named;
    const seen = new Set([rootsPath]);
    // One git read per level of imports, never one per file (T4035): a tool's code runs to hundreds of files, and the
    // start check of every queued ship reads it twice.
    for (let level = [tool, ...roots]; level.length > 0;) {
        const fresh = [...new Set(level)].filter((path) => !seen.has(path));
        if (fresh.some((path) => path.startsWith('../')) || seen.size + fresh.length > TOOL_CODE_MAX_FILES) {
            return undefined;
        }
        const texts = fresh.length === 0 ? new Map() : git.filesAt(top, ref, fresh);
        if (texts === undefined) {
            return undefined;
        }
        const next = [];
        for (const path of fresh) {
            const text = texts.get(path);
            const imports = text === undefined ? undefined : MODULE_FILE.test(path) ? relativeImportsOf(text, path, !staticOnly.includes(path)) : [];
            if (imports === undefined) {
                return undefined;
            }
            seen.add(path);
            next.push(...imports);
        }
        level = next;
    }
    return [...seen].sort();
}
/**
 * The files of the code a tool runs that differ between `from` and `to`, a later commit of the same history (T3419):
 * none when the tool runs the same code at both, so a main that moved on without touching it refuses no waiting ship.
 * The code is what the tool runs at either commit, so a file it stopped loading counts too. Undefined when that cannot
 * be told (`to` not after `from`, a read git did not answer), so the step is refused as a changed tool.
 */
function toolCodeChangeOf(git, state, tool, from, to) {
    const path = pathInCheckout(state.top, tool);
    if (path === undefined || !git.isAncestor(state.top, from, to)) {
        return undefined;
    }
    const before = toolCodeAt(git, state.top, from, path);
    const after = toolCodeAt(git, state.top, to, path);
    const changed = git.changedPaths(state.top, from, to);
    if (before === undefined || after === undefined || changed === undefined) {
        return undefined;
    }
    return [...new Set([...before, ...after])].sort().filter((file) => changed.includes(file));
}
/** How the refusals tell a person to move the tool's checkout to the newest main. */
function moveHint(state) {
    return `run git -C ${state.top} fetch -q ${ORIGIN} && git -C ${state.top} checkout -q --detach ${state.mainRef}, then queue the step again`;
}
/** A stale or changed ship tool's refusal: what it is not, and how to move its checkout to the newest main. */
function staleToolReason(tool, state, since) {
    if (state.oldGit !== undefined) {
        return `the ship tool check reads ${tool}'s checkout with git rev-parse --path-format=absolute, which needs git ${PATH_FORMAT_GIT.major}.${PATH_FORMAT_GIT.minor} or newer, and this host runs git ${state.oldGit}: upgrade git, then queue the step again`;
    }
    return `the ship tool ${tool}${since} is not ${state.mainRef}'s current code in a checkout with no change: ${moveHint(state)}`;
}
/**
 * The remote's own head of the default branch, asked at a step's start (#1466), so the start check never rests on the
 * local ref alone: a refusal when that head is not in the checkout's repository (fetch first) or the local ref is
 * neither it nor an ancestor of it; undefined in `value` when they agree. Not answered when the remote gives no head.
 */
function remoteHeadOf(git, state) {
    const branch = state.mainRef.startsWith(`${ORIGIN}/`) ? state.mainRef.slice(ORIGIN.length + 1) : FALLBACK_BRANCH;
    const head = git.remoteHead(state.top, ORIGIN, branch);
    if (head === undefined) {
        return { ok: false, reason: `git ls-remote ${ORIGIN} ${branch} in ${state.top} gave no head` };
    }
    const local = git.sha(state.top, state.mainRef);
    if (git.treeOf(state.top, head) === undefined) {
        return { ok: true, value: { head, local, refused: `${ORIGIN}'s ${branch} is at ${head.slice(0, 9)}, which the checkout of the ship tool has not fetched: ${moveHint(state)}` } };
    }
    if (local === undefined || (local !== head && !git.isAncestor(state.top, local, head))) {
        const at = local === undefined ? 'names no commit' : `(${local.slice(0, 9)}) is not on its history`;
        return { ok: true, value: { head, local, refused: `${ORIGIN}'s ${branch} is at ${head.slice(0, 9)}, and ${state.mainRef} in ${state.top} ${at}: ${moveHint(state)}` } };
    }
    return { ok: true, value: { head, local } };
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
 * may. Its checkout must still be clean and at the pinned commit, or at main's current code if it moved on, or at a
 * later commit of main's history where none of the code the tool runs changed (T3419), so a checkout moved to another
 * commit while the step waited never runs other code than the one it was queued with or main's current one. Main's
 * current code is the remote's own head, asked at the start (#1466): the tool's code at the checkout must be the code
 * at that head, so a local ref that is only behind decides nothing. A read git or the remote does not answer is read
 * again, {@link SHIP_TOOL_READS} times in all, then refused naming that read, never as a changed tool (T3368).
 */
export async function shipToolStartRefusal(git, kit, config, pin, sleep) {
    for (let reads = 1;; reads += 1) {
        const read = startReadOf(git, kit, config, pin);
        if (read.ok) {
            return read.value;
        }
        if (reads >= SHIP_TOOL_READS) {
            return `could not read the checkout of the ship tool ${pin.tool}, so the step did not run: ${read.reason}, at each of ${reads} reads ${SHIP_TOOL_REREAD_MS / 1000} s apart; git gave no answer, which says nothing of the tool, so queue the step again once git answers on this host`;
        }
        await sleep(SHIP_TOOL_REREAD_MS);
    }
}
/** One read of {@link shipToolStartRefusal}: why the step may not run (undefined: it may), or which read did not answer. */
function startReadOf(git, kit, config, pin) {
    const state = shipToolStateOf(git, kit, config, pin.tool);
    if (!state.ok) {
        return state;
    }
    const { head, landed } = state.value;
    if (head === undefined) {
        return { ok: true, value: staleToolReason(pin.tool, state.value, pin.head === undefined ? '' : ` changed from ${pin.head.slice(0, 9)} while the step waited and`) };
    }
    const remote = remoteHeadOf(git, state.value);
    if (!remote.ok || remote.value.refused !== undefined) {
        return remote.ok ? { ok: true, value: remote.value.refused } : remote;
    }
    // The checkout makes the local ref's tree, and that ref is the remote's head: main's current code.
    if (landed && remote.value.local === remote.value.head) {
        return { ok: true, value: undefined };
    }
    // Moved while it waited: only forward from its pin, the code it runs the same as at its pin (T3419).
    const sincePin = pin.head === undefined ? undefined : head === pin.head ? [] : toolCodeChangeOf(git, state.value, pin.tool, pin.head, head);
    const sinceRemote = toolCodeChangeOf(git, state.value, pin.tool, head, remote.value.head);
    if (sincePin !== undefined && sinceRemote !== undefined && sincePin.length === 0 && sinceRemote.length === 0) {
        return { ok: true, value: undefined };
    }
    const changed = sincePin === undefined || sinceRemote === undefined ? undefined : [...new Set([...sincePin, ...sinceRemote])].sort();
    const files = changed === undefined ? '' : ` (${changed.slice(0, 5).join(', ')}${changed.length > 5 ? `, and ${changed.length - 5} more` : ''})`;
    const since = pin.head === undefined ? '' : head === pin.head ? ` at ${pin.head.slice(0, 9)}${files}` : ` changed from ${pin.head.slice(0, 9)} while the step waited${files} and`;
    return { ok: true, value: staleToolReason(pin.tool, state.value, since) };
}
/** The owner of task `task` in the team's register. */
async function ownerOf(runtime, kit, task) {
    return (await new JsonlEventLog(runtime.files, kit.paths.events).read()).state.tasks.get(task)?.owner;
}
/**
 * What a release merge acts on, `release T<id>`, when `holder` may run it: the line names the repository's main checkout
 * and a release task the holder owns, matching the queue's `--task` when it names one (C4), and the tool is main's
 * current code (C5); undefined otherwise.
 */
async function releaseTargetOf(runtime, kit, repo, holder, run, release) {
    if (!samePath(run.worktree, repo.mainDir) || (run.task !== undefined && run.task !== release) || run.files.length > 0) {
        return undefined;
    }
    if ((await ownerOf(runtime, kit, release)) !== holder) {
        return undefined;
    }
    return toolIsLanded(runtime.mergeGit, run.tool, repo.mainDir) ? `release ${release}` : undefined;
}
/**
 * The branch a ship call runs on, or a release merge's `release T<id>`, when `holder` may run it (C4, C5 above);
 * undefined otherwise, so the permission check decides. The register is read only after the line's places pass, and
 * git last.
 */
export async function shipBranchOf(runtime, kit, config, holder, run) {
    const repo = shipRepoOf(kit, config, run.tool);
    if (repo !== undefined && run.release !== undefined) {
        return releaseTargetOf(runtime, kit, repo, holder, run, run.release);
    }
    // With no folder set the worktree must sit where the host makes its own; where the host names none, nothing proves the place, so the permission check decides.
    const worktrees = repo === undefined ? undefined : worktreeFolderOf(runtime, repo.mainDir, repo.config.worktreeFolder);
    if (repo === undefined || worktrees === undefined || !isInside(run.worktree, worktrees)) {
        return undefined;
    }
    const git = runtime.mergeGit;
    const checkout = git.checkoutOf(run.worktree);
    const branch = checkout?.branch;
    const task = branch === undefined ? undefined : taskBranchOf(branch, config.pushGuard.protectedBranches);
    if (checkout === undefined || !checkout.linked || !samePath(checkout.top, run.worktree) || task === undefined || (run.task !== undefined && run.task !== task)) {
        return undefined;
    }
    const owner = await ownerOf(runtime, kit, task);
    const folder = taskFolder(kit.paths.kitHome, kit.paths.team, task);
    if (owner !== holder || !run.files.every((file) => isInside(file, folder))) {
        return undefined;
    }
    return sameRepository(git, run.worktree, repo.mainDir) && toolIsLanded(git, run.tool, repo.mainDir) ? branch : undefined;
}
