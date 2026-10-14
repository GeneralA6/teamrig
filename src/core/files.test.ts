import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nodeFiles } from './files.ts';
import { realSleep } from './lock.ts';

describe('nodeFiles', () => {
  const files = nodeFiles(realSleep);
  let root = '';

  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'kit-files-'));
  });

  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('reads a missing file as undefined and lists a missing folder as empty', async () => {
    assert.equal(await files.read(join(root, 'nope.txt')), undefined);
    assert.deepEqual(await files.list(join(root, 'nowhere')), []);
  });

  it('appends, creating folders, and reads back', async () => {
    const path = join(root, 'a', 'b', 'log.jsonl');
    await files.append(path, 'one\n');
    await files.append(path, 'two\n');
    assert.equal(await files.read(path), 'one\ntwo\n');
  });

  it('writes atomically without leaving a temporary file', async () => {
    const path = join(root, 'w', 'config.json');
    await files.write(path, 'first');
    await files.write(path, 'second');
    assert.equal(await files.read(path), 'second');
    assert.deepEqual(await readdir(join(root, 'w')), ['config.json']);
  });

  it('keeps concurrent writes in one process apart, so each lands whole', async () => {
    const path = join(root, 'c', 'state.json');
    const texts = Array.from({ length: 8 }, (_, index) => `write ${index}`);
    await Promise.all(texts.map((text) => files.write(path, text)));
    assert.ok(texts.includes((await files.read(path)) ?? ''));
    assert.deepEqual(await readdir(join(root, 'c')), ['state.json']);
  });

  it('creates a file exclusively, with its content, exactly once', async () => {
    const path = join(root, 'x', 'held.lock');
    assert.equal(await files.createExclusive(path, 'first'), true);
    assert.equal(await files.createExclusive(path, 'second'), false);
    assert.equal(await files.read(path), 'first');
    assert.deepEqual(await readdir(join(root, 'x')), ['held.lock']);
  });

  it('throws what it cannot read or list, other than a missing path', async () => {
    const folder = join(root, 'is-a-folder');
    const file = join(root, 'is-a-file.txt');
    await files.write(join(folder, 'inside.txt'), 'x');
    await files.write(file, 'x');
    await assert.rejects(files.read(folder));
    await assert.rejects(files.readTail(folder, 10), /is not a file/);
    await assert.rejects(files.readTail(join(root, 'nul\0byte'), 10), /ERR_INVALID_ARG_VALUE|null bytes/);
    await assert.rejects(files.list(file));
  });

  it('reads at most the last bytes of a file, and a missing file as undefined', async () => {
    const path = join(root, 't', 'transcript.jsonl');
    await files.write(path, 'first line\nsecond line\n');
    assert.equal(await files.readTail(path, 12), 'second line\n');
    assert.equal(await files.readTail(path, 1000), 'first line\nsecond line\n');
    assert.equal(await files.readTail(join(root, 't', 'nope.jsonl'), 12), undefined);
  });

  it('removes its temporary file and throws when the rename fails', async () => {
    const quick = nodeFiles(() => Promise.resolve());
    const taken = join(root, 'r', 'taken');
    await files.write(join(taken, 'inside.txt'), 'x');
    await assert.rejects(quick.write(taken, 'text'));
    assert.deepEqual(await readdir(join(root, 'r')), ['taken']);
  });

  it('removes a file and ignores a missing one', async () => {
    const path = join(root, 'gone.txt');
    await files.write(path, 'x');
    await files.remove(path);
    await files.remove(path);
    assert.equal(await files.read(path), undefined);
  });
});
