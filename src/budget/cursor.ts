import { open, stat } from 'node:fs/promises';
import { errorCode, stringField } from '../core/guards.ts';
import { parseObject } from '../core/jsonl.ts';

/** Byte-level reads of a transcript, which can be far too big to read whole. */
export interface TranscriptBytes {
  /** The file's size in bytes, or undefined when it does not exist. */
  size(path: string): Promise<number | undefined>;
  /** Up to `length` bytes from `offset`; fewer at the end of the file. */
  read(path: string, offset: number, length: number): Promise<Buffer>;
}

/** The real filesystem. Claude Code only appends to a transcript, so reading while it writes is safe. */
export const nodeTranscriptBytes: TranscriptBytes = {
  async size(path) {
    try {
      const stats = await stat(path);
      if (!stats.isFile()) {
        throw new Error(`${path} is not a file`);
      }
      return stats.size;
    } catch (error) {
      if (errorCode(error) === 'ENOENT') {
        return undefined;
      }
      throw error;
    }
  },
  async read(path, offset, length) {
    const handle = await open(path, 'r');
    try {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      return buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  },
};

/** How much a search reads at a time while looking for a line end: most lines are shorter. */
const CHUNK = 8 * 1024;
const NEWLINE = 0x0a;

/** The offset just past the first line end at or after `from`, or `size` when no line end follows. */
async function nextLineStart(bytes: TranscriptBytes, path: string, from: number, size: number): Promise<number> {
  for (let at = from; at < size; at += CHUNK) {
    const chunk = await bytes.read(path, at, Math.min(CHUNK, size - at));
    const index = chunk.indexOf(NEWLINE);
    if (index >= 0) {
      return at + index + 1;
    }
    if (chunk.length === 0) {
      break;
    }
  }
  return size;
}

/** The start of the first line that begins at or after `position`. */
async function lineStartAt(bytes: TranscriptBytes, path: string, position: number, size: number): Promise<number> {
  return position === 0 ? 0 : nextLineStart(bytes, path, position - 1, size);
}

/** The time of a transcript line; undefined for a line without one, or a damaged line. */
function lineTime(text: string): number | undefined {
  const entry = parseObject(text);
  const stamp = entry === undefined ? undefined : stringField(entry, 'timestamp');
  const at = stamp === undefined ? Number.NaN : Date.parse(stamp);
  return Number.isNaN(at) ? undefined : at;
}

/** The whole line from `start` and the offset after it; undefined when it has no line end yet. */
async function lineFrom(bytes: TranscriptBytes, path: string, start: number, size: number): Promise<{ text: string; end: number } | undefined> {
  const parts: Buffer[] = [];
  let at = start;
  while (at < size) {
    const chunk = await bytes.read(path, at, Math.min(CHUNK, size - at));
    if (chunk.length === 0) {
      return undefined;
    }
    const index = chunk.indexOf(NEWLINE);
    if (index >= 0) {
      parts.push(chunk.subarray(0, index));
      return { text: Buffer.concat(parts).toString('utf8'), end: at + index + 1 };
    }
    parts.push(chunk);
    at += chunk.length;
  }
  return undefined;
}

/** The time of the first dated whole line from `start`; undefined when none follows before the end. */
async function firstTimeFrom(bytes: TranscriptBytes, path: string, start: number, size: number): Promise<number | undefined> {
  let line = await lineFrom(bytes, path, start, size);
  while (line !== undefined) {
    const at = lineTime(line.text);
    if (at !== undefined) {
      return at;
    }
    line = await lineFrom(bytes, path, line.end, size);
  }
  return undefined;
}

/**
 * The offset of the first line dated at or after `since`, by binary search over byte offsets, so a
 * first read of a long transcript never parses the whole file. Lines are written in time order;
 * undated lines go with the dated line after them. `size` when no line that late exists yet.
 */
export async function findLineAtOrAfter(bytes: TranscriptBytes, path: string, size: number, since: number): Promise<number> {
  let low = 0;
  let high = size;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const start = await lineStartAt(bytes, path, middle, size);
    const at = await firstTimeFrom(bytes, path, start, size);
    if (at === undefined || at >= since) {
      high = middle;
    } else {
      low = middle + 1;
    }
  }
  return lineStartAt(bytes, path, low, size);
}

/** The whole lines read from a transcript in one go, and where the next read starts. */
export interface LineBatch {
  readonly lines: readonly string[];
  /** The offset just past the last whole line read; a torn last line is left for the next read. */
  readonly end: number;
  /** Bytes read, counted against the run's limit. */
  readonly bytes: number;
  /** True when the limit stopped the read before the end of the file. */
  readonly capped: boolean;
}

/**
 * The whole lines from `offset`, reading at most `limit` bytes; a line longer than the limit is read
 * whole all the same, so a run always moves forward. A last line with no line end yet (Claude Code
 * is still writing it) is not returned: the next read starts at it.
 */
export async function readLines(bytes: TranscriptBytes, path: string, offset: number, size: number, limit: number): Promise<LineBatch> {
  const length = Math.min(size - offset, Math.max(0, limit));
  let buffer = await bytes.read(path, offset, length);
  let last = buffer.lastIndexOf(NEWLINE);
  if (last < 0 && offset + buffer.length < size) {
    const end = await nextLineStart(bytes, path, offset + buffer.length, size);
    buffer = await bytes.read(path, offset, end - offset);
    last = buffer.lastIndexOf(NEWLINE);
  }
  const whole = buffer.subarray(0, last + 1);
  const lines = whole.length === 0 ? [] : whole.toString('utf8').slice(0, -1).split('\n');
  return {
    lines: lines.map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line)),
    end: offset + whole.length,
    bytes: buffer.length,
    capped: offset + whole.length < size && buffer.length < size - offset,
  };
}
