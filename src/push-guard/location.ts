import * as nodePath from 'node:path';
import type { ShellDialect, ShellWord } from './tokenizer.ts';

/** The folder state of one shell: the top-level shell, or one bash subshell. Undefined marks a folder only known when the line runs. */
interface Frame {
  /** The bash subshell this frame belongs to; undefined for the top-level shell. */
  readonly id: number | undefined;
  dir: string | undefined;
  /** The folder `cd -` returns to. */
  previous: string | undefined;
  /** The `pushd` stack, newest last. */
  stack: (string | undefined)[];
}

const CHANGE_DIR: Readonly<Record<ShellDialect, ReadonlySet<string>>> = {
  bash: new Set(['cd']),
  powershell: new Set(['cd', 'chdir', 'sl', 'set-location']),
  cmd: new Set(['cd', 'chdir']),
};
const PUSH_DIR: Readonly<Record<ShellDialect, ReadonlySet<string>>> = {
  bash: new Set(['pushd']),
  powershell: new Set(['pushd', 'push-location']),
  cmd: new Set(['pushd']),
};
const POP_DIR: Readonly<Record<ShellDialect, ReadonlySet<string>>> = {
  bash: new Set(['popd']),
  powershell: new Set(['popd', 'pop-location']),
  cmd: new Set(['popd']),
};
/** PowerShell location parameters that take a value, and the ones whose value is the target folder. */
const PS_PATH_PARAMETERS: ReadonlySet<string> = new Set(['-path', '-literalpath', '-lp', '-pspath']);
const PS_VALUED_PARAMETERS: ReadonlySet<string> = new Set(['-stackname']);

/**
 * Where a `cd` target leads from `current`; `~` is the home folder. A path with a drive letter resolves by
 * Windows rules on every host (see {@link pathRules}), any other by `host`'s, the host's own unless a test
 * names another. Undefined when `current` is unknown and the target is relative.
 */
export function resolveDir(current: string | undefined, target: string, home: string, host: nodePath.PlatformPath = nodePath): string | undefined {
  const expanded = target === '~' || /^~[\\/]/.test(target) ? pathRules(host, home).join(home, target.slice(1)) : target;
  const rules = pathRules(host, current, expanded);
  if (rules.isAbsolute(expanded)) {
    return rules.resolve(expanded);
  }
  return current === undefined ? undefined : rules.resolve(current, expanded);
}

/** A Bash path as Windows names it on a Windows host (whose home names a drive): Git Bash's `/c/x` is `C:/x`; any other path as it is. */
export function bashDrivePath(path: string, home: string): string {
  const drive = /^[A-Za-z]:/.test(home) ? /^\/([A-Za-z])(\/|$)/.exec(path) : null;
  return drive === null ? path : `${(drive[1] ?? '').toUpperCase()}:/${path.slice(drive[0].length)}`;
}

/**
 * An argument as Git Bash hands it to a Windows program such as git: MSYS turns a word naming `/c/x`, or an option's
 * `=/c/x` value, into `C:/x`, so `git -C /c/x push` runs in `C:\x` (T2764). A word only known when it runs stays as it is.
 */
export function bashNativeWord(word: ShellWord, home: string): ShellWord {
  if (word.dynamic) {
    return word;
  }
  const option = /^(--?[\w-]+=)(.*)$/s.exec(word.text);
  const text = option === null ? bashDrivePath(word.text, home) : `${option[1] ?? ''}${bashDrivePath(option[2] ?? '', home)}`;
  return text === word.text ? word : { text, dynamic: false };
}

/**
 * The rules that resolve `paths`: Windows rules when any of them names a drive, since only a Windows shell
 * writes one (so `cd /d D:\x` leads to `D:\x` on every host), and the host's rules otherwise.
 */
function pathRules(host: nodePath.PlatformPath, ...paths: readonly (string | undefined)[]): nodePath.PlatformPath {
  return paths.some((path) => driveOf(path) !== undefined) ? nodePath.win32 : host;
}

