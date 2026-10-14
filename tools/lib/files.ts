import { existsSync, readFileSync } from 'node:fs';

/** The file's UTF-8 text, or undefined when nothing exists at `path`. */
export function readTextIfPresent(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
}
