import type { Files } from '../core/files.ts';
import { normalisePath } from './memory-files.ts';

/** What a call does with the path it names: asks about it, takes its text, or changes the store. */
type CallKind = 'looked' | 'opened' | 'written';

interface SeenCall {
  readonly path: string;
  readonly kind: CallKind;
}

/**
 * `Files` over another `Files` that keeps every path a call names, for a spec of what a command must never reach
 * for: a read leaves no trace in the store, so only the calls themselves can show that a path was left alone.
 * Every call passes through.
 */
export class WatchedFiles implements Files {
  private readonly inner: Files;
  private readonly seen: SeenCall[] = [];

  constructor(inner: Files) {
    this.inner = inner;
  }

  /** Every path a call named so far, in call order, as `MemoryFiles` keys it. */
  touched(): string[] {
    return this.seen.map((call) => call.path);
  }

  /** The paths whose text a call asked for, in call order: a stamp, a size or a listing opens nothing. */
  opened(): string[] {
    return this.pathsOf('opened');
  }

  /**
   * The paths a call that changes the store named, in call order, whether or not it changed anything: a folder
   * made where one is, or a file written with the bytes it holds, shows in no comparison of the store.
   */
  written(): string[] {
    return this.pathsOf('written');
  }

  read(path: string): Promise<string | undefined> {
    return this.inner.read(this.note(path, 'opened'));
  }

  readTail(path: string, maxBytes: number): Promise<string | undefined> {
    return this.inner.readTail(this.note(path, 'opened'), maxBytes);
  }

  readHead(path: string, maxBytes: number): Promise<string | undefined> {
    return this.inner.readHead(this.note(path, 'opened'), maxBytes);
  }

  append(path: string, text: string): Promise<void> {
    return this.inner.append(this.note(path, 'written'), text);
  }

  write(path: string, text: string): Promise<void> {
    return this.inner.write(this.note(path, 'written'), text);
  }

  createExclusive(path: string, text: string): Promise<boolean> {
    return this.inner.createExclusive(this.note(path, 'written'), text);
  }

  list(dir: string): Promise<string[]> {
    return this.inner.list(this.note(dir, 'looked'));
  }

  makeFolder(path: string): Promise<void> {
    return this.inner.makeFolder(this.note(path, 'written'));
  }

  remove(path: string): Promise<boolean> {
    return this.inner.remove(this.note(path, 'written'));
  }

  move(from: string, to: string): Promise<boolean> {
    return this.inner.move(this.note(from, 'written'), this.note(to, 'written'));
  }

  stamp(path: string): Promise<string | undefined> {
    return this.inner.stamp(this.note(path, 'looked'));
  }

  modifiedAt(path: string): Promise<number | undefined> {
    return this.inner.modifiedAt(this.note(path, 'looked'));
  }

  size(path: string): Promise<number | undefined> {
    return this.inner.size(this.note(path, 'looked'));
  }

  private pathsOf(kind: CallKind): string[] {
    return this.seen.filter((call) => call.kind === kind).map((call) => call.path);
  }

  private note(path: string, kind: CallKind): string {
    this.seen.push({ path: normalisePath(path), kind });
    return path;
  }
}
