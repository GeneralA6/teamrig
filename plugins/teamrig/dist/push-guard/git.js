import { execFileSync } from 'node:child_process';
import { COMMIT_LOG_FORMAT, parseCommitLog } from "./commit-size.js";
/** One git run's stdout; any failure (no repository, an unknown ref, no git on PATH) reads as undefined. */
function runGit(dir, args) {
    try {
        return execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000, maxBuffer: 16 * 1024 * 1024 });
    }
    catch {
        return undefined;
    }
}
/** One git query, trimmed; an empty answer (no upstream, a detached HEAD) reads as unknown too. */
function readGit(dir, args) {
    const value = runGit(dir, args)?.trim();
    return value === '' ? undefined : value;
}
/** One config value as git in `dir` reads it: git exits 1 for a key that is not set, and fails otherwise for no git or no folder. */
function readConfig(dir, key) {
    try {
        const value = execFileSync('git', ['config', '--get', key], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000 });
        return { kind: 'set', value: value.replace(/\r?\n$/, '') };
    }
    catch (error) {
        return error instanceof Error && 'status' in error && error.status === 1 ? { kind: 'unset' } : { kind: 'unreadable' };
    }
}
/** Repository state from the git CLI. */
export const GIT_CLI = {
    // symbolic-ref names a branch before its first commit, and nothing on a detached HEAD.
    branch: (dir) => readGit(dir, ['symbolic-ref', '--short', '-q', 'HEAD']),
    // A name starting with `-` would read as an option, so it has no push target the guard can ask for.
    pushTarget: (dir, branch) => (branch?.startsWith('-') === true ? undefined : readGit(dir, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', `${branch ?? ''}@{push}`])),
    config: readConfig,
};
/** The newest commits of a range the size rule reads; older ones in a longer range go unchecked. */
export const COMMIT_LOG_MAX = 200;
/** Commits from the git CLI, with renames detected so a moved file weighs its edits, not its length. */
export const GIT_COMMIT_LOG = {
    between: (dir, base, tip) => {
        const range = `${base}..${tip}`;
        const args = ['-c', 'core.quotePath=false', 'log', '-M', '--numstat', `--format=${COMMIT_LOG_FORMAT}`, `--max-count=${COMMIT_LOG_MAX}`, '--end-of-options', range, '--'];
        const output = runGit(dir, args);
        return output === undefined ? undefined : parseCommitLog(output);
    },
};
