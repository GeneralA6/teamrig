import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { DEFAULT_WORKTREE_FOLDER } from '../config/defaults.ts';
import type { DeliveryRepoConfig, KitConfig } from '../config/types.ts';
import { taskFolder } from '../core/home.ts';
import { isAtOrBelow, samePath } from '../core/paths.ts';
import { teamPlace } from '../delivery/places.ts';
import { ORIGIN, type MergeGit } from '../merge/git.ts';
import { taskBranchOf } from '../permissions/route-git.ts';
import type { ShipRun } from '../permissions/ship-role-call.ts';
import { JsonlEventLog } from '../register/store.ts';
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

/** The checkout a ship tool runs from, and the commit its HEAD is at. */
interface ToolCheckout {
  readonly top: string;
  readonly head: string;
}

/** The tool's checkout when the tool is a tracked file of a checkout of the repository with no change at all; undefined otherwise. */
function cleanToolCheckout(git: MergeGit, tool: string, mainDir: string): ToolCheckout | undefined {
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
function defaultRefOf(git: MergeGit, top: string): string {
  return `${ORIGIN}/${git.defaultBranch(top, ORIGIN)}`;
}

/** True when the checkout's HEAD makes the default branch's tree: main's current code, where any past main's has another tree. */
function holdsMainsCode(git: MergeGit, top: string): boolean {
  const tree = git.treeOf(top, 'HEAD');
  return tree !== undefined && tree === git.treeOf(top, defaultRefOf(git, top));
}

/** C5: the tool is a clean, tracked file of a checkout of the repository that holds main's current code. */
function toolIsLanded(git: MergeGit, tool: string, mainDir: string): boolean {
  const checkout = cleanToolCheckout(git, tool, mainDir);
  return checkout !== undefined && holdsMainsCode(git, checkout.top);
}

/** A configured ship tool a queued step runs, and the commit its checkout was at when the step was queued (T3223). */
export interface ShipToolPin {
  readonly tool: string;
  readonly head: string;
}

/** The configured ship tool a step's words run, each word read from the step's folder; undefined when they run none. */
export function shipToolOfWords(kit: Kit, config: KitConfig, words: readonly string[], cwd: string): string | undefined {
  return words.map((word) => (isAbsolute(word) ? word : resolve(cwd, word))).find((word) => shipRepoOf(kit, config, word) !== undefined);
}

/** A stale or changed ship tool's refusal: what it is not, and how to move its checkout to the newest main. */
function staleToolReason(git: MergeGit, tool: string, since: string): string {
  const top = git.checkoutOf(dirname(tool))?.top ?? dirname(tool);
  const main = defaultRefOf(git, top);
  return `the ship tool ${tool}${since} is not ${main}'s current code in a checkout with no change: run git -C ${top} fetch -q ${ORIGIN} && git -C ${top} checkout -q --detach ${main}, then queue the step again`;
}

/**
 * Pins a ship tool a step is queued to run (T3223): it must hold main's current code as C5 reads it, so a queued ship
 * runs the same reviewed tool whether a role's allow or a person let the line through; a reason when it does not.
 */
export function shipToolPinOf(git: MergeGit, kit: Kit, config: KitConfig, tool: string): ShipToolPin | { readonly refused: string } {
  const repo = shipRepoOf(kit, config, tool);
  const checkout = repo === undefined ? undefined : cleanToolCheckout(git, tool, repo.mainDir);
  return checkout !== undefined && holdsMainsCode(git, checkout.top) ? { tool, head: checkout.head } : { refused: staleToolReason(git, tool, '') };
}

/**
 * Why a pinned ship tool may not run when its step starts, after waiting in the host lock's line; undefined when it
 * may. Its checkout must still be clean and at the pinned commit, or at main's current code if it moved on, so a
 * checkout moved to another commit while the step waited never runs that commit's tool.
 */
export function shipToolStartRefusal(git: MergeGit, kit: Kit, config: KitConfig, pin: ShipToolPin): string | undefined {
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
