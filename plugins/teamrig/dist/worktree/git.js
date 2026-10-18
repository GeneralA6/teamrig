import { outcome, query, queryLine, runGit } from "../core/git-run.js";
/** Long enough for git to delete a large worktree. */
const REMOVE_TIMEOUT_MS = 120_000;
const BRANCH_REF = 'refs/heads/';
/** NUL-separated fields, without the empty one after the last NUL. */
function fields(text) {
    return text.split('\0').filter((field) => field !== '');
}
/** A path git reads as written: no glob, no magic of its own. */
function literal(path) {
    return `:(literal)${path}`;
}
/** The output of `git worktree list --porcelain`: one block per worktree, a blank line between blocks. */
export function parseWorktreeList(text) {
    const entries = [];
    for (const block of text.replaceAll('\r\n', '\n').split('\n\n')) {
        const lines = block.split('\n');
        const path = lines.find((line) => line.startsWith('worktree '))?.slice('worktree '.length);
        if (path === undefined) {
            continue;
        }
        const branchRef = lines.find((line) => line.startsWith('branch '))?.slice('branch '.length);
        const lockLine = lines.find((line) => line === 'locked' || line.startsWith('locked '));
        entries.push({
            path,
            branch: branchRef?.startsWith(BRANCH_REF) === true ? branchRef.slice(BRANCH_REF.length) : undefined,
            locked: lockLine === undefined ? undefined : lockLine.slice('locked'.length).trim(),
        });
    }
    return entries;
}
/**
 * The paths of `git status --porcelain=v1 -z`: each entry is `XY path`, and a rename or copy adds its source as
 * the next field, which names the same change and is skipped.
 */
export function parseStatus(text) {
    const paths = [];
    const parts = fields(text);
    for (let index = 0; index < parts.length; index += 1) {
        const entry = parts[index] ?? '';
        paths.push(entry.slice(3));
        if (/^[RC]|^.[RC]/.test(entry)) {
            index += 1;
        }
    }
    return paths;
}
/** The git CLI. */
export const GIT_WORKTREES = {
    topOf: (dir) => queryLine(dir, ['rev-parse', '--show-toplevel']),
    worktrees(dir) {
        const text = query(dir, ['worktree', 'list', '--porcelain']);
        return text === undefined ? undefined : parseWorktreeList(text);
    },
    changes(top, excluded) {
        const pathspecs = ['.', ...excluded.map((path) => `:(exclude,literal)${path}`)];
        const text = query(top, ['status', '--porcelain=v1', '-z', '--untracked-files=normal', '--', ...pathspecs]);
        return text === undefined ? undefined : parseStatus(text);
    },
    tracked(top, paths) {
        if (paths.length === 0) {
            return [];
        }
        const text = query(top, ['ls-files', '-z', '--', ...paths.map(literal)]);
        return text === undefined ? undefined : fields(text);
    },
    defaultBase: (dir) => queryLine(dir, ['symbolic-ref', '--short', '-q', 'refs/remotes/origin/HEAD']),
    commitsNotOn(dir, branch, base) {
        const ref = `${BRANCH_REF}${branch}`;
        // Both must name a commit; the caller refuses a base that starts with `-`, which git would read as an option.
        if (queryLine(dir, ['rev-parse', '--verify', '-q', `${ref}^{commit}`]) === undefined || queryLine(dir, ['rev-parse', '--verify', '-q', `${base}^{commit}`]) === undefined) {
            return undefined;
        }
        // Exit 0: base holds the branch tip; 1: it does not; anything else: git could not tell.
        const ancestor = runGit(dir, ['merge-base', '--is-ancestor', ref, base]).status;
        if (ancestor === 0) {
            return 0;
        }
        if (ancestor !== 1) {
            return undefined;
        }
        // `git cherry` marks each commit of the branch `-` when base has an equal change (same patch id), else `+`.
        const cherry = query(dir, ['cherry', base, ref]);
        return cherry === undefined ? undefined : cherry.split('\n').filter((line) => line.startsWith('+')).length;
    },
    removeWorktree: (mainDir, top) => outcome(runGit(mainDir, ['worktree', 'remove', top], REMOVE_TIMEOUT_MS), 'git worktree remove'),
    // A branch name never starts with `-` (git refuses one), so it cannot read as an option.
    deleteBranch: (mainDir, branch) => outcome(runGit(mainDir, ['branch', '-D', branch]), 'git branch -D'),
};
