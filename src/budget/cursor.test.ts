import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryTranscripts } from '../testing/memory-transcripts.ts';
import { promptLine, replyLine, systemLine, transcript } from '../testing/transcript-lines.ts';
import { findLineAtOrAfter, nodeTranscriptBytes, readLines } from './cursor.ts';

const PATH = '/t/p/session.jsonl';

function at(hour: number, minute = 0): string {
  return new Date(Date.UTC(2026, 2, 2, hour, minute)).toISOString();
}

/** A transcript's lines and the byte offset each starts at. */
function layout(lines: readonly string[]): { text: string; starts: number[] } {
  const starts: number[] = [];
  let offset = 0;
  for (const line of lines) {
    starts.push(offset);
    offset += Buffer.byteLength(`${line}\n`);
  }
  return { text: transcript(lines), starts };
}

describe('nodeTranscriptBytes', () => {
  let dir = '';

  before(async () => {
    dir = realpathSync.native(await mkdtemp(join(tmpdir(), 'meter-')));
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('gives a file size, and undefined for a missing file', async () => {
    const file = join(dir, 'a.jsonl');
    await writeFile(file, 'one\ntwo\n');
    assert.equal(await nodeTranscriptBytes.size(file), 8);
    assert.equal(await nodeTranscriptBytes.size(join(dir, 'missing.jsonl')), undefined);
  });

  it('refuses a folder', async () => {
    const folder = join(dir, 'folder');
    await mkdir(folder);
    await assert.rejects(nodeTranscriptBytes.size(folder), /is not a file/);
  });

  it('reads a byte range, shorter at the end of the file', async () => {
    const file = join(dir, 'b.jsonl');
    await writeFile(file, 'abcdef');
    assert.equal((await nodeTranscriptBytes.read(file, 2, 3)).toString(), 'cde');
    assert.equal((await nodeTranscriptBytes.read(file, 4, 10)).toString(), 'ef');
  });
});

describe('findLineAtOrAfter', () => {
  const lines = [
    replyLine({ id: 'a', at: at(8), usage: {} }),
    promptLine(at(9)),
    JSON.stringify({ type: 'file-history-snapshot' }),
    'damaged {',
    replyLine({ id: 'b', at: at(12), usage: {} }),
    systemLine(at(13)),
    replyLine({ id: 'c', at: at(15), usage: {} }),
  ];
  const { text, starts } = layout(lines);
  const bytes = new MemoryTranscripts({ [PATH]: text });
  const size = Buffer.byteLength(text);

  it('finds the first line at or after the time', async () => {
    assert.equal(await findLineAtOrAfter(bytes, PATH, size, Date.parse(at(7))), 0);
    assert.equal(await findLineAtOrAfter(bytes, PATH, size, Date.parse(at(9))), starts[1]);
    assert.equal(await findLineAtOrAfter(bytes, PATH, size, Date.parse(at(13))), starts[5]);
    assert.equal(await findLineAtOrAfter(bytes, PATH, size, Date.parse(at(14))), starts[6]);
  });

  it('puts undated and damaged lines with the dated line after them', async () => {
    assert.equal(await findLineAtOrAfter(bytes, PATH, size, Date.parse(at(10))), starts[2]);
  });

  it('gives the end of the file when no line is that late', async () => {
    assert.equal(await findLineAtOrAfter(bytes, PATH, size, Date.parse(at(16))), size);
  });

  it('treats a torn last line as not written yet', async () => {
    const torn = new MemoryTranscripts({ [PATH]: `${text}${replyLine({ id: 'd', at: at(18), usage: {} })}` });
    const tornSize = Buffer.byteLength(text) + Buffer.byteLength(replyLine({ id: 'd', at: at(18), usage: {} }));
    assert.equal(await findLineAtOrAfter(torn, PATH, tornSize, Date.parse(at(16))), size);
    assert.equal(await findLineAtOrAfter(new MemoryTranscripts({ [PATH]: '' }), PATH, 0, 0), 0);
  });

  it('reads a small part of a long transcript, lines longer than a read chunk included', async () => {
    const minute = (index: number): string => new Date(Date.UTC(2026, 2, 2) + index * 60_000).toISOString();
    const long = Array.from({ length: 6_000 }, (_, index) => replyLine({ id: `m${index}`, at: minute(index), usage: { output: index } }));
    long.splice(3_000, 0, promptLine(minute(3_000), 'x'.repeat(30_000)));
    const big = layout(long);
    const memory = new MemoryTranscripts({ [PATH]: big.text });
    const total = Buffer.byteLength(big.text);
    assert.equal(await findLineAtOrAfter(memory, PATH, total, Date.parse(minute(4_000))), big.starts[4_001]);
    assert.ok(memory.bytesRead < total / 2, `${memory.bytesRead} of ${total}`);
    assert.equal(await findLineAtOrAfter(memory, PATH, total, Date.parse(minute(3_000))), big.starts[3_000]);
  });

  it('stops at the end of what can be read when the file shrank during the search', async () => {
    const shrunk = new MemoryTranscripts({ [PATH]: 'no line end' });
    assert.equal(await findLineAtOrAfter(shrunk, PATH, 200_000, 0), 0);
    assert.equal(await findLineAtOrAfter(shrunk, PATH, 200_000, Date.parse(at(9))), 0);
  });
});

describe('readLines', () => {
  const lines = ['{"n":1}', '{"n":22}', '{"n":333}'];
  const { text, starts } = layout(lines);
  const size = Buffer.byteLength(text);

  it('reads every whole line up to the end', async () => {
    const batch = await readLines(new MemoryTranscripts({ [PATH]: text }), PATH, 0, size, 1_000);
    assert.deepEqual(batch, { lines, end: size, bytes: size, capped: false });
  });

  it('stops at the last whole line within the limit, and says so', async () => {
    const batch = await readLines(new MemoryTranscripts({ [PATH]: text }), PATH, 0, size, starts[2] ?? 0);
    assert.deepEqual(batch, { lines: lines.slice(0, 2), end: starts[2], bytes: starts[2], capped: true });
  });

  it('reads a line longer than the limit whole, so a run always moves on', async () => {
    const batch = await readLines(new MemoryTranscripts({ [PATH]: text }), PATH, starts[1] ?? 0, size, 3);
    assert.deepEqual(batch.lines, ['{"n":22}']);
    assert.equal(batch.end, starts[2]);
    assert.equal(batch.capped, true);
  });

  it('leaves a torn last line for the next read', async () => {
    const torn = `${text}{"n":4`;
    const tornSize = Buffer.byteLength(torn);
    const memory = new MemoryTranscripts({ [PATH]: torn });
    assert.deepEqual(await readLines(memory, PATH, 0, tornSize, 1_000), { lines, end: size, bytes: tornSize, capped: false });
    assert.deepEqual(await readLines(memory, PATH, size, tornSize, 2), { lines: [], end: size, bytes: tornSize - size, capped: false });
  });

  it('drops a carriage return before the line end', async () => {
    const memory = new MemoryTranscripts({ [PATH]: '{"a":1}\r\n{"b":2}\n' });
    assert.deepEqual((await readLines(memory, PATH, 0, 17, 100)).lines, ['{"a":1}', '{"b":2}']);
  });
});
