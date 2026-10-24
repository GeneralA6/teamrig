import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NODE_STORE_FOLDERS } from './node-store-folders.ts';

const DIR = mkdtempSync(join(tmpdir(), 'teamrig-store-'));
after(() => rmSync(DIR, { recursive: true, force: true }));

describe('NODE_STORE_FOLDERS', () => {
  it('dates a file and a folder, and none for a missing path or one under a file', async () => {
    const folder = join(DIR, 'dated');
    const file = join(folder, 'installed_plugins.json');
    mkdirSync(folder);
    writeFileSync(file, '{}');
    const at = new Date('2030-01-08T10:00:00.000Z');
    utimesSync(file, at, at);
    utimesSync(folder, at, new Date(at.getTime() + 1000));
    assert.equal(await NODE_STORE_FOLDERS.changedAt(file), at.getTime());
    assert.equal(await NODE_STORE_FOLDERS.changedAt(folder), at.getTime() + 1000);
    assert.equal(await NODE_STORE_FOLDERS.changedAt(join(folder, 'nothing')), undefined);
    assert.equal(await NODE_STORE_FOLDERS.changedAt(join(file, 'inside')), undefined);
  });

  it('lists the folders directly in a folder, leaving out files and links, and none for a missing one', async () => {
    const folder = join(DIR, 'listed');
    mkdirSync(join(folder, '0.166.0', 'hooks'), { recursive: true });
    mkdirSync(join(folder, '0.167.0'));
    writeFileSync(join(folder, '.orphaned_at'), '');
    // A junction needs no rights on Windows; elsewhere the type is ignored and it is a plain link.
    symlinkSync(join(folder, '0.167.0'), join(folder, 'latest'), 'junction');
    assert.deepEqual([...(await NODE_STORE_FOLDERS.foldersIn(folder))].sort(), [join(folder, '0.166.0'), join(folder, '0.167.0')]);
    assert.deepEqual(await NODE_STORE_FOLDERS.foldersIn(join(folder, 'nothing')), []);
    assert.deepEqual(await NODE_STORE_FOLDERS.foldersIn(join(folder, '.orphaned_at')), []);
  });

  it('passes on any error but a missing path, so a failed read is never taken for an empty store', async () => {
    // A NUL byte fails on every OS before the call reaches the disk.
    const invalid = join(DIR, 'bad\0name');
    await assert.rejects(NODE_STORE_FOLDERS.changedAt(invalid), { code: 'ERR_INVALID_ARG_VALUE' });
    await assert.rejects(NODE_STORE_FOLDERS.foldersIn(invalid), { code: 'ERR_INVALID_ARG_VALUE' });
  });
});
