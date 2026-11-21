import { basename, dirname, join } from 'node:path';
import type { Files } from '../core/files.ts';
import { KIT_NAME } from '../core/home.ts';

/**
 * A line teamrig asks a repository's git hook script to hold: the hook, the `teamrig <command> <sub>` it calls and
 * the whole line to add. teamrig writes no hook script itself; `check` names the line a script lacks (T1480).
 */
export interface HookLine {
  readonly hook: string;
  readonly command: string;
  readonly sub: string;
  readonly line: string;
}

/**
 * Whether a line of a hook script, other than a comment line, calls the hook line's subcommand: through the `teamrig`
 * command, or `src/cli/main.ts` in teamrig's own repository, which runs its source.
 */
export function callsHookLine(script: string, hookLine: HookLine): boolean {
  const call = new RegExp(`(?:\\b${KIT_NAME}|cli/main\\.ts)\\s+${hookLine.command}\\s+${hookLine.sub}\\b`);
  return script.split('\n').some((line) => !line.trimStart().startsWith('#') && call.test(line));
}

/** The folder holding the hook scripts a person writes: husky points git at `.husky/_`, whose hooks run `.husky/<hook>`. */
export function hookScriptsDir(hooksDir: string): string {
  const parent = dirname(hooksDir);
  return basename(hooksDir) === '_' && basename(parent) === '.husky' ? parent : hooksDir;
}

/** The hook lines whose script in `scriptsDir` does not call them, in the order given; a missing script calls none. */
export async function missingHookLines(files: Files, scriptsDir: string, hookLines: readonly HookLine[]): Promise<HookLine[]> {
  const missing: HookLine[] = [];
  for (const hookLine of hookLines) {
    if (!callsHookLine((await files.read(join(scriptsDir, hookLine.hook))) ?? '', hookLine)) {
      missing.push(hookLine);
    }
  }
  return missing;
}
