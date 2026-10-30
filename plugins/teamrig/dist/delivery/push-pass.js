import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { isRecord, stringField } from "../core/guards.js";
import { KIT_VERSION } from "../core/version.js";
/**
 * Git opens a push's connection before its pre-push hook runs, so checks that wait in the host lock's line keep the
 * connection idle all that time, and a host such as GitHub drops it: the push then fails with SIGPIPE after its checks
 * passed (T730: pushes lost after 11.5 and 20 minutes, while checks alone took 3-4). A wait longer than this declines
 * the push; the next push of the same tree reuses the checks' pass and goes at once.
 */
export const PRE_PUSH_MAX_WAIT_MS = 60_000;
/** How long a pass stays good for a push of the same tree; older passes are pruned whenever one is recorded. */
export const PASS_KEPT_MS = 24 * 60 * 60_000;
/** A pass's file name: its tree id, then the start of its command line's hash. */
const PASS_FILE = /^[0-9a-f]+-[0-9a-f]{16}\.json$/;
function passFolder(tree) {
    return join(tree.gitDir, 'teamrig', 'pre-push');
}
/** Where the pass of `command` on this tree is kept: checks with another command line keep their own. */
function passPath(tree, command) {
    const hash = createHash('sha256').update(command).digest('hex').slice(0, 16);
    return join(passFolder(tree), `${tree.tree}-${hash}.json`);
}
function parsePass(text) {
    let value;
    try {
        value = JSON.parse(text);
    }
    catch {
        return undefined;
    }
    if (!isRecord(value)) {
        return undefined;
    }
    const [tree, commit, command, what, passedAt, kit] = ['tree', 'commit', 'command', 'what', 'passedAt', 'kit'].map((key) => stringField(value, key));
    return tree === undefined || commit === undefined || command === undefined || what === undefined || passedAt === undefined || kit === undefined
        ? undefined
        : { tree, commit, command, what, passedAt, kit };
}
/** A pass younger than PASS_KEPT_MS; one stamped later than now is not trusted. */
function isFresh(pass, now) {
    const age = now - Date.parse(pass.passedAt);
    return age >= 0 && age < PASS_KEPT_MS;
}
/** The pass of `command` on this tree while it is fresh; undefined when there is none. */
export async function passOf(files, tree, command, now) {
    const pass = parsePass((await files.read(passPath(tree, command))) ?? '');
    return pass !== undefined && pass.tree === tree.tree && pass.command === command && isFresh(pass, now) ? pass : undefined;
}
/** Records that `command` passed on this tree, and removes the passes that are no longer fresh or cannot be read. */
export async function recordPass(files, tree, command, what, now) {
    const pass = { tree: tree.tree, commit: tree.commit, command, what, passedAt: new Date(now).toISOString(), kit: KIT_VERSION };
    await files.write(passPath(tree, command), `${JSON.stringify(pass)}\n`);
    const folder = passFolder(tree);
    for (const name of (await files.list(folder)).filter((entry) => PASS_FILE.test(entry))) {
        const path = join(folder, name);
        const kept = parsePass((await files.read(path)) ?? '');
        if (kept === undefined || !isFresh(kept, now)) {
            await files.remove(path);
        }
    }
}
