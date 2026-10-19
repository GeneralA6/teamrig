import { posix } from 'node:path';
import type { Files } from '../core/files.ts';
import type { PathKind, PathProbe } from '../core/path-probe.ts';

/**
 * In-memory `Files` for tests. Paths are compared after normalising separators to `/`. A file's stamp is its
 * size in bytes and the number of the change that last set it, counted over every file.
 */
export class MemoryFiles implements Files {
  private readonly contents = new Map<string, string>();
  private readonly changedBy = new Map<string, number>();
  private changes = 0;

  constructor(initial: Readonly<Record<string, string>> = {}) {
    for (const [path, text] of Object.entries(initial)) {
      this.put(normalisePath(path), text);
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

  async readTail(path: string, maxBytes: number): Promise<string | undefined> {
    const text = this.get(path);
    if (text === undefined) {
      return undefined;
    }
    const bytes = Buffer.from(text, 'utf8');
    return bytes.subarray(Math.max(0, bytes.length - maxBytes)).toString('utf8');
  }

  async append(path: string, text: string): Promise<void> {
    const key = normalisePath(path);
    this.put(key, (this.contents.get(key) ?? '') + text);
  }

  async write(path: string, text: string): Promise<void> {
    this.put(normalisePath(path), text);
  }

  async createExclusive(path: string, text: string): Promise<boolean> {
    const key = normalisePath(path);
    if (this.contents.has(key)) {
      return false;
    }
    this.put(key, text);
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

  async remove(path: string): Promise<boolean> {
    const key = normalisePath(path);
    this.changedBy.delete(key);
    return this.contents.delete(key);
  }

  async stamp(path: string): Promise<string | undefined> {
    const key = normalisePath(path);
    const text = this.contents.get(key);
    return text === undefined ? undefined : `${Buffer.byteLength(text, 'utf8')}:${this.changedBy.get(key) ?? 0}`;
  }

  private put(key: string, text: string): void {
    this.changes += 1;
    this.contents.set(key, text);
    this.changedBy.set(key, this.changes);
  }
}

/** A `PathProbe` over a `MemoryFiles`: a path that holds text is a file, a path with files below it is a folder. */
export class MemoryPathProbe implements PathProbe {
  private readonly files: MemoryFiles;

  constructor(files: MemoryFiles) {
    this.files = files;
  }

  async kind(path: string): Promise<PathKind> {
    if (this.files.get(path) !== undefined) {
      return 'file';
    }
    return (await this.files.list(path)).length > 0 ? 'folder' : 'none';
  }
}

/** A path compared the way `MemoryFiles` keys it: forward slashes, normalised. */
export function normalisePath(path: string): string {
  return posix.normalize(path.replaceAll('\\', '/'));
}
