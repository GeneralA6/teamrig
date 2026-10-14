import { posix, win32 } from 'node:path';
import type { Files } from '../core/files.ts';
import type { Env } from '../core/home.ts';
import type { PathProbe } from '../core/path-probe.ts';

/** How to start Claude Code: `command`, then `prefix`, then Claude Code's own arguments. */
export interface ClaudeProgram {
  readonly command: string;
  readonly prefix: readonly string[];
}

export type ClaudeSearch =
  | { readonly kind: 'found'; readonly program: ClaudeProgram }
  /** `skipped`: launchers named `claude` that were found but cannot be started safely, and why. */
  | { readonly kind: 'missing'; readonly skipped: readonly string[] };

export interface ClaudeSearchDeps {
  readonly env: Env;
  readonly platform: NodeJS.Platform;
  readonly probe: PathProbe;
  readonly files: Files;
  /** The Node.js program that runs an npm-installed Claude Code's script. */
  readonly node: string;
}

const PROGRAM = 'claude';
const WINDOWS_EXTENSIONS = '.COM;.EXE;.BAT;.CMD';
const SCRIPT = /\.[cm]?js$/i;
/** npm's cmd-shim ends by running `"%dp0%\<target>" %*`: the target, beside the shim. */
const SHIM_TARGET = /"%~?dp0%?\\([^"\r\n]+)"\s+%\*/g;

/** A variable by name; Windows names ignore case (`Path`, `PATH`). */
function variable(env: Env, name: string, platform: NodeJS.Platform): string | undefined {
  if (platform !== 'win32') {
    return env[name];
  }
  const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === name);
  return key === undefined ? undefined : env[key];
}

function listOf(value: string | undefined, delimiter: string): string[] {
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
async function shimProgram(deps: ClaudeSearchDeps, shim: string): Promise<ClaudeProgram | string> {
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

async function windowsSearch(deps: ClaudeSearchDeps): Promise<ClaudeSearch> {
  const extensions = listOf(variable(deps.env, 'PATHEXT', 'win32') ?? WINDOWS_EXTENSIONS, ';').map((extension) => extension.toLowerCase());
  const skipped: string[] = [];
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

async function posixSearch(deps: ClaudeSearchDeps): Promise<ClaudeSearch> {
  for (const folder of listOf(variable(deps.env, 'PATH', deps.platform), ':')) {
    const path = posix.join(folder, PROGRAM);
    if ((await deps.probe.kind(path)) === 'file') {
      return { kind: 'found', program: { command: path, prefix: [] } };
    }
  }
  return { kind: 'missing', skipped: [] };
}

/** Claude Code on PATH, the way a shell finds it: the native `claude.exe`, an npm shim, or `claude`. */
export function findClaude(deps: ClaudeSearchDeps): Promise<ClaudeSearch> {
  return deps.platform === 'win32' ? windowsSearch(deps) : posixSearch(deps);
}