/** `dir` resolved and normalised, so a folder the line never leaves compares equal to one it returns to. */
function absoluteDir(dir: string, host: nodePath.PlatformPath): string {
  return pathRules(host, dir).resolve(dir);
}

/**
 * A folder command's target as its shell reads it: PowerShell and cmd take `\` as a separator on every host
 * (PowerShell on Linux too), while in bash it is part of a name, and Git Bash's `/c/x` is `C:/x` on Windows
 * (read as `C:\c\x`, git finds no repository there and the push guard asks, T2764).
 */
function shellPath(text: string, dialect: ShellDialect, home: string): string {
  return dialect === 'bash' ? bashDrivePath(text, home) : text.replaceAll('\\', '/');
}

/** The drive letter a Windows path names, lower case, if any. */
function driveOf(path: string | undefined): string | undefined {
  return /^([A-Za-z]):/.exec(path ?? '')?.[1]?.toLowerCase();
}

/**
 * The folder a command line's commands run in, as `cd`, `pushd`, `popd`, `Set-Location`, `Push-Location`
 * and `Pop-Location` move it. Each bash subshell (`( )`, `$( )`) gets its own copy, so a `cd` inside one never
 * moves the commands after it; a nested shell (`bash -c`) starts from a {@link child}. Every folder it gives,
 * the start folder and home included, is resolved and normalised.
 */
export class Location {
  private frames: Frame[];
  /** The folder `~` names. */
  readonly home: string;
  /** The path rules of the host the line runs on, for every path that names no drive. */
  private readonly host: nodePath.PlatformPath;

  constructor(dir: string | undefined, home: string, host: nodePath.PlatformPath = nodePath) {
    this.host = host;
    this.frames = [{ id: undefined, dir: dir === undefined ? undefined : absoluteDir(dir, host), previous: undefined, stack: [] }];
    this.home = absoluteDir(home, host);
  }

  /** The folder the next command runs in; undefined when it is only known when the line runs. */
  get dir(): string | undefined {
    return this.top.dir;
  }

  private get top(): Frame {
    const top = this.frames[this.frames.length - 1];
    if (top === undefined) {
      throw new Error('a location always keeps its top-level frame');
    }
    return top;
  }

  /** Steps into the subshells a command runs in, outermost first, leaving any subshell it is no longer in. */
  enter(subshells: readonly number[]): void {
    let shared = 0;
    while (shared < subshells.length && this.frames[shared + 1]?.id === subshells[shared]) {
      shared += 1;
    }
    this.frames = this.frames.slice(0, shared + 1);
    for (const id of subshells.slice(shared)) {
      const { dir, previous, stack } = this.top;
      this.frames.push({ id, dir, previous, stack: [...stack] });
    }
  }

  /** A location for a nested shell started here, such as `bash -c`: it starts in this folder and moves on its own. */
  child(): Location {
    return new Location(this.dir, this.home, this.host);
  }

  /** Takes on where a script run in this same shell (`eval`, `Invoke-Expression`) left its location. */
  adopt(child: Location): void {
    const [root] = child.frames;
    if (root !== undefined) {
      Object.assign(this.top, { dir: root.dir, previous: root.previous, stack: [...root.stack] });
    }
  }

  /** Moves to a folder a launcher in a `dialect` line names, such as `env -C dir` or `-WorkingDirectory dir`. */
  moveTo(target: ShellWord, dialect: ShellDialect): void {
    this.change(target.dynamic ? undefined : resolveDir(this.dir, shellPath(target.text, dialect, this.home), this.home, this.host));
  }

  /** Applies a command if it changes the folder; false for any other command. */
  apply(words: readonly ShellWord[], dialect: ShellDialect): boolean {
    const head = words[0];
    if (head === undefined || head.dynamic) {
      return false;
    }
    const name = head.text.toLowerCase();
    const args = words.slice(1);
    if (CHANGE_DIR[dialect].has(name)) {
      this.changeDir(args, dialect);
    } else if (PUSH_DIR[dialect].has(name)) {
      this.pushDir(args, dialect);
    } else if (POP_DIR[dialect].has(name)) {
      this.popDir(args, dialect);
    } else {
      return false;
    }
    return true;
  }

