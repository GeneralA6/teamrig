import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { QUERY_TIMEOUT_MS } from "../core/git-run.js";
import { COMMIT_FORMAT, PATCH_FLAGS, commitsOf, patchAdds } from "./git-adds.js";
import { rangeArgs } from "./push-range.js";
/** A patch or a log of a whole push takes longer than a query, within what a hook waits. */
const PATCH_TIMEOUT_MS = 60_000;
/** The most a patch or a log may print; a longer one fails the scan rather than cut it. */
const MAX_OUTPUT = 64 * 1024 * 1024;
const HEX = /^[0-9a-f]+$/;
/**
 * The git CLI in `env`, kept whole: in a git hook, GIT_DIR and GIT_INDEX_FILE name the repository and the index the
 * commit is made from (`git commit -a` stages into a temporary index), which `runGit` (core/git-run.ts) drops.
 */
export function gitSecrets(env) {
    const run = (dir, args, timeout) => {
        const result = spawnSync('git', ['-c', 'core.quotePath=false', ...args], { cwd: dir, env, encoding: 'utf8', timeout, maxBuffer: MAX_OUTPUT });
        return result.status === 0 ? result.stdout : undefined;
    };
    return {
        root: (dir) => run(dir, ['rev-parse', '--show-toplevel'], QUERY_TIMEOUT_MS)?.trim(),
        staged: (dir) => {
            const patch = run(dir, ['diff', '--cached', ...PATCH_FLAGS], PATCH_TIMEOUT_MS);
            return patch === undefined ? undefined : patchAdds(patch);
        },
        isCommit: (dir, sha) => HEX.test(sha) && run(dir, ['cat-file', '-e', `${sha}^{commit}`], QUERY_TIMEOUT_MS) !== undefined,
        // --root: a `log.showRoot` config off would print no patch for a first commit.
        commits: (dir, range) => {
            const log = run(dir, ['log', '--no-show-signature', '--root', COMMIT_FORMAT, '-p', ...PATCH_FLAGS, ...rangeArgs(range), '--'], PATCH_TIMEOUT_MS);
            return log === undefined ? undefined : commitsOf(log);
        },
        // --git-path prints the path from `dir`, a relative core.hooksPath already taken from the top folder.
        hooksDir: (dir) => {
            const path = run(dir, ['rev-parse', '--git-path', 'hooks'], QUERY_TIMEOUT_MS)?.trim();
            return path === undefined || path === '' ? undefined : resolve(dir, path);
        },
    };
}
