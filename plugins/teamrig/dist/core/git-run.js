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
/** The highest code a program's own exit gives; Windows reports a process that died starting as an NTSTATUS above it. */
const HIGHEST_EXIT_CODE = 255;
/**
 * Why git gave no answer of its own, or undefined when it ran and exited by itself (T3368): it did not start, it was
 * stopped (by the query timeout too), or it ended with a code no program's own exit gives, such as 0xC0000142 when
 * Windows cannot start one more process under load. A reader must never take such a run for git's "no".
 */
export function unansweredOf(end) {
    if (end.error !== undefined) {
        return end.error.message;
    }
    if (end.status === null) {
        return `stopped by ${end.signal ?? 'a signal'}`;
    }
    if (end.status < 0 || end.status > HIGHEST_EXIT_CODE) {
        return `ended with 0x${(end.status >>> 0).toString(16).toUpperCase()}, as a process that died starting does`;
    }
    return undefined;
}
export function runGit(dir, args, timeout = QUERY_TIMEOUT_MS) {
    const result = spawnSync('git', args, { cwd: dir, env: gitEnvironment(process.env), encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024 });
    const unanswered = unansweredOf(result);
    return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', ...(unanswered === undefined ? {} : { unanswered }) };
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
