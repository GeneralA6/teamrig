import { dirname, join, relative, sep } from 'node:path';
import { errorMessage } from '../core/guards.ts';
import type { WorktreeFiles } from './files.ts';
import type { WorktreeEntry, WorktreeGit } from './git.ts';

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
 */

const MODULES = 'node_modules';
/** How many changed paths a refusal names before it says how many more. */
const NAMED_CHANGES = 5;

export interface RemovalRequest {
  /** The worktree's top folder, as given. */
  readonly path: string;
  /** Where the command runs: refused inside the worktree, as Windows cannot delete a folder a program runs in. */
  readonly cwd: string;
  /** Delete the worktree's branch too, once every commit of it is on `base`. */
  readonly deleteBranch: boolean;
  /** The branch the worktree's branch merges into; default the one `origin/HEAD` names. */
  readonly base: string | undefined;
}

export interface WorktreePorts {
  readonly git: WorktreeGit;
  readonly files: WorktreeFiles;
}

/** A link in the worktree that goes before git runs, and what its target held, to show it untouched after. */
export interface PlannedLink {
  readonly path: string;
  /** Its path in the worktree, `/`-separated, as git names it. */
  readonly name: string;
  readonly target: string;
  /** The entries in its target before the removal; undefined when the target is missing. */
  readonly targetEntries: number | undefined;
}

export interface RemovalPlan {
  /** The worktree's top folder, as git spells it. */
  readonly top: string;
  /** The main checkout (a bare repository's folder for one), where git runs. */
  readonly mainDir: string;
  readonly links: readonly PlannedLink[];
  /** The branch to delete and the base that holds all of it; undefined to keep the branch. */
  readonly branch: { readonly name: string; readonly base: string } | undefined;
  /** The branch checked out in the worktree, which tells whose it is (owner.ts); undefined on a detached HEAD. */
  readonly onBranch: string | undefined;
  /**
   * On a detached HEAD, the default branch (the one `origin/HEAD` names) that holds every commit of it as of the last
   * fetch, by ancestry or as the same patches under new ids; undefined on a branch, when it holds not all, or when git
   * cannot tell. `teamrig merge` leaves the worktree it merged from so (T1856), which tells owner.ts it holds nothing to lose.
   */
  readonly mergedInto: string | undefined;
}

export type RemovalDecision = { readonly kind: 'ready'; readonly plan: RemovalPlan } | { readonly kind: 'refused'; readonly reason: string };

function refused(reason: string): RemovalDecision {
  return { kind: 'refused', reason };
}

/** A path under `top` as git names it: relative and `/`-separated. */
function gitName(top: string, path: string): string {
  return relative(top, path).split(sep).join('/');
}

/** Whether `inner` is `outer` or a path inside it; both canonical. */
function within(inner: string, outer: string): boolean {
  return inner === outer || inner.startsWith(outer.endsWith(sep) ? outer : `${outer}${sep}`);
}

interface TreeScan {
  readonly links: readonly string[];
  /** Real `node_modules` folders, which are never walked into. */
  readonly moduleFolders: readonly string[];
}

/** Every link in the worktree and every real `node_modules` folder, walking real folders only and skipping `.git`. */
async function scanTree(files: WorktreeFiles, top: string): Promise<TreeScan> {
  const links: string[] = [];
  const moduleFolders: string[] = [];
  const folders = [top];
  for (let folder = folders.pop(); folder !== undefined; folder = folders.pop()) {
    for (const entry of await files.entries(folder)) {
      const path = join(folder, entry.name);
      if (entry.name === '.git') {
        continue;
      }
      if (entry.kind === 'link') {
        links.push(path);
      } else if (entry.kind === 'folder') {
        (entry.name === MODULES ? moduleFolders : folders).push(path);
      }
    }
  }
  return { links: links.sort(), moduleFolders: moduleFolders.sort() };
}

