import { posix } from 'node:path';
import type { Files } from '../core/files.ts';

/** In-memory `Files` for tests. Paths are compared after normalising separators to `/`. */
export class MemoryFiles implements Files {
  private readonly contents = new Map<string, string>();

  constructor(initial: Readonly<Record<string, string>> = {}) {
    for (const [path, text] of Object.entries(initial)) {
      this.contents.set(normalisePath(path), text);
    }
  }

  /** The current text of a file, for assertions. */
  get(path: string): string | undefined {
    return this.contents.get(normalisePath(path));
  }

  paths(): string[] {
    return [...this.contents.keys()].sort();
  }

  async read(path: string): Promise<string | undefined> {
    return this.get(path);
  }

  async append(path: string, text: string): Promise<void> {
    const key = normalisePath(path);
    this.contents.set(key, (this.contents.get(key) ?? '') + text);
  }

  async write(path: string, text: string): Promise<void> {
    this.contents.set(normalisePath(path), text);
  }

  async createExclusive(path: string, text: string): Promise<boolean> {
    const key = normalisePath(path);
    if (this.contents.has(key)) {
      return false;
    }
    this.contents.set(key, text);
    return true;
  }

  async list(dir: string): Promise<string[]> {
    const prefix = `${normalisePath(dir).replace(/\/$/, '')}/`;
    const names = new Set<string>();
    for (const key of this.contents.keys()) {
      if (key.startsWith(prefix)) {
        const first = key.slice(prefix.length).split('/')[0];
        if (first !== undefined && first !== '') {
          names.add(first);
        }
      }
    }
    return [...names].sort();
  }

  async remove(path: string): Promise<void> {
    this.contents.delete(normalisePath(path));
  }
}

/** A path compared the way `MemoryFiles` keys it: forward slashes, normalised. */
export function normalisePath(path: string): string {
  return posix.normalize(path.replaceAll('\\', '/'));
}
