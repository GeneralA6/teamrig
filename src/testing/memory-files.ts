import { posix } from 'node:path';
import type { Files } from '../core/files.ts';
import type { Clock } from '../core/lock.ts';
import type { PathKind, PathProbe } from '../core/path-probe.ts';

/**
 * In-memory `Files` for tests. Paths are compared after normalising separators to `/`. A file's stamp is its
 * size in bytes and the number of the change that last set it, counted over every file; it was modified at the
 * clock's time of that change (the epoch, without a clock). A folder exists while files are below it, or once made.
 */
export class MemoryFiles implements Files {
  private readonly contents = new Map<string, string>();
  private readonly folders = new Set<string>();
  private readonly changedBy = new Map<string, number>();
  private readonly changedAt = new Map<string, number>();
  private readonly clock: Clock;
  private changes = 0;

  constructor(initial: Readonly<Record<string, string>> = {}, clock: Clock = EPOCH) {
    this.clock = clock;
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

  /** Every file held here is a regular one, so only a missing path gives undefined. */
  async readHead(path: string, maxBytes: number): Promise<string | undefined> {
    const text = this.get(path);
    return text === undefined ? undefined : Buffer.from(text, 'utf8').subarray(0, maxBytes).toString('utf8');
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

  /** Whether the folder was made with `makeFolder`, for a folder no file is below yet. */
  madeFolder(path: string): boolean {
    return this.folders.has(normalisePath(path).replace(/\/$/, ''));
  }

  async list(dir: string): Promise<string[]> {
    const prefix = `${normalisePath(dir).replace(/\/$/, '')}/`;
    const names = new Set<string>();
    for (const key of [...this.contents.keys(), ...this.folders]) {
      if (key.startsWith(prefix)) {
        const first = key.slice(prefix.length).split('/')[0];
        if (first !== undefined && first !== '') {
          names.add(first);
        }
      }
    }
    return [...names].sort();
  }

  async makeFolder(path: string): Promise<void> {
    const key = normalisePath(path).replace(/\/$/, '');
    const blocking = [...this.contents.keys()].find((file) => file === key || key.startsWith(`${file}/`));
    if (blocking !== undefined) {
      throw new Error(`${blocking} is a file, so ${path} cannot be a folder`);
    }
    this.folders.add(key);
  }

  async remove(path: string): Promise<boolean> {
    const key = normalisePath(path);
    this.changedBy.delete(key);
    this.changedAt.delete(key);
    return this.contents.delete(key);
  }

  async move(from: string, to: string): Promise<boolean> {
    const source = normalisePath(from);
    const target = normalisePath(to);
    const moving = [...this.contents].filter(([key]) => isAtOrBelow(key, source));
    const folders = [...this.folders].filter((folder) => isAtOrBelow(folder, source));
    if (moving.length === 0 && folders.length === 0) {
      return false;
    }
    if ([...this.contents.keys(), ...this.folders].some((key) => isAtOrBelow(key, target))) {
      throw new Error(`${to} exists already; a move never replaces it`);
    }
    for (const [key, text] of moving) {
      await this.remove(key);
      this.put(`${target}${key.slice(source.length)}`, text);
    }
    for (const folder of folders) {
      this.folders.delete(folder);
      this.folders.add(`${target}${folder.slice(source.length)}`);
    }
    return true;
  }

  async stamp(path: string): Promise<string | undefined> {
    const key = normalisePath(path);
    const text = this.contents.get(key);
    return text === undefined ? undefined : `${Buffer.byteLength(text, 'utf8')}:${this.changedBy.get(key) ?? 0}`;
  }

  async modifiedAt(path: string): Promise<number | undefined> {
    return this.changedAt.get(normalisePath(path));
  }

  private put(key: string, text: string): void {
    this.changes += 1;
    this.contents.set(key, text);
    this.changedBy.set(key, this.changes);
    this.changedAt.set(key, this.clock.now());
  }
}

/** Whether the file `key` is the path `path` or lies in the folder at it. */
function isAtOrBelow(key: string, path: string): boolean {
  return key === path || key.startsWith(`${path}/`);
}

/** A clock that stays at the epoch, for files whose change times no test reads. */
const EPOCH: Clock = { now: () => 0 };

/** A `PathProbe` over a `MemoryFiles`: a path that holds text is a file, a made path or one with files below it a folder. */
export class MemoryPathProbe implements PathProbe {
  private readonly files: MemoryFiles;

  constructor(files: MemoryFiles) {
    this.files = files;
  }

  async kind(path: string): Promise<PathKind> {
    if (this.files.get(path) !== undefined) {
      return 'file';
    }
    return this.files.madeFolder(path) || (await this.files.list(path)).length > 0 ? 'folder' : 'none';
  }
}

/** A path compared the way `MemoryFiles` keys it: forward slashes, normalised. */
export function normalisePath(path: string): string {
  return posix.normalize(path.replaceAll('\\', '/'));
}
