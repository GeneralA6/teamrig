import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nodeFiles } from './files.ts';

describe('nodeFiles', () => {
  const files = nodeFiles();
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

  it('creates a file exclusively, with its content, exactly once', async () => {
    const path = join(root, 'x', 'held.lock');
    assert.equal(await files.createExclusive(path, 'first'), true);
    assert.equal(await files.createExclusive(path, 'second'), false);
    assert.equal(await files.read(path), 'first');
    assert.deepEqual(await readdir(join(root, 'x')), ['held.lock']);
  });

  it('removes a file and ignores a missing one', async () => {
    const path = join(root, 'gone.txt');
    await files.write(path, 'x');
    await files.remove(path);
    await files.remove(path);
    assert.equal(await files.read(path), undefined);
  });
});
