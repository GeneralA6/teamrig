import * as nodePath from 'node:path';
import type { Files } from '../core/files.ts';

/** The names a bin has in `node_modules/.bin`: bare on Linux and macOS, with `.cmd` and `.ps1` shims on Windows. */
const BIN_ENDINGS: readonly string[] = ['', '.cmd', '.ps1', '.exe'];

/** Windows rules for a folder with a drive letter on every host, as the push guard's `Location` resolves it. */
function pathRules(dir: string): nodePath.PlatformPath {
  return /^[A-Za-z]:/.test(dir) ? nodePath.win32 : nodePath;
}

/**
 * True when `bin` is installed in `dir`'s `node_modules/.bin` or an ancestor's, so `npx <bin>` there runs it
 * instead of fetching a package: a package in a workspace runs its root's bins too. Names compare without case,
 * as on Windows.
 */
export async function hasLocalBin(files: Files, dir: string, bin: string): Promise<boolean> {
  const rules = pathRules(dir);
  const names = new Set(BIN_ENDINGS.map((ending) => `${bin}${ending}`.toLowerCase()));
  for (let at = rules.resolve(dir); ; at = rules.dirname(at)) {
    const entries = await files.list(rules.join(at, 'node_modules', '.bin'));
    if (entries.some((entry) => names.has(entry.toLowerCase()))) {
      return true;
    }
    if (rules.dirname(at) === at) {
      return false;
    }
  }
}
