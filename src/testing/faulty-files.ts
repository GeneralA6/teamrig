import type { Files } from '../core/files.ts';
import { normalisePath } from './memory-files.ts';

export type FileOperation = keyof Files;

/** A Node system error as `fs` throws it: a message and a `code` such as EACCES. */
export function systemError(code: string, message: string = `${code}: simulated`): Error {
  return Object.assign(new Error(message), { code });
}

/**
 * `Files` over another `Files` that fails chosen operations on chosen paths, for the error paths a
 * disk produces (a permission refused, a folder where a file should be). Every other call passes through.
 */
export class FaultyFiles implements Files {
  private readonly inner: Files;
  private readonly faults = new Map<string, Error>();

  constructor(inner: Files) {
    this.inner = inner;
  }

  /** From now on, `operation` on `path` rejects with `error`. */
  fail(operation: FileOperation, path: string, error: Error): this {
    this.faults.set(keyOf(operation, path), error);
    return this;
  }

  async read(path: string): Promise<string | undefined> {
    this.check('read', path);
    return this.inner.read(path);
  }

  async append(path: string, text: string): Promise<void> {
    this.check('append', path);
    return this.inner.append(path, text);
  }

  async write(path: string, text: string): Promise<void> {
    this.check('write', path);
    return this.inner.write(path, text);
  }

  async createExclusive(path: string, text: string): Promise<boolean> {
    this.check('createExclusive', path);
    return this.inner.createExclusive(path, text);
  }

  async list(dir: string): Promise<string[]> {
    this.check('list', dir);
    return this.inner.list(dir);
  }

  async remove(path: string): Promise<void> {
    this.check('remove', path);
    return this.inner.remove(path);
  }

  private check(operation: FileOperation, path: string): void {
    const error = this.faults.get(keyOf(operation, path));
    if (error !== undefined) {
      throw error;
    }
  }
}

function keyOf(operation: FileOperation, path: string): string {
  return `${operation} ${normalisePath(path)}`;
}
