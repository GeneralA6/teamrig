import { dirname, isAbsolute, posix, resolve } from 'node:path';
import { DEFAULT_WORKTREE_FOLDER } from '../config/defaults.ts';
import type { DeliveryRepoConfig, KitConfig } from '../config/types.ts';
import { taskFolder } from '../core/home.ts';
import { isAtOrBelow, samePath } from '../core/paths.ts';
import { teamPlace } from '../delivery/places.ts';
import { takesShipSlot, type StepKind } from '../delivery/process-request.ts';
import type { Sleep } from '../core/lock.ts';
import { FALLBACK_BRANCH, ORIGIN, pathInCheckout, type GitRead, type MergeGit } from '../merge/git.ts';
import { taskBranchOf } from '../permissions/route-git.ts';
import type { ShipRun } from '../permissions/ship-role-call.ts';
import { JsonlEventLog } from '../register/store.ts';
import { moduleSpecifiersOf } from './module-specifiers.ts';
import type { Kit } from './kit.ts';
import type { CliRuntime } from './runtime.ts';

/**
 * The allow's checks of a service role's ship call (T2984): the line names the tool and the places, and these prove the
 * places may be used. C4: the worktree is a linked worktree of the repository whose `shipTool` the line runs, inside its
 * worktree folder, on a task branch whose task the holder owns, and the plan and note files sit in that task's folder,
 * so a session ships only its own work. C5: the tool is a tracked file of a checkout of the same repository with no
 * change at all whose HEAD makes the default branch's tree as of the last fetch, so what runs is main's current code,
 * reviewed, never a past main's (T3223). Paths are the host's, since git and the tool open them there.
 */

/** A repository of the team's delivery config, with its main checkout as a place. */
interface ShipRepo {
  readonly mainDir: string;
  readonly config: DeliveryRepoConfig;
}

/** The repository whose configured ship tool `tool` names; undefined when none does. */
function shipRepoOf(kit: Kit, config: KitConfig, tool: string): ShipRepo | undefined {
  for (const repo of Object.values(config.delivery.repos)) {
    const mainDir = teamPlace(kit.paths, repo.mainCheckout);
    if (repo.shipTool !== undefined && samePath(resolve(mainDir, repo.shipTool), tool)) {
      return { mainDir, config: repo };
    }
  }
  return undefined;
}

/** Whether a word names a ship tool the team configured, for reading a line as a ship call. */
export function shipToolTest(kit: Kit, config: KitConfig): (word: string) => boolean {
  return (word) => shipRepoOf(kit, config, word) !== undefined;
}

/** True when `path` is a place strictly inside `folder`. */
function isInside(path: string, folder: string): boolean {
  return isAtOrBelow(path, folder) && !samePath(path, folder);
}

/** True when git reads both places as one repository. */
function sameRepository(git: MergeGit, a: string, b: string): boolean {
  const first = git.commonDir(a);
  const second = git.commonDir(b);
  return first !== undefined && second !== undefined && samePath(first, second);
}

/** What the ship tool check read of the checkout a ship tool runs from. */
interface ToolState {
  /** The checkout's top, or the tool's folder when it is in none: where the stale refusal says to move it. */
  readonly top: string;
  /** The default branch as of the checkout's last fetch, such as `origin/main`. */
  readonly mainRef: string;
  /** HEAD's commit when the tool is a tracked file of a checkout of the repository with no change at all; else undefined. */
  readonly head: string | undefined;
  /** C5: that checkout's HEAD makes the default branch's tree, main's current code, where any past main's has another tree. */
  readonly landed: boolean;
  /** The host's git when it is too old for `rev-parse --path-format`, so "in no checkout" is only its exit 128 (#1472). */
  readonly oldGit?: string;
}

/** The first git whose `rev-parse` takes `--path-format`, which every checkout read of the check runs. */
const PATH_FORMAT_GIT = { major: 2, minor: 31 } as const;

/** Whether `version`, such as `2.30.2`, is a git older than {@link PATH_FORMAT_GIT}; false when git could not tell. */
function predatesPathFormat(version: string | undefined): version is string {
  if (version === undefined) {
    return false;
  }
  const [major = 0, minor = 0] = version.split('.').map(Number);
  return major < PATH_FORMAT_GIT.major || (major === PATH_FORMAT_GIT.major && minor < PATH_FORMAT_GIT.minor);
}