  private change(dir: string | undefined): void {
    const top = this.top;
    top.previous = top.dir;
    top.dir = dir;
  }

  /** The target folder of a `cd`-like command; `null` when there is none, so the command keeps or resets the folder. */
  private target(args: readonly ShellWord[], dialect: ShellDialect): ShellWord | null {
    const operands: ShellWord[] = [];
    let options = true;
    for (let index = 0; index < args.length; index += 1) {
      const word = args[index];
      if (word === undefined) {
        break;
      }
      const lower = word.text.toLowerCase();
      if (options && dialect === 'powershell' && PS_PATH_PARAMETERS.has(lower)) {
        return args[index + 1] ?? null;
      }
      if (options && dialect === 'powershell' && PS_VALUED_PARAMETERS.has(lower)) {
        index += 1;
      } else if (options && word.text === '--') {
        options = false;
      } else if (options && !word.dynamic && (dialect === 'cmd' ? /^\/[A-Za-z]$/ : /^-[A-Za-z@]/).test(word.text)) {
        continue;
      } else {
        operands.push(word);
      }
    }
    if (operands.length === 0) {
      return null;
    }
    // cmd's cd joins its operands, so `cd Program Files` needs no quotes.
    return dialect === 'cmd' ? { text: operands.map((word) => word.text).join(' '), dynamic: operands.some((word) => word.dynamic) } : (operands[0] ?? null);
  }

  private resolveTarget(target: ShellWord, dialect: ShellDialect): string | undefined {
    if (target.dynamic) {
      return undefined;
    }
    if (target.text === '-') {
      return this.top.previous;
    }
    return resolveDir(this.dir, shellPath(target.text, dialect, this.home), this.home, this.host);
  }

  private changeDir(args: readonly ShellWord[], dialect: ShellDialect): void {
    const target = this.target(args, dialect);
    if (target === null) {
      // A bare `cd` goes home in bash; PowerShell's and cmd's keep (or only print) the folder.
      if (dialect === 'bash') {
        this.change(this.home);
      }
      return;
    }
    if (target.text === '+' && dialect === 'powershell') {
      this.change(undefined);
      return;
    }
    const explicitDrive = args.some((word) => word.text.toLowerCase() === '/d');
    const drive = driveOf(target.text);
    if (dialect === 'cmd' && !target.dynamic && drive !== undefined && drive !== driveOf(this.dir) && !explicitDrive) {
      // Without /d, cmd's cd only sets that drive's folder and stays where it is.
      return;
    }
    this.change(this.resolveTarget(target, dialect));
  }

  private pushDir(args: readonly ShellWord[], dialect: ShellDialect): void {
    const top = this.top;
    const target = this.target(args, dialect);
    if (target === null) {
      // A bare pushd swaps the top two folders in bash, saves the folder in PowerShell, and only prints in cmd.
      if (dialect === 'powershell') {
        top.stack.push(top.dir);
      } else if (dialect === 'bash' && top.stack.length > 0) {
        const other = top.stack.pop();
        top.stack.push(top.dir);
        this.change(other);
      }
      return;
    }
    // pushd +N and -N rotate the stack, which the guard does not track.
    const dir = dialect === 'bash' && /^[+-]\d+$/.test(target.text) ? undefined : this.resolveTarget(target, dialect);
    top.stack.push(top.dir);
    this.change(dir);
  }

  private popDir(args: readonly ShellWord[], dialect: ShellDialect): void {
    const top = this.top;
    if (this.target(args, dialect) !== null) {
      // `popd +N` / `-N` drops an entry and may move; the guard stops trusting the folder.
      top.dir = undefined;
      return;
    }
    if (top.stack.length > 0) {
      this.change(top.stack.pop());
    }
  }
}
