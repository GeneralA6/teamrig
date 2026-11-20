import type { Files } from '../core/files.ts';
import { normalisePath } from './memory-files.ts';

/**
 * `Files` over another `Files` that keeps every path a call names, for a spec of what a command must never reach
 * for: a read leaves no trace in the store, so only the calls themselves can show that a path was left alone.
 * Every call passes through.
 */
export class WatchedFiles implements Files {
  private readonly inner: Files;
  private readonly seen: string[] = [];

  constructor(inner: Files) {
    this.inner = inner;
  }

  /** Every path a call named so far, in call order, as `MemoryFiles` keys it. */
  touched(): string[] {
    return [...this.seen];
  }

  read(path: string): Promise<string | undefined> {
    return this.inner.read(this.note(path));
  }

  readTail(path: string, maxBytes: number): Promise<string | undefined> {
    return this.inner.readTail(this.note(path), maxBytes);
  }

  readHead(path: string, maxBytes: number): Promise<string | undefined> {
    return this.inner.readHead(this.note(path), maxBytes);
  }

  append(path: string, text: string): Promise<void> {
    return this.inner.append(this.note(path), text);
  }

  write(path: string, text: string): Promise<void> {
    return this.inner.write(this.note(path), text);
  }

  createExclusive(path: string, text: string): Promise<boolean> {
    return this.inner.createExclusive(this.note(path), text);
  }

  list(dir: string): Promise<string[]> {
    return this.inner.list(this.note(dir));
  }

  makeFolder(path: string): Promise<void> {
    return this.inner.makeFolder(this.note(path));
  }

  remove(path: string): Promise<boolean> {
    return this.inner.remove(this.note(path));
  }

  move(from: string, to: string): Promise<boolean> {
    return this.inner.move(this.note(from), this.note(to));
  }

  stamp(path: string): Promise<string | undefined> {
    return this.inner.stamp(this.note(path));
  }

  modifiedAt(path: string): Promise<number | undefined> {
    return this.inner.modifiedAt(this.note(path));
  }

  size(path: string): Promise<number | undefined> {
    return this.inner.size(this.note(path));
  }

  private note(path: string): string {
    this.seen.push(normalisePath(path));
    return path;
  }
}
