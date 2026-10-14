import { posix, win32 } from 'node:path';
const PROGRAM = 'claude';
const WINDOWS_EXTENSIONS = '.COM;.EXE;.BAT;.CMD';
const SCRIPT = /\.[cm]?js$/i;
/** npm's cmd-shim ends by running `"%dp0%\<target>" %*`: the target, beside the shim. */
const SHIM_TARGET = /"%~?dp0%?\\([^"\r\n]+)"\s+%\*/g;
/** A variable by name; Windows names ignore case (`Path`, `PATH`). */
function variable(env, name, platform) {
    if (platform !== 'win32') {
        return env[name];
    }
    const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === name);
    return key === undefined ? undefined : env[key];
}
function listOf(value, delimiter) {
    return (value ?? '').split(delimiter).flatMap((part) => {
        const trimmed = part.trim().replace(/^"(.*)"$/, '$1');
        return trimmed === '' ? [] : [trimmed];
    });
}
/**
 * The program an npm `claude.cmd` shim runs. Node.js starts a `.cmd` only through cmd.exe, which would
 * read the prompt as cmd syntax, so the shim's own target is started instead: a script with Node.js,
 * or a program directly.
 */
async function shimProgram(deps, shim) {
    const text = await deps.files.read(shim);
    const target = [...(text ?? '').matchAll(SHIM_TARGET)].at(-1)?.[1];
    if (target === undefined) {
        return `${shim} is not an npm launcher`;
    }
    const path = win32.join(win32.dirname(shim), target);
    if ((await deps.probe.kind(path)) !== 'file') {
        return `${shim} starts ${path}, which is not there`;
    }
    if (SCRIPT.test(path)) {
        return { command: deps.node, prefix: [path] };
    }
    return /\.exe$/i.test(path) ? { command: path, prefix: [] } : `${shim} starts ${path}, which is neither a script nor a program`;
}
async function windowsSearch(deps) {
    const extensions = listOf(variable(deps.env, 'PATHEXT', 'win32') ?? WINDOWS_EXTENSIONS, ';').map((extension) => extension.toLowerCase());
    const skipped = [];
    for (const folder of listOf(variable(deps.env, 'PATH', 'win32'), ';')) {
        for (const extension of extensions) {
            const path = win32.join(folder, `${PROGRAM}${extension}`);
            if ((await deps.probe.kind(path)) !== 'file') {
                continue;
            }
            if (extension === '.exe' || extension === '.com') {
                return { kind: 'found', program: { command: path, prefix: [] } };
            }
            if (extension === '.cmd' || extension === '.bat') {
                const program = await shimProgram(deps, path);
                if (typeof program !== 'string') {
                    return { kind: 'found', program };
                }
                skipped.push(program);
            }
        }
    }
    return { kind: 'missing', skipped };
}
async function posixSearch(deps) {
    for (const folder of listOf(variable(deps.env, 'PATH', deps.platform), ':')) {
        const path = posix.join(folder, PROGRAM);
        if ((await deps.probe.kind(path)) === 'file') {
            return { kind: 'found', program: { command: path, prefix: [] } };
        }
    }
    return { kind: 'missing', skipped: [] };
}
/** Claude Code on PATH, the way a shell finds it: the native `claude.exe`, an npm shim, or `claude`. */
export function findClaude(deps) {
    return deps.platform === 'win32' ? windowsSearch(deps) : posixSearch(deps);
}
