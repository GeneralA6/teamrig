import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nodeFileBytes } from './file-bytes.ts';
import { isTemporaryName } from './files.ts';
import { realSleep } from './lock.ts';

/** Bytes no UTF-8 text round-trips: a PNG's start, invalid sequences, a CRLF and NULs. */
const BINARY = Uint8Array.from([0, 255, 0x89, 0x50, 0xfe, 0xff, 13, 10, 0]);

describe('nodeFileBytes', () => {
  const bytes = nodeFileBytes(realSleep);
  let root = '';

  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'kit-bytes-'));
  });

  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('reads a missing file as undefined', async () => {
    assert.equal(await bytes.read(join(root, 'nope.png')), undefined);
  });

  it('writes binary bytes atomically, creating folders, and reads them back unchanged', async () => {
    const path = join(root, 'w', 'icon.png');
    await bytes.write(path, Uint8Array.from([1, 2, 3]));
    await bytes.write(path, BINARY);
    assert.deepEqual(new Uint8Array(await bytes.read(path) ?? []), BINARY);
    const names = await readdir(join(root, 'w'));
    assert.deepEqual(names, ['icon.png']);
    assert.equal(names.some(isTemporaryName), false);
  });

  it('creates a file once with binary bytes and keeps the first bytes on a second try', async () => {
    const path = join(root, 'c', 'asset.bin');
    assert.equal(await bytes.createExclusive(path, BINARY), true);
    assert.equal(await bytes.createExclusive(path, Uint8Array.from([7])), false);
    assert.deepEqual(new Uint8Array(await bytes.read(path) ?? []), BINARY);
    assert.deepEqual(await readdir(join(root, 'c')), ['asset.bin']);
  });
});