/** The worktree git lists at the folder `canonicalTop`, compared by canonical spelling. */
async function entryAt(files: WorktreeFiles, entries: readonly WorktreeEntry[], canonicalTop: string): Promise<WorktreeEntry | undefined> {
  for (const entry of entries) {
    if ((await files.canonical(entry.path)) === canonicalTop) {
      return entry;
    }
  }
  return undefined;
}

function describeChanges(changes: readonly string[]): string {
  const named = changes.slice(0, NAMED_CHANGES).join(', ');
  return changes.length > NAMED_CHANGES ? `${named} and ${changes.length - NAMED_CHANGES} more` : named;
}

/** The branch step: which branch goes and the base that holds every commit of it, or why it may not go. */
function planBranch(git: WorktreeGit, request: RemovalRequest, top: string, branch: string | undefined): { readonly name: string; readonly base: string } | string {
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
function detachedMergedInto(git: WorktreeGit, top: string): string | undefined {
  const base = git.defaultBase(top);
  return base !== undefined && git.headCommitsNotOn(top, base) === 0 ? base : undefined;
}

/** Every check, before anything changes: the plan to carry out, or the reason to refuse. */
export async function planRemoval(request: RemovalRequest, ports: WorktreePorts): Promise<RemovalDecision> {
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
  const holdsTracked = (name: string): boolean => tracked.some((file) => file.startsWith(`${name}/`));
  const realModules = moduleNames.find((name) => !holdsTracked(name));
  if (realModules !== undefined) {
    return refused(
      `${realModules} in ${top} is a real folder, not a link: removing the worktree would delete it. ` +
        'Check it holds only this worktree\'s own packages, delete it yourself, then run this again',
    );
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

  let branch: RemovalPlan['branch'];
  if (request.deleteBranch) {
    const planned = planBranch(git, request, top, mine.branch);
    if (typeof planned === 'string') {
      return refused(planned);
    }
    branch = planned;
  }
  const links: PlannedLink[] = [];
  for (const [index, link] of untracked.entries()) {
    const target = await files.linkTarget(link);
    links.push({ path: link, name: untrackedNames[index] ?? link, target, targetEntries: await files.entryCount(target) });
  }
  const mergedInto = mine.branch === undefined ? detachedMergedInto(git, top) : undefined;
  return { kind: 'ready', plan: { top, mainDir: main.path, links, branch, onBranch: mine.branch, mergedInto } };
}

function entriesText(count: number | undefined): string {
  return count === undefined ? 'missing' : `${count} ${count === 1 ? 'entry' : 'entries'}`;
}

/** What a dry run would do, one line per step. */
export function describePlan(plan: RemovalPlan): string[] {
  return [
    ...plan.links.map((link) => `would unlink ${link.name} (the link only; its target ${link.target} holds ${entriesText(link.targetEntries)})`),
    `would remove the worktree ${plan.top}`,
    ...(plan.branch === undefined ? [] : [`would delete branch ${plan.branch.name}: every commit of it is on ${plan.branch.base}`]),
  ];
}

/** What putting back the links of a removal that failed came to. */
interface PutBack {
  /** The names of the links put back. */
  readonly back: readonly string[];
  /** Each link left gone: its name, its target and why. */
  readonly lost: readonly string[];
}

/** Why the link cannot be put back where it was; undefined once it is back. */
async function relinkFailure(files: WorktreeFiles, link: PlannedLink): Promise<string | undefined> {
  if ((await files.kindOf(dirname(link.path))) !== 'folder') {
    return 'its folder is gone';
  }
  if ((await files.kindOf(link.path)) !== 'missing') {
    return 'something else is at its path';
  }
  try {
    await files.makeLink(link.path, link.target);
  } catch (error) {
    return errorMessage(error);
  }
  return undefined;
}

/**
 * Puts back each link unlinked for a removal that then failed, so the worktree keeps its `node_modules` instead of
 * failing its next build or test run on a missing module.
 */
async function putBack(files: WorktreeFiles, links: readonly PlannedLink[], tell: (line: string) => void): Promise<PutBack> {
  const back: string[] = [];
  const lost: string[] = [];
  for (const link of links) {
    const failure = await relinkFailure(files, link);
    if (failure === undefined) {
      back.push(link.name);
      tell(`put back ${link.name} (a link to ${link.target})`);
    } else {
      lost.push(`${link.name}, a link to ${link.target}: ${failure}`);
    }
  }
  return { back, lost };
}

function putBackText({ back, lost }: PutBack): string {
  const parts = [...(back.length === 0 ? [] : [`its links are back: ${back.join(', ')}`]), ...(lost.length === 0 ? [] : [`still gone: ${lost.join('; ')}`])];
  return parts.length === 0 ? '' : ` (${parts.join('; ')})`;
}

/**
 * Whether a git removal that failed went past its point of no return: git deletes its record of the worktree even when
 * it cannot delete the folder (Windows keeps a folder a program has as its working folder), so the folder stays on
 * disk while git no longer lists it. False when the folder is gone, git still lists it, or git cannot tell.
 */
async function removedPartway(plan: RemovalPlan, ports: WorktreePorts): Promise<boolean> {
  const canonicalTop = await ports.files.canonical(plan.top);
  const worktrees = canonicalTop === undefined ? undefined : ports.git.worktrees(plan.mainDir);
  return canonicalTop !== undefined && worktrees !== undefined && (await entryAt(ports.files, worktrees, canonicalTop)) === undefined;
}

/** Tells each link's target as untouched, or throws the first that changed. */
async function proveTargets(plan: RemovalPlan, files: WorktreeFiles, tell: (line: string) => void): Promise<void> {
  for (const link of plan.links) {
    const after = await files.entryCount(link.target);
    if (after !== link.targetEntries) {
      throw new Error(`${link.target}, the target of ${link.name}, held ${entriesText(link.targetEntries)} before and ${entriesText(after)} after the removal`);
    }
    tell(`target ${link.target} untouched: ${entriesText(after)}, as before`);
  }
}

/**
 * Carries out a plan, telling each step as it is done. A link that fails its unlink or is still there after it stops
 * it before git runs; that, or a git removal that fails, first puts back every link already unlinked, unless git
 * stopped partway, past dropping its record of the worktree. A target that changed after the removal, or a branch
 * delete that fails, is thrown with what was already done.
 */
export async function carryOut(plan: RemovalPlan, ports: WorktreePorts, tell: (line: string) => void): Promise<void> {
  const { git, files } = ports;
  const unlinked: PlannedLink[] = [];
  for (const link of plan.links) {
    try {
      await files.unlinkLink(link.path);
    } catch (error) {
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
    await proveTargets(plan, files, tell);
    throw new Error(
      `git worktree remove ${plan.top} stopped partway: ${removed.reason}. git no longer lists it, and ${plan.top} is left on disk: ` +
        'a program with its working folder inside it (often a Claude Code tab started there) keeps Windows from deleting it. ' +
        `Close that program or move it out, then run teamrig worktree remove ${plan.top} again to clear what is left`,
    );
  }
  if (!removed.ok) {
    const put = await putBack(files, unlinked, tell);
    throw new Error(`git worktree remove ${plan.top}: ${removed.reason}${putBackText(put)}`);
  }
  tell(`removed the worktree ${plan.top}`);
  await proveTargets(plan, files, tell);
  if (plan.branch !== undefined) {
    const deleted = git.deleteBranch(plan.mainDir, plan.branch.name);
    if (!deleted.ok) {
      throw new Error(`the worktree is removed, but git branch -D ${plan.branch.name}: ${deleted.reason}`);
    }
    tell(`deleted branch ${plan.branch.name}: every commit of it is on ${plan.branch.base}`);
  }
}
