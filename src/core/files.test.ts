import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, open, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isTemporaryName, nodeFiles } from './files.ts';
import { realSleep } from './lock.ts';
import { TRANSIENT_RETRY_DELAYS_MS } from './retry.ts';

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
    await assert.rejects(files.stamp(join(root, 'nul\0byte')), /ERR_INVALID_ARG_VALUE|null bytes/);
  });

  it('reads at most the last bytes of a file, and a missing file as undefined', async () => {
    const path = join(root, 't', 'transcript.jsonl');
    await files.write(path, 'first line\nsecond line\n');
    assert.equal(await files.readTail(path, 12), 'second line\n');
    assert.equal(await files.readTail(path, 1000), 'first line\nsecond line\n');
    assert.equal(await files.readTail(join(root, 't', 'nope.jsonl'), 12), undefined);
  });

  it('replaces a file a reader holds open past the short retry budget, once the reader closes it', async () => {
    const path = join(root, 'held', 'host.lock');
    await files.write(path, 'old');
    // Windows refuses the rename while this handle is open; the reader closes it only after more waits than the
    // short budget has, as the host lock's pollers did under load (T1704). Elsewhere the rename succeeds at once.
    const reader = await open(path, 'r');
    const holdFor = TRANSIENT_RETRY_DELAYS_MS.length + 2;
    let waits = 0;
    const held = nodeFiles(async () => {
      waits += 1;
      if (waits === holdFor) {
        await reader.close();
      }
    });
    try {
      await held.write(path, 'new');
    } finally {
      if (waits < holdFor) {
        await reader.close();
      }
    }
    assert.equal(await files.read(path), 'new');
    assert.deepEqual(await readdir(join(root, 'held')), ['host.lock']);
    if (process.platform === 'win32') {
      assert.equal(waits, holdFor);
    }
  });

  it('reads at most the first bytes of a regular file, and nothing that is no regular file', { timeout: 10_000 }, async () => {
    const dir = join(root, 'h');
    const path = join(dir, 'fix.sql');
    await files.write(path, 'DELETE FROM rows;\nSELECT 1;\n');
    assert.equal(await files.readHead(path, 18), 'DELETE FROM rows;\n');
    assert.equal(await files.readHead(path, 1000), 'DELETE FROM rows;\nSELECT 1;\n');
    assert.equal(await files.readHead(join(dir, 'nope.sql'), 10), undefined);
    assert.equal(await files.readHead(dir, 10), undefined);
    // A device never ends, and a pipe with no writer opens only without waiting: neither is read.
    assert.equal(await files.readHead(process.platform === 'win32' ? 'NUL' : '/dev/zero', 10), undefined);
    if (process.platform !== 'win32') {
      const pipe = join(dir, 'pipe');
      execFileSync('mkfifo', [pipe]);
      assert.equal(await files.readHead(pipe, 10), undefined);
    }
    await assert.rejects(files.readHead(join(root, 'nul\0byte'), 10), /ERR_INVALID_ARG_VALUE|null bytes/);
  });

  it('removes its temporary file and throws when the rename fails', async () => {
    const quick = nodeFiles(() => Promise.resolve());
    const taken = join(root, 'r', 'taken');
    await files.write(join(taken, 'inside.txt'), 'x');
    await assert.rejects(quick.write(taken, 'text'));
    assert.deepEqual(await readdir(join(root, 'r')), ['taken']);
  });

  it('stamps a file with its size and change time, and gives no stamp for a missing path or a folder', async () => {
    const folder = join(root, 's');
    const path = join(folder, 'stamped.txt');
    assert.equal(await files.stamp(path), undefined);
    await files.write(path, 'four');
    assert.match((await files.stamp(path)) ?? '', /^4:\d+(\.\d+)?$/);
    await files.append(path, 'more');
    assert.match((await files.stamp(path)) ?? '', /^8:\d/);
    assert.equal(await files.stamp(folder), undefined);
  });

  it('tells when a file last changed, and nothing for a missing path or a folder', async () => {
    const folder = join(root, 'm');
    const path = join(folder, 'changed.txt');
    assert.equal(await files.modifiedAt(path), undefined);
    const before = Date.now();
    await files.write(path, 'x');
    const changedAt = (await files.modifiedAt(path)) ?? Number.NaN;
    assert.ok(Math.abs(changedAt - before) < 60_000, `${changedAt} vs ${before}`);
    assert.equal(await files.modifiedAt(folder), undefined);
  });

  it('removes a file, telling that it did, and ignores a missing one', async () => {
    const path = join(root, 'gone.txt');
    await files.write(path, 'x');
    assert.deepEqual([await files.remove(path), await files.remove(path)], [true, false]);
    assert.equal(await files.read(path), undefined);
  });

  it('makes a folder with the folders above it, again without harm, and throws when a file is in the way', async () => {
    const folder = join(root, 'made', 'T12');
    await files.makeFolder(folder);
    await files.makeFolder(folder);
    assert.deepEqual([await files.list(join(root, 'made')), await files.list(folder)], [['T12'], []]);
    await files.write(join(root, 'plain.txt'), 'x');
    await assert.rejects(files.makeFolder(join(root, 'plain.txt')), /EEXIST/);
  });

  it('moves a file and a folder with what it holds, creating folders, and never replaces what is there', async () => {
    await files.write(join(root, 'one.txt'), 'x');
    await files.write(join(root, 'box', 'inner', 'two.txt'), 'y');
    assert.equal(await files.move(join(root, 'one.txt'), join(root, 'to', 'deep', 'one.txt')), true);
    assert.equal(await files.move(join(root, 'box'), join(root, 'to', 'box')), true);
    assert.deepEqual([await files.read(join(root, 'to', 'deep', 'one.txt')), await files.read(join(root, 'to', 'box', 'inner', 'two.txt'))], ['x', 'y']);
    assert.deepEqual((await readdir(root)).filter((name) => name === 'one.txt' || name === 'box'), []);
    assert.equal(await files.move(join(root, 'missing'), join(root, 'elsewhere')), false);
    await files.write(join(root, 'three.txt'), 'z');
    await assert.rejects(files.move(join(root, 'three.txt'), join(root, 'to', 'deep', 'one.txt')), /exists already; a move never replaces it/);
    assert.equal(await files.read(join(root, 'to', 'deep', 'one.txt')), 'x');
  });
});

describe('isTemporaryName', () => {
  it("knows a write's temporary sibling, as a write names it now and as an older teamrig did", () => {
    assert.deepEqual(['a.json.4242.7.tmp', 'a.json.4242.tmp', '.pruned.4242.8.tmp'].map(isTemporaryName), [true, true, true]);
    assert.deepEqual(['a.json', '.pruned', 'notes.tmp', 'a.json.x.tmp', '.4242.tmp'].map(isTemporaryName), [false, false, false, false, false]);
  });
});
