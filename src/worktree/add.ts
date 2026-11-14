import { join } from 'node:path';
import type { Env } from '../core/home.ts';
import { hookEndText, succeeded, type HookRunner } from '../deploy/hooks.ts';
import type { WorktreeFiles } from './files.ts';
import type { WorktreeGit } from './git.ts';
import { branchNameProblem } from './branch-name.ts';

/**
 * `teamrig worktree add`: a session's new worktree, made the same way every time. The new branch starts from the
 * remote's newest default branch, fetched first, in a folder named after the branch, and the repository's setup
 * (such as a link to the main checkout's node_modules) runs in it. Every check runs before anything changes: a name
 * that is no branch name, a folder already there, no default branch to start from, a branch that already exists. A
 * setup that fails leaves the worktree in place, as its owner may finish it by hand.
 */

/** The variable a setup reads the main checkout's folder from, as it runs without a shell to expand one. */
export const MAIN_CHECKOUT_ENV = 'TEAMRIG_MAIN_CHECKOUT';
/** Long enough for a setup that installs packages; past it the setup is killed with every process it started. */
const SETUP_TIMEOUT_MS = 10 * 60_000;

export interface AddRequest {
  /** The new branch, such as `t12-parser`; its folder is its name with each `/` as `-`. */
  readonly branch: string;
  /** The repository's main checkout, where git runs. */
  readonly mainDir: string;
  /** The folder the worktree's own folder goes in. */
  readonly folder: string;
  /** The program and arguments run in the new worktree; undefined runs nothing. */
  readonly setup: readonly string[] | undefined;
  readonly env: Env;
}

export interface AddPorts {
  readonly git: WorktreeGit;
  readonly files: WorktreeFiles;
  readonly hooks: HookRunner;
}

export type AddEnd =
  | { readonly kind: 'added'; readonly path: string }
  | { readonly kind: 'refused'; readonly reason: string }
  | { readonly kind: 'failed'; readonly reason: string };

/** Makes the worktree, says each step done, and runs the setup in it. */
export async function createWorktree(request: AddRequest, ports: AddPorts, say: (line: string) => void): Promise<AddEnd> {
  const { branch, mainDir, setup } = request;
  const problem = branchNameProblem(branch);
  if (problem !== undefined) {
    return refused(`"${branch}": ${problem}`);
  }
  const path = join(request.folder, branch.replaceAll('/', '-'));
  if ((await ports.files.kindOf(path)) !== 'missing') {
    return refused(`${path} is already there: give another branch name, or move what is there first`);
  }
  const base = ports.git.defaultBase(mainDir);
  const from = base === undefined ? undefined : remoteBranch(base);
  if (base === undefined || from === undefined) {
    return refused(`origin/HEAD in ${mainDir} names no default branch to start from: run git remote set-head origin --auto there`);
  }
  const exists = ports.git.hasBranch(mainDir, branch);
  if (exists !== false) {
    return refused(exists === true ? `branch ${branch} already exists in ${mainDir}: give a new branch name` : `git could not tell whether branch ${branch} exists in ${mainDir}`);
  }
  const fetched = ports.git.fetch(mainDir, from.remote, from.branch);
  if (!fetched.ok) {
    return { kind: 'failed', reason: `git fetch ${from.remote} ${from.branch} in ${mainDir}: ${fetched.reason}; nothing was made` };
  }
  const added = ports.git.addWorktree(mainDir, path, branch, base);
  if (!added.ok) {
    return { kind: 'failed', reason: `git worktree add in ${mainDir}: ${added.reason}` };
  }
  say(`added the worktree ${path} on the new branch ${branch}, from ${base} as just fetched`);
  if (setup === undefined) {
    return { kind: 'added', path };
  }
  const end = await ports.hooks.run({ argv: setup, cwd: path, env: { ...request.env, [MAIN_CHECKOUT_ENV]: mainDir }, timeoutMs: SETUP_TIMEOUT_MS, onLine: say });
  if (!succeeded(end)) {
    return {
      kind: 'failed',
      reason: `its setup ${setup.join(' ')} ${hookEndText(end)}; the worktree stays at ${path}: finish its setup by hand, or teamrig worktree remove ${path} --delete-branch`,
    };
  }
  say(`ran its setup ${setup.join(' ')}`);
  return { kind: 'added', path };
}

function refused(reason: string): AddEnd {
  return { kind: 'refused', reason };
}

/** `origin/main` as the remote `origin` and its branch `main`; undefined for a name with no remote or no branch. */
function remoteBranch(base: string): { readonly remote: string; readonly branch: string } | undefined {
  const slash = base.indexOf('/');
  return slash <= 0 || slash === base.length - 1 ? undefined : { remote: base.slice(0, slash), branch: base.slice(slash + 1) };
}
