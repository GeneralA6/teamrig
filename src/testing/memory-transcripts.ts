import type { TranscriptBytes } from '../budget/cursor.ts';

/** In-memory transcripts for tests, counting the bytes each read returns. */
export class MemoryTranscripts implements TranscriptBytes {
  private readonly contents = new Map<string, Buffer>();
  /** Bytes returned by every read so far. */
  bytesRead = 0;

  constructor(initial: Readonly<Record<string, string>> = {}) {
    for (const [path, text] of Object.entries(initial)) {
      this.set(path, text);
    }
  }

  set(path: string, text: string): void {
    this.contents.set(path, Buffer.from(text, 'utf8'));
  }

  append(path: string, text: string): void {
    this.contents.set(path, Buffer.concat([this.contents.get(path) ?? Buffer.alloc(0), Buffer.from(text, 'utf8')]));
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
}
