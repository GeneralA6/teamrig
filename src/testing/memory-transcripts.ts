import { isAbsolute, normalize, relative, sep } from 'node:path';
import type { FolderEntry, TranscriptSource } from '../budget/discover.ts';

/** In-memory transcripts for tests, with the folders their paths imply, counting the bytes each read returns. */
export class MemoryTranscripts implements TranscriptSource {
  private readonly contents = new Map<string, Buffer>();
  private readonly changed = new Map<string, number>();
  /** Bytes returned by every read so far. */
  bytesRead = 0;

  constructor(initial: Readonly<Record<string, string>> = {}, changedAt = 0) {
    for (const [path, text] of Object.entries(initial)) {
      this.set(path, text, changedAt);
    }
  }

  /** Replaces a transcript; `changedAt` is its last change, as a folder listing reports it. */
  set(path: string, text: string, changedAt = 0): void {
    this.contents.set(path, Buffer.from(text, 'utf8'));
    this.changed.set(path, changedAt);
  }

  /** Adds to a transcript; `changedAt`, when given, moves its last change. */
  append(path: string, text: string, changedAt?: number): void {
    this.contents.set(path, Buffer.concat([this.contents.get(path) ?? Buffer.alloc(0), Buffer.from(text, 'utf8')]));
    this.changed.set(path, changedAt ?? this.changed.get(path) ?? 0);
  }

  async size(path: string): Promise<number | undefined> {
    return this.contents.get(path)?.length;
  }

  async read(path: string, offset: number, length: number): Promise<Buffer> {
    const content = this.contents.get(path);
    if (content === undefined) {
      throw new Error(`ENOENT: ${path}`);
    }
    const part = Buffer.from(content.subarray(offset, offset + length));
    this.bytesRead += part.length;
    return part;
  }

  async changedAt(path: string): Promise<number | undefined> {
    return this.changed.get(path);
  }

  /** The files and folders directly in `dir`; a folder's last change is its newest file's. */
  async entries(dir: string): Promise<readonly FolderEntry[]> {
    const found = new Map<string, FolderEntry>();
    for (const [path, changedAt] of this.changed) {
      const inside = relative(normalize(dir), normalize(path));
      if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) {
        continue;
      }
      const [name = '', ...rest] = inside.split(sep);
      const before = found.get(name);
      found.set(name, { name, folder: rest.length > 0, changedAt: Math.max(changedAt, before?.changedAt ?? changedAt) });
    }
    return [...found.values()];
  }
}
