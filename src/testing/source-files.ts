import { readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The `src` folder, for a spec that reads teamrig's own sources to hold a rule over all of them. */
export const SRC_DIR = fileURLToPath(new URL('..', import.meta.url));

/** Every TypeScript source under `dir` that is no test. */
export function sourcesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return sourcesUnder(path);
    }
    return entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : [];
  });
}

/** A source's path under `src` with `/`, the same on every operating system, as a rule names the files it exempts. */
export function underSrc(path: string): string {
  return relative(SRC_DIR, path).split(sep).join('/');
}
