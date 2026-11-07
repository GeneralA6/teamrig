import { ORIGIN } from "../merge/git.js";
/**
 * How many commits of origin's default branch the checkout at `dir` lacks; undefined outside a repository, without
 * that branch, or with none to take. It reads the tracking ref and never fetches: every worktree of a repository
 * shares that ref, so any fetch there (a ship's, a merge's, a rebase's) moves it, and a start makes no network call.
 */
export function behindMain(git, dir) {
    const checkout = git.checkoutOf(dir);
    if (checkout === undefined) {
        return undefined;
    }
    const base = `${ORIGIN}/${git.defaultBranch(dir, ORIGIN)}`;
    if (git.sha(dir, base) === undefined) {
        return undefined;
    }
    const commits = git.commits(dir, 'HEAD', base).length;
    return commits === 0 ? undefined : { branch: checkout.branch, base, commits };
}
/** The `start` line for a checkout behind main: what it lacks and what to do before editing. */
export function behindLine(behind) {
    const what = behind.branch ?? 'the detached HEAD';
    return `BEHIND ${what} is ${behind.commits} commit(s) behind ${behind.base} as last fetched: rebase before you edit`;
}
