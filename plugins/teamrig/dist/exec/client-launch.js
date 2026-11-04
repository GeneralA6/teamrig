import { posix, win32 } from 'node:path';
import { envVariable, pathList } from "../core/path-search.js";
import { resolveDir } from "../push-guard/location.js";
import { bashDrivePath } from "../secret-guard/paths.js";
/**
 * Which teamrig client a line's call starts (T803). The exec guard runs `teamrig exec` only through an install of
 * this plugin, and a program word names one only once it is placed as the line's shell places it: a path from the
 * folder the program starts in, a bare name by the shell's own PATH search, which an agent's `~/bin/teamrig` wins.
 */
/** The launcher a bash line starts, from a plugin root. */
export const BASH_LAUNCHER = 'bin/teamrig';
/** The files of a plugin root a call may start its client by, from that root: its launchers and its CLI entry. */
export const CLIENT_ENTRIES = [BASH_LAUNCHER, 'bin/teamrig.cmd', 'dist/cli/main.js'];
/** A version folder of the plugin cache, such as `0.155.1`. */
const VERSION_FOLDER = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
/** The extensions cmd and PowerShell append to a bare name on Windows when PATHEXT is not set. */
const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';
/** The client file a program word starts: a word with a folder in it is a path, a bare name is looked up as the shell looks it up. */
export async function placeProgram(word, at, search) {
    if (/[\\/]/.test(word)) {
        return placeScript(word, at);
    }
    const found = await search.find(word, at);
    return found === undefined ? { kind: 'appended' } : { kind: 'file', path: found, by: 'found' };
}
/** The client file a script word names (`node <plugin>/dist/cli/main.js`): a path, from the program's folder when relative. */
export function placeScript(word, at) {
    const native = at.dialect === 'bash' ? bashDrivePath(word, at.home) : word;
    const path = resolveDir(at.dir, native, at.home);
    return path === undefined ? { kind: 'unplaced' } : { kind: 'file', path, by: 'written' };
}
/**
 * The PATH search of each shell, over the folders the guard can see: the hook's own PATH, which Claude Code gives its
 * hooks and its PowerShell tool alike. The Bash tool's shell puts Git Bash's folders before it (`~/bin` first, the one
 * a session can write; the others sit inside the Git install) and appends the plugin bin last, so a name no folder
 * here has is that plugin bin. cmd searches its folder before PATH; Bash on Windows tries `<name>` and `<name>.exe`.
 */
export class ShellPathSearch {
    deps;
    constructor(deps) {
        this.deps = deps;
    }
    async find(name, at) {
        const windows = this.deps.platform === 'win32';
        const rules = windows ? win32 : posix;
        const folders = [...this.leadingFolders(at, rules), ...pathList(envVariable(this.deps.env, 'PATH', this.deps.platform), windows ? ';' : ':')];
        const names = this.namesOf(name, at.dialect);
        for (const folder of folders) {
            for (const candidate of names) {
                const path = rules.join(folder, candidate);
                if ((await this.deps.probe.kind(path)) === 'file') {
                    return path;
                }
            }
        }
        return undefined;
    }
    /** The folders a shell searches before PATH. */
    leadingFolders(at, rules) {
        if (at.dialect === 'bash') {
            return [rules.join(at.home, 'bin')];
        }
        return at.dialect === 'cmd' && at.dir !== undefined ? [at.dir] : [];
    }
    /** The file names a shell tries for a name in each folder, in its order. */
    namesOf(name, dialect) {
        if (this.deps.platform !== 'win32') {
            return dialect === 'powershell' ? [`${name}.ps1`, name] : [name];
        }
        if (dialect === 'bash') {
            return [name, `${name}.exe`];
        }
        const extensions = pathList(envVariable(this.deps.env, 'PATHEXT', this.deps.platform) ?? DEFAULT_PATHEXT, ';').map((extension) => `${name}${extension.toLowerCase()}`);
        return dialect === 'powershell' ? [name, `${name}.ps1`, ...extensions] : [name, ...extensions];
    }
}
/**
 * The installs of this plugin a call may start: the one the hook runs from, and on a plugin cache the other versions
 * beside it, since a tab keeps on PATH the version it started with while its hooks reload onto the newer one.
 */
export class ClientInstalls {
    /** The plugin root the hook runs from, with `/`. */
    install;
    platform;
    constructor(install, platform) {
        this.platform = platform;
        this.install = this.normal(install);
    }
    /** The install root a client file is an entry of (`CLIENT_ENTRIES`), or undefined when it is no entry of an install of this plugin. */
    rootOf(file) {
        const path = this.normal(file);
        for (const entry of CLIENT_ENTRIES) {
            const suffix = `/${entry}`;
            if (this.key(path).endsWith(this.key(suffix))) {
                const root = path.slice(0, -suffix.length);
                return this.installed(root) ? root : undefined;
            }
        }
        return undefined;
    }
    /** True when `root` is the install the hook runs from. */
    isOwn(root) {
        return this.key(this.normal(root)) === this.key(this.install);
    }
    /** True when `file` is the bash launcher of the install the hook runs from: no other version, no other entry. */
    isOwnLauncher(file) {
        return this.key(this.normal(file)) === this.key(`${this.install}/${BASH_LAUNCHER}`);
    }
    installed(root) {
        if (this.isOwn(root)) {
            return true;
        }
        const versioned = (path) => VERSION_FOLDER.test(posix.basename(path));
        return versioned(this.install) && versioned(root) && this.key(posix.dirname(root)) === this.key(posix.dirname(this.install));
    }
    /** A path with `/`, its `.` and `..` parts resolved, and no trailing `/`. */
    normal(path) {
        const normal = posix.normalize(path.replaceAll('\\', '/'));
        return normal.length > 1 && normal.endsWith('/') && !/^[A-Za-z]:\/$/.test(normal) ? normal.slice(0, -1) : normal;
    }
    /** What two paths compare by: Windows paths ignore case. */
    key(path) {
        return this.platform === 'win32' ? path.toLowerCase() : path;
    }
}
