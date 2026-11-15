import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryFiles, MemoryPathProbe } from './memory-files.ts';

describe('MemoryFiles reads', () => {
  it('reads at most the first bytes of a file, by either separator, and a missing one as undefined', async () => {
    const files = new MemoryFiles({ '/kit/fix.sql': 'DELETE FROM rows;\nSELECT 1;\n' });
    const heads = [await files.readHead('/kit/fix.sql', 18), await files.readHead('\\kit\\fix.sql', 1000), await files.readHead('/kit/nope.sql', 10)];
    assert.deepEqual(heads, ['DELETE FROM rows;\n', 'DELETE FROM rows;\nSELECT 1;\n', undefined]);
  });
});

describe('MemoryFiles folders', () => {
  it('lists a made folder before any file is in it, and probes it as a folder', async () => {
    const files = new MemoryFiles();
    const probe = new MemoryPathProbe(files);
    await files.makeFolder('/kit/teams/a/tasks/T12');
    await files.makeFolder('/kit/teams/a/tasks/T12/');
    assert.deepEqual([await files.list('/kit/teams/a/tasks'), await files.list('/kit/teams/a/tasks/T12')], [['T12'], []]);
    assert.deepEqual([await probe.kind('/kit/teams/a/tasks/T12'), await probe.kind('/kit/teams/a/tasks/T13')], ['folder', 'none']);
    assert.equal(files.madeFolder('\\kit\\teams\\a\\tasks\\T12'), true);
  });

  it('refuses a folder where a file is, or below one', async () => {
    const files = new MemoryFiles({ '/kit/notes.md': 'x' });
    await assert.rejects(files.makeFolder('/kit/notes.md'), /\/kit\/notes\.md is a file/);
    await assert.rejects(files.makeFolder('/kit/notes.md/inner'), /\/kit\/notes\.md is a file/);
  });

  it('moves a made folder with the folders below it, and never onto one', async () => {
    const files = new MemoryFiles();
    await files.makeFolder('/kit/a/T12/evidence');
    await files.makeFolder('/kit/b/T12');
    assert.equal(await files.move('/kit/a/T12', '/kit/c/T12'), true);
    assert.deepEqual([await files.list('/kit/a'), await files.list('/kit/c/T12')], [[], ['evidence']]);
    await assert.rejects(files.move('/kit/c/T12', '/kit/b/T12'), /exists already/);
  });
});