/** The state of a tool in no checkout, or none of a configured repository: never main's current code. */
function toolInNoCheckout(tool: string): ToolState {
  return { top: dirname(tool), mainRef: `${ORIGIN}/${FALLBACK_BRANCH}`, head: undefined, landed: false };
}

/**
 * The tool's checkout as C5 reads it, or which git read did not answer (T3368): a git that did not start, was stopped
 * or died starting tells nothing of the tool, so it is never read as a tool that is not main's current code.
 */
function toolStateOf(git: MergeGit, tool: string, mainDir: string): GitRead<ToolState> {
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
function shipToolStateOf(git: MergeGit, kit: Kit, config: KitConfig, tool: string): GitRead<ToolState> {
  const repo = shipRepoOf(kit, config, tool);
  return repo === undefined ? { ok: true, value: toolInNoCheckout(tool) } : toolStateOf(git, tool, repo.mainDir);
}

/** C5, failing closed: the tool is a clean, tracked file of a checkout of the repository that holds main's current code. */
function toolIsLanded(git: MergeGit, tool: string, mainDir: string): boolean {
  const state = toolStateOf(git, tool, mainDir);
  return state.ok && state.value.landed;
}

/**
 * A configured ship tool a queued step runs, and the commit its checkout was at when the step was queued (T3223);
 * no commit when git did not answer then (T3368), so the step runs only from main's current code.
 */
export interface ShipToolPin {
  readonly tool: string;
  readonly head: string | undefined;
}

/** How many times the start check reads a checkout git does not answer, and how long it waits between reads (T3368). */
export const SHIP_TOOL_READS = 4;
export const SHIP_TOOL_REREAD_MS = 15_000;

/** The configured ship tool a step's words run, each word read from the step's folder; undefined when they run none. */
export function shipToolOfWords(kit: Kit, config: KitConfig, words: readonly string[], cwd: string): string | undefined {
  return words.map((word) => placeOfWord(word, cwd)).find((word) => shipRepoOf(kit, config, word) !== undefined);
}

/** A step's word as a place: as it is when absolute, else read from the step's folder `cwd`. */
function placeOfWord(word: string, cwd: string): string {
  return isAbsolute(word) ? word : resolve(cwd, word);
}

/**
 * The task a step that runs a configured ship tool ships (T3286): the one its worktree's branch names, the worktree
 * being the word after the tool (after its `merge` in the merge form), read from the step's folder. A ship line names
 * no task of its own, so its ticket takes this one's priority and class; undefined for a step that runs no ship tool
 * or a worktree on no task branch.
 */
export function shipTaskOfWords(git: MergeGit, kit: Kit, config: KitConfig, words: readonly string[], cwd: string): string | undefined {
  const [first, second] = shipToolArgsOf(kit, config, words, cwd) ?? [];
  const worktree = first === 'merge' ? second : first;
  const branch = worktree === undefined ? undefined : git.checkoutOf(placeOfWord(worktree, cwd))?.branch;
  return branch === undefined ? undefined : taskBranchOf(branch, config.pushGuard.protectedBranches);
}

/** Words that point git, gh or a shell at another place than the step's folder. */
const ELSEWHERE_WORDS: ReadonlySet<string> = new Set(['-C', '-R', '--repo', '--git-dir', '--work-tree', 'cd', 'pushd']);

/**
 * True when `word` may point the step at another repository than `own`, its folder's: an option naming a repository or
 * folder (`-C <dir>`, `-R <owner/repo>`, `--git-dir=`), an environment setting (`GIT_DIR=...`), a shell script in one
 * word, or a path whose folder lies in another repository or in none.
 */
function pointsElsewhere(git: Pick<MergeGit, 'commonDir'>, word: string, cwd: string, own: string): boolean {
  if (ELSEWHERE_WORDS.has(word) || /^-[CR]./.test(word) || /^--(repo|git-dir|work-tree)=/.test(word) || /^[A-Za-z_]\w*=/.test(word) || /[\s;&|$`]/.test(word)) {
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
 * other, the step's folder's, unless a word after the program may point it elsewhere (`pointsElsewhere`). Undefined
 * when that is in doubt, so the step holds the slot of every repository, as before.
 */
export function shipSlotRepoOf(git: Pick<MergeGit, 'commonDir'>, kit: Kit, config: KitConfig, words: readonly string[], cwd: string): string | undefined {
  const args = shipToolArgsOf(kit, config, words, cwd);
  if (args !== undefined) {
    const worktree = args[0] === 'merge' ? args[1] : args[0];
    return worktree === undefined || worktree.startsWith('-') ? undefined : git.commonDir(placeOfWord(worktree, cwd));
  }
  const own = git.commonDir(cwd);
  return own === undefined || words.slice(1).some((word) => pointsElsewhere(git, word, cwd, own)) ? undefined : own;
}

/** The words after the configured ship tool a step's words run; undefined when they run none. */
function shipToolArgsOf(kit: Kit, config: KitConfig, words: readonly string[], cwd: string): readonly string[] | undefined {
  const at = words.findIndex((word) => shipRepoOf(kit, config, placeOfWord(word, cwd)) !== undefined);
  return at < 0 ? undefined : words.slice(at + 1);
}

/**
 * Why a step that runs a configured ship tool may not run under `kind` (T3414); undefined when the kind fits it, or
 * the step runs no ship tool. A run that merges (`--merge`, or the `merge` form) moves main, so it takes the host's
 * one ship slot (process-request.ts); one that does not only commits and checks a worktree, so it is a test step,
 * run beside the others while another ship holds the slot.
 */
export function shipKindRefusal(kit: Kit, config: KitConfig, words: readonly string[], cwd: string, kind: StepKind): string | undefined {
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
export function toolRootsPath(tool: string): string {
  const extension = posix.extname(tool);
  return `${extension === '' ? tool : tool.slice(0, -extension.length)}.roots.json`;
}

/** A roots file's shape: `{ "roots": ["src/cli/main.ts", "package.json"] }`, each path from the checkout's top. */
function isRootsFile(value: unknown): value is { readonly roots: readonly string[] } {
  return typeof value === 'object' && value !== null && 'roots' in value && Array.isArray(value.roots) && value.roots.every((root) => typeof root === 'string');
}

/**
 * The roots a roots file names, as paths in the checkout; undefined when it is no JSON of that shape, or a root is
 * absolute or leaves the checkout, so the caller cannot tell what the tool runs.
 */
export function toolRootsOf(text: string): string[] | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRootsFile(value)) {
    return undefined;
  }
  const roots = value.roots.map((root) => posix.normalize(root));
  return roots.some((root) => root === '.' || root.startsWith('../') || posix.isAbsolute(root) || /^[A-Za-z]:/.test(root)) ? undefined : roots;
}

/**
 * The repository paths a module at `path` loads by a relative specifier: an import (`from './x.ts'`, `import('../y.ts')`)
 * or a file it reads beside it (`new URL('./repos.json', import.meta.url)`), so a data file the tool runs on is its code
 * too. Read from the module's code, never its comments or strings (see {@link moduleSpecifiersOf}); undefined when the
 * code cannot be read apart from its text.
 */
export function relativeImportsOf(text: string, path: string): string[] | undefined {
  const specifiers = moduleSpecifiersOf(text);
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
export function toolCodeAt(git: MergeGit, top: string, ref: string, tool: string): readonly string[] | undefined {
  const rootsPath = toolRootsPath(tool);
  const rootsRead = git.filesAt(top, ref, [rootsPath]);
  const roots = rootsRead === undefined ? undefined : toolRootsOf(rootsRead.get(rootsPath) ?? '{"roots":[]}');
  if (roots === undefined) {
    return undefined;
  }
  const seen = new Set<string>([rootsPath]);
  // One git read per level of imports, never one per file (T4035): a tool's code runs to hundreds of files, and the
  // start check of every queued ship reads it twice.
  for (let level = [tool, ...roots]; level.length > 0; ) {
    const fresh = [...new Set(level)].filter((path) => !seen.has(path));
    if (fresh.some((path) => path.startsWith('../')) || seen.size + fresh.length > TOOL_CODE_MAX_FILES) {
      return undefined;
    }
    const texts = fresh.length === 0 ? new Map<string, string>() : git.filesAt(top, ref, fresh);
    if (texts === undefined) {
      return undefined;
    }
    const next: string[] = [];
    for (const path of fresh) {
      const text = texts.get(path);
      const imports = text === undefined ? undefined : MODULE_FILE.test(path) ? relativeImportsOf(text, path) : [];
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
 * The files of the code a pinned tool runs that differ between its pin and `head`, a later commit of main's history its
 * clean checkout moved to while the step waited (T3419): none when the tool runs the same code, so a main that moved on
 * without touching it refuses no waiting ship. The code is what the tool runs at either commit, so a file it stopped
 * loading counts too. Undefined when that cannot be told (`head` off main's history or not after the pin, a read git
 * did not answer), so the step is refused as a changed tool.
 */
function toolCodeChangeOf(git: MergeGit, state: ToolState, tool: string, pinned: string, head: string): readonly string[] | undefined {
  const path = pathInCheckout(state.top, tool);
  if (path === undefined || !git.isAncestor(state.top, head, state.mainRef) || !git.isAncestor(state.top, pinned, head)) {
    return undefined;
  }
  const before = toolCodeAt(git, state.top, pinned, path);
  const after = toolCodeAt(git, state.top, head, path);
  const changed = git.changedPaths(state.top, pinned, head);
  if (before === undefined || after === undefined || changed === undefined) {
    return undefined;
  }
  return [...new Set([...before, ...after])].sort().filter((file) => changed.includes(file));
}

/** A stale or changed ship tool's refusal: what it is not, and how to move its checkout to the newest main. */
function staleToolReason(tool: string, state: ToolState, since: string): string {
  if (state.oldGit !== undefined) {
    return `the ship tool check reads ${tool}'s checkout with git rev-parse --path-format=absolute, which needs git ${PATH_FORMAT_GIT.major}.${PATH_FORMAT_GIT.minor} or newer, and this host runs git ${state.oldGit}: upgrade git, then queue the step again`;
  }
  return `the ship tool ${tool}${since} is not ${state.mainRef}'s current code in a checkout with no change: run git -C ${state.top} fetch -q ${ORIGIN} && git -C ${state.top} checkout -q --detach ${state.mainRef}, then queue the step again`;
}

/**
 * Pins a ship tool a step is queued to run (T3223): it must hold main's current code as C5 reads it, so a queued ship
 * runs the same reviewed tool whether a role's allow or a person let the line through; a reason when it does not.
 * When git did not answer, it pins no commit and the start check, which reads again, decides (T3368).
 */
export function shipToolPinOf(git: MergeGit, kit: Kit, config: KitConfig, tool: string): ShipToolPin | { readonly refused: string } {
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
 * commit while the step waited never runs other code than the one it was queued with or main's current one. A read git does not answer is
 * read again, {@link SHIP_TOOL_READS} times in all, then refused naming that read, never as a changed tool (T3368).
 */
export async function shipToolStartRefusal(git: MergeGit, kit: Kit, config: KitConfig, pin: ShipToolPin, sleep: Sleep): Promise<string | undefined> {
  for (let reads = 1; ; reads += 1) {
    const state = shipToolStateOf(git, kit, config, pin.tool);
    if (state.ok) {
      const { head, landed } = state.value;
      if (head !== undefined && (head === pin.head || landed)) {
        return undefined;
      }
      const changed = head === undefined || pin.head === undefined ? undefined : toolCodeChangeOf(git, state.value, pin.tool, pin.head, head);
      if (changed !== undefined && changed.length === 0) {
        return undefined;
      }
      const files = changed === undefined ? '' : ` (${changed.slice(0, 5).join(', ')}${changed.length > 5 ? `, and ${changed.length - 5} more` : ''})`;
      const since = pin.head === undefined ? '' : ` changed from ${pin.head.slice(0, 9)} while the step waited${files} and`;
      return staleToolReason(pin.tool, state.value, since);
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
export async function shipBranchOf(runtime: CliRuntime, kit: Kit, config: KitConfig, holder: string, run: ShipRun): Promise<string | undefined> {
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
