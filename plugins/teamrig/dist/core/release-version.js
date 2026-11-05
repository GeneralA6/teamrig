const RELEASE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
/** Parses MAJOR.MINOR.PATCH, with no pre-release or build part; anything else is no version. */
export function parseVersion(text) {
    const match = RELEASE.exec(text);
    if (match === null) {
        return undefined;
    }
    const [, major = '', minor = '', patch = ''] = match;
    return { major: Number(major), minor: Number(minor), patch: Number(patch) };
}
/** Negative when `a` comes before `b`, zero when they are the same release, positive after. */
export function compareVersions(a, b) {
    return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}
