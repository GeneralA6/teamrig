import { spawnSync } from 'node:child_process';
/** A query answers in well under a second. */
export const QUERY_TIMEOUT_MS = 10_000;
/**
 * Variables that point git at a repository other than the one its folder is in, as a git hook sets them. Each run
 * drops them, so git acts on the worktree the command names and never on the repository a caller's hook runs in.
 */
const REPOSITORY_VARIABLES = new Set(['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE', 'GIT_PREFIX']);
/** The process environment without the variables that redirect git. */
export function gitEnvironment(env) {
    return Object.fromEntries(Object.entries(env).filter(([name]) => !REPOSITORY_VARIABLES.has(name.toUpperCase())));
}
export function runGit(dir, args, timeout = QUERY_TIMEOUT_MS) {
    const result = spawnSync('git', args, { cwd: dir, env: gitEnvironment(process.env), encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024 });
    return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}
/** A query's stdout when git exits 0, else undefined. */
export function query(dir, args) {
    const run = runGit(dir, args);
    return run.status === 0 ? run.stdout : undefined;
}
/** A one-line query, trimmed; an empty answer reads as unknown too. */
export function queryLine(dir, args) {
    const value = query(dir, args)?.trim();
    return value === '' ? undefined : value;
}
/** A changing step's outcome: done on exit 0, else git's stderr, or the exit code when git said nothing. */
export function outcome(run, what) {
    if (run.status === 0) {
        return { ok: true };
    }
    const said = run.stderr.trim();
    return { ok: false, reason: said === '' ? `${what} exited ${run.status ?? 'without a code'}` : said };
}
