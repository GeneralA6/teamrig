import { join } from 'node:path';
import { hookEndText, succeeded } from "../deploy/hooks.js";
import { branchNameProblem } from "./branch-name.js";
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
/** Makes the worktree, says each step done, and runs the setup in it. */
export async function createWorktree(request, ports, say) {
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
function refused(reason) {
    return { kind: 'refused', reason };
}
/** `origin/main` as the remote `origin` and its branch `main`; undefined for a name with no remote or no branch. */
function remoteBranch(base) {
    const slash = base.indexOf('/');
    return slash <= 0 || slash === base.length - 1 ? undefined : { remote: base.slice(0, slash), branch: base.slice(slash + 1) };
}
