import type { Files } from '../core/files.ts';
import { normalisePath } from './memory-files.ts';

export type FileOperation = keyof Files;

/** A Node system error as `fs` throws it: a message and a `code` such as EACCES. */
export function systemError(code: string, message: string = `${code}: simulated`): Error {
  return Object.assign(new Error(message), { code });
}

/**
 * `Files` over another `Files` that fails or stalls chosen operations on chosen paths, for the error paths a
 * disk produces (a permission refused, a folder where a file should be, a read that outlives a hook's timeout).
 * Every other call passes through.
 */
export class FaultyFiles implements Files {
  private readonly inner: Files;
  private readonly faults = new Map<string, Error>();
  private readonly stalls = new Map<string, () => void>();

  constructor(inner: Files) {
    this.inner = inner;
  }

  /** From now on, `operation` on `path` rejects with `error`. */
  fail(operation: FileOperation, path: string, error: Error): this {
    this.faults.set(keyOf(operation, path), error);
    return this;
  }

  /** From now on, `operation` on `path` never settles; the promise resolves once a call reaches it. */
  stall(operation: FileOperation, path: string): Promise<void> {
    return new Promise((reached) => {
      this.stalls.set(keyOf(operation, path), reached);
    });
  }

  async read(path: string): Promise<string | undefined> {
    await this.check('read', path);
    return this.inner.read(path);
  }

  async readTail(path: string, maxBytes: number): Promise<string | undefined> {
    await this.check('readTail', path);
    return this.inner.readTail(path, maxBytes);
  }

  async readHead(path: string, maxBytes: number): Promise<string | undefined> {
    await this.check('readHead', path);
    return this.inner.readHead(path, maxBytes);
  }

  async append(path: string, text: string): Promise<void> {
    await this.check('append', path);
    return this.inner.append(path, text);
  }

  async write(path: string, text: string): Promise<void> {
    await this.check('write', path);
    return this.inner.write(path, text);
  }

  async createExclusive(path: string, text: string): Promise<boolean> {
    await this.check('createExclusive', path);
    return this.inner.createExclusive(path, text);
  }

  async list(dir: string): Promise<string[]> {
    await this.check('list', dir);
    return this.inner.list(dir);
  }

  async makeFolder(path: string): Promise<void> {
    await this.check('makeFolder', path);
    return this.inner.makeFolder(path);
  }

  async remove(path: string): Promise<boolean> {
    await this.check('remove', path);
    return this.inner.remove(path);
  }

  async move(from: string, to: string): Promise<boolean> {
    await this.check('move', from);
    return this.inner.move(from, to);
  }

  async stamp(path: string): Promise<string | undefined> {
    await this.check('stamp', path);
    return this.inner.stamp(path);
  }

  async modifiedAt(path: string): Promise<number | undefined> {
    await this.check('modifiedAt', path);
    return this.inner.modifiedAt(path);
  }

  private async check(operation: FileOperation, path: string): Promise<void> {
    const key = keyOf(operation, path);
    const error = this.faults.get(key);
    if (error !== undefined) {
      throw error;
    }
    const reached = this.stalls.get(key);
    if (reached !== undefined) {
      reached();
      await new Promise<never>(() => undefined);
    }
  }
}

function keyOf(operation: FileOperation, path: string): string {
  return `${operation} ${normalisePath(path)}`;
}
