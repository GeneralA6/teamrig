import { posix, win32 } from 'node:path';
/** Platforms whose default filesystems (NTFS, APFS) ignore case. */
const CASE_INSENSITIVE = new Set(['win32', 'darwin']);
/**
 * One key for every spelling of a place: resolved by the platform's rules (separators, `..`, a
 * trailing slash) and lowercased where the default filesystem ignores case, so `C:\Work\` and
 * `c:/work` share a key on Windows. Lowercasing is close to, not exactly, the filesystem's own case
 * folding; ids are lowercase ASCII, so the kit's own paths never differ only beyond it.
 */
export function pathKey(path, platform = process.platform) {
    const resolved = (platform === 'win32' ? win32 : posix).resolve(path);
    return CASE_INSENSITIVE.has(platform) ? resolved.toLowerCase() : resolved;
}
/** Whether two paths name the same place on the platform (see `pathKey`). */
export function samePath(a, b, platform = process.platform) {
    return pathKey(a, platform) === pathKey(b, platform);
}
/** Whether `path` is `folder` or a place inside it, on the platform's rules (see `pathKey`). */
export function isAtOrBelow(path, folder, platform = process.platform) {
    const key = pathKey(path, platform);
    const base = pathKey(folder, platform);
    const sep = (platform === 'win32' ? win32 : posix).sep;
    return key === base || key.startsWith(base.endsWith(sep) ? base : `${base}${sep}`);
}
/**
 * The path as people write it in shared text: `~/` and forward slashes below the user's home folder, so it reads the
 * same on every machine of the same user; the resolved path elsewhere.
 */
export function homeRelative(path, userHome, platform = process.platform) {
    const paths = platform === 'win32' ? win32 : posix;
    const relative = paths.relative(userHome, path);
    if (relative === '') {
        return '~';
    }
    const outside = relative === '..' || relative.startsWith(`..${paths.sep}`) || paths.isAbsolute(relative);
    return outside ? paths.resolve(path) : `~/${relative.replaceAll('\\', '/')}`;
}
/** The path with a leading `~` (`~/`, or `~\` on Windows) read as the user's home folder; any other path as written. */
export function expandHome(path, userHome, platform = process.platform) {
    const paths = platform === 'win32' ? win32 : posix;
    if (path === '~') {
        return userHome;
    }
    const below = platform === 'win32' ? /^~[\\/]/ : /^~\//;
    return below.test(path) ? paths.join(userHome, path.slice(2)) : path;
}
