import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { MemoryFiles } from '../testing/memory-files.ts';
import { pendingMergePath, readPendingMerge, removePendingMerge, writePendingMerge, type PendingMerge } from './pending-merges.ts';

const PLACES = { pendingMerges: '/team/deploys/pending-merges' };
const PENDING: PendingMerge = { session: 'api', repo: 'app', branch: 'feat/login', head: 'rebased', base: 'base', since: '2030-01-08T10:00:00.000Z', note: 'https://forge/pr/7' };

describe('pending merges', () => {
  it('keeps one file per branch, its repository and branch encoded into one file name', () => {
    assert.equal(pendingMergePath(PLACES, 'app', 'feat/login'), join(PLACES.pendingMerges, 'app%2Ffeat%2Flogin.json'));
  });

  it('reads back what it wrote, and nothing once it is removed', async () => {
    const files = new MemoryFiles();
    await writePendingMerge(files, PLACES, PENDING);
    assert.deepEqual(await readPendingMerge(files, PLACES, 'app', 'feat/login'), PENDING);
    await removePendingMerge(files, PLACES, 'app', 'feat/login');
    assert.equal(await readPendingMerge(files, PLACES, 'app', 'feat/login'), undefined);
  });

  it('removes a branch with no pending merge without an error', async () => {
    await removePendingMerge(new MemoryFiles(), PLACES, 'app', 'feat/login');
  });

  const unread: readonly { readonly name: string; readonly text: string }[] = [
    { name: 'text that is not JSON', text: '{"session":' },
    { name: 'a record missing a field', text: JSON.stringify({ ...PENDING, note: undefined }) },
    { name: 'a field of another type', text: JSON.stringify({ ...PENDING, head: 7 }) },
    { name: 'another branch', text: JSON.stringify({ ...PENDING, branch: 'feat/other' }) },
    { name: 'another repository', text: JSON.stringify({ ...PENDING, repo: 'web' }) },
  ];
  for (const { name, text } of unread) {
    it(`reads no pending merge from ${name}`, async () => {
      const files = new MemoryFiles({ [pendingMergePath(PLACES, 'app', 'feat/login')]: text });
      assert.equal(await readPendingMerge(files, PLACES, 'app', 'feat/login'), undefined);
    });
  }
});
