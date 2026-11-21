import { resolve } from 'node:path';
import { pathsIfKnown } from "./host.js";
/**
 * Where a repository's worktrees are made: its `worktreeFolder`, a relative one counted from the main checkout; with
 * none set, where the host makes its own for that checkout. Undefined with none set on a host whose folders teamrig
 * does not know: a default the host does not share would put the worktrees where its own tools never look, so each
 * caller says what it does without one.
 */
export function worktreeFolderOf(runtime, mainCheckout, configured) {
    const mainDir = resolve(mainCheckout);
    return configured === undefined ? pathsIfKnown(runtime)?.worktrees(mainDir) : resolve(mainDir, configured);
}
