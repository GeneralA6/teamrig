import { join } from 'node:path';
import { installTouches, LOCKFILE, MANIFEST_FILE, packageFilesChange } from "./manifest.js";
/** Names, for the dependency check, the file holding the base's package-lock.json. */
export const BASELINE_LOCK_ENV = 'TEAMRIG_BASELINE_LOCK';
/**
 * The root package files the commits `from..to` of the checkout at `dir` change in a way that needs a dependency
 * install, as `installTouches` names them: empty when none does, undefined when the range's paths could not be read.
 */
export async function rangeInstallTouches(git, dir, from, to) {
    const paths = git.changedPaths(dir, from, to);
    if (paths === undefined) {
        return undefined;
    }
    return installTouches(await packageFilesChange(paths, async (end) => git.fileAt(dir, end === 'before' ? from : to, MANIFEST_FILE)));
}
/** Runs the check with the base's package-lock.json in the file {@link BASELINE_LOCK_ENV} names, removed after however the check ends. */
export async function runDependencyCheck(ports, check) {
    const { argv, cwd, baseline, env, timeoutMs, onLine } = check;
    const file = baseline === undefined ? undefined : { path: join(check.folder, `baseline-${ports.newId()}.${LOCKFILE}`), text: baseline };
    if (file !== undefined) {
        await ports.files.write(file.path, file.text);
    }
    try {
        return await ports.hooks.run({ argv, cwd, env: { ...env, [BASELINE_LOCK_ENV]: file?.path }, timeoutMs, onLine });
    }
    finally {
        if (file !== undefined) {
            await ports.files.remove(file.path);
        }
    }
}
