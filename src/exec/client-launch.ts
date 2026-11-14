import { posix, win32 } from 'node:path';
import { envVariable, pathList, type PathSearchDeps } from '../core/path-search.ts';
import { bashDrivePath, resolveDir } from '../push-guard/location.ts';
import type { ShellDialect } from '../push-guard/tokenizer.ts';

/**
 * Which teamrig client a line's call starts (T803). The exec guard runs `teamrig exec` only through an install of
 * this plugin, and a program word names one only once it is placed as the line's shell places it: a path from the
 * folder the program starts in, a bare name by the shell's own PATH search, which an agent's `~/bin/teamrig` wins.
 */

/** The launcher a bash line starts, from a plugin root. */
export const BASH_LAUNCHER = 'bin/teamrig';

/** The files of a plugin root a call may start its client by, from that root: its launchers and its CLI entry. */
export const CLIENT_ENTRIES: readonly string[] = [BASH_LAUNCHER, 'bin/teamrig.cmd', 'dist/cli/main.js'];

/** A version folder of the plugin cache, such as `0.155.1`. */
const VERSION_FOLDER = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

/** The extensions cmd and PowerShell append to a bare name on Windows when PATHEXT is not set. */
const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';

/** Where a program word or script word puts the client file, as far as the line tells. */
export type ClientFile =
  /** A file the line names by its path (`written`), or the first the shell finds on its PATH (`found`). */
  | { readonly kind: 'file'; readonly path: string; readonly by: 'written' | 'found' }
  /** A bare name no folder the guard can see has: the shell runs the plugin bin Claude Code appends to the Bash tool's PATH. */
  | { readonly kind: 'appended' }
  /** A relative path from a folder only known when the line runs. */
  | { readonly kind: 'unplaced' };

/** Where a word is read: the dialect of its script, the folder its program starts in (undefined when only known when it runs), and the home folder. */
export interface WordAt {
  readonly dialect: ShellDialect;
  readonly dir: string | undefined;
  readonly home: string;
}

/** The file a shell starts for a bare program name: the first its PATH search finds, or undefined when the guard sees none. */
export interface ClientSearch {
  find(name: string, at: WordAt): Promise<string | undefined>;
}

/** The client file a program word starts: a word with a folder in it is a path, a bare name is looked up as the shell looks it up. */
export async function placeProgram(word: string, at: WordAt, search: ClientSearch): Promise<ClientFile> {
  if (/[\\/]/.test(word)) {
    return placeScript(word, at);
  }
  const found = await search.find(word, at);
  return found === undefined ? { kind: 'appended' } : { kind: 'file', path: found, by: 'found' };
}

/** The client file a script word names (`node <plugin>/dist/cli/main.js`): a path, from the program's folder when relative. */
export function placeScript(word: string, at: WordAt): ClientFile {
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
export class ShellPathSearch implements ClientSearch {
  private readonly deps: PathSearchDeps;

  constructor(deps: PathSearchDeps) {
    this.deps = deps;
  }

  async find(name: string, at: WordAt): Promise<string | undefined> {
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
  private leadingFolders(at: WordAt, rules: typeof posix): string[] {
    if (at.dialect === 'bash') {
      return [rules.join(at.home, 'bin')];
    }
    return at.dialect === 'cmd' && at.dir !== undefined ? [at.dir] : [];
  }

  /** The file names a shell tries for a name in each folder, in its order. */
  private namesOf(name: string, dialect: ShellDialect): string[] {
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
  readonly install: string;
  private readonly platform: NodeJS.Platform;

  constructor(install: string, platform: NodeJS.Platform) {
    this.platform = platform;
    this.install = this.normal(install);
  }

  /** The install root a client file is an entry of (`CLIENT_ENTRIES`), or undefined when it is no entry of an install of this plugin. */
  rootOf(file: string): string | undefined {
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
  isOwn(root: string): boolean {
    return this.key(this.normal(root)) === this.key(this.install);
  }

  /** True when `file` is the bash launcher of the install the hook runs from: no other version, no other entry. */
  isOwnLauncher(file: string): boolean {
    return this.key(this.normal(file)) === this.key(`${this.install}/${BASH_LAUNCHER}`);
  }

  private installed(root: string): boolean {
    if (this.isOwn(root)) {
      return true;
    }
    const versioned = (path: string): boolean => VERSION_FOLDER.test(posix.basename(path));
    return versioned(this.install) && versioned(root) && this.key(posix.dirname(root)) === this.key(posix.dirname(this.install));
  }

  /** A path with `/`, its `.` and `..` parts resolved, and no trailing `/`. */
  private normal(path: string): string {
    const normal = posix.normalize(path.replaceAll('\\', '/'));
    return normal.length > 1 && normal.endsWith('/') && !/^[A-Za-z]:\/$/.test(normal) ? normal.slice(0, -1) : normal;
  }

  /** What two paths compare by: Windows paths ignore case. */
  private key(path: string): string {
    return this.platform === 'win32' ? path.toLowerCase() : path;
  }
}
