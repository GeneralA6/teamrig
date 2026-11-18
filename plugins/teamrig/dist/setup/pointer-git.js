import { basename, dirname, resolve } from 'node:path';
import { runGit } from "../core/git-run.js";
/**
 * git's own exit code in `dir`; undefined when git gave no answer of its own (it did not start, or the kit's query
 * timeout stopped it on a loaded host), which must never read as its "no".
 */
function gitStatus(run, dir, args) {
    const result = run(dir, args);
    return result.unanswered === undefined && result.status !== null ? result.status : undefined;
}
/** The repository's exclude file, as git in `dir` resolves it (a linked worktree shares its main checkout's); undefined outside a repository. */
function excludeFile(run, dir) {
    const result = run(dir, ['rev-parse', '--git-path', 'info/exclude']);
    const path = result.unanswered === undefined && result.status === 0 ? result.stdout.trim() : '';
    // git prints it relative to `dir`, or absolute for a linked worktree.
    return path === '' ? undefined : resolve(dir, path);
}
/**
 * Pointer state from the git CLI: committed (git's ls-files exits 0), ignored (check-ignore exits 0) or neither (both
 * exit 1); any other result, no answer included, reads as no-git, since git could not tell. A trim decides from this
 * which settings.json is the person's own to rewrite (#837), so a git that could not tell must never read as "not
 * tracked".
 */
export function pointerGitWith(run) {
    return {
        state(path) {
            const dir = dirname(path);
            const name = basename(path);
            const exclude = excludeFile(run, dir);
            if (exclude === undefined) {
                return { kind: 'no-git' };
            }
            switch (gitStatus(run, dir, ['ls-files', '--error-unmatch', '--', name])) {
                case 0:
                    return { kind: 'tracked' };
                case 1:
                    break;
                default:
                    return { kind: 'no-git' };
            }
            switch (gitStatus(run, dir, ['check-ignore', '-q', '--', name])) {
                case 0:
                    return { kind: 'ignored' };
                case 1:
                    return { kind: 'open', exclude };
                default:
                    return { kind: 'no-git' };
            }
        },
    };
}
/**
 * The pointer port on the kit's git runner, so git reads the repository `path` is in, never one a caller's git hook
 * names in GIT_DIR, and waits as long as every other git query.
 */
export const GIT_POINTER = pointerGitWith((dir, args) => runGit(dir, args));
