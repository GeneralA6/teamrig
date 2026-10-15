import { posix, win32 } from 'node:path';
/** The extensions Node.js appends to a bare program name on Windows, in order: `.com`, then `.exe`. */
const WINDOWS_PROGRAM_EXTENSIONS = ['.com', '.exe'];
/** A variable by name; Windows names ignore case (`Path`, `PATH`). */
export function envVariable(env, name, platform) {
    if (platform !== 'win32') {
        return env[name];
    }
    const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === name);
    return key === undefined ? undefined : env[key];
}
/** A PATH-like list split on `delimiter`, each part trimmed and unquoted, empty parts left out. */
export function pathList(value, delimiter) {
    return (value ?? '').split(delimiter).flatMap((part) => {
        const trimmed = part.trim().replace(/^"(.*)"$/, '$1');
        return trimmed === '' ? [] : [trimmed];
    });
}
/**
 * The file Node.js starts for `execFile(name)`, found as it searches PATH: on Windows `<name>.com`, then
 * `<name>.exe`, in each folder; elsewhere `<name>` in each folder. It only looks, starting nothing;
 * undefined when no folder has it.
 */
export async function findProgram(name, deps) {
    const windows = deps.platform === 'win32';
    const folders = pathList(envVariable(deps.env, 'PATH', deps.platform), windows ? ';' : ':');
    const candidates = folders.flatMap((folder) => windows ? WINDOWS_PROGRAM_EXTENSIONS.map((extension) => win32.join(folder, `${name}${extension}`)) : [posix.join(folder, name)]);
    for (const path of candidates) {
        if ((await deps.probe.kind(path)) === 'file') {
            return path;
        }
    }
    return undefined;
}
