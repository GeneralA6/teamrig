import { installTouches, MANIFEST_FILE, packageFilesChange } from "./manifest.js";
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
