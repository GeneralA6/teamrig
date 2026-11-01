import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { MemoryFiles } from '../testing/memory-files.ts';
import { ARCHIVE_KEEP_MS, parseArchived, RestoreArchive, restoreArchiveDir, type ArchivedEntry } from './archive.ts';
import { entryRecord, type RestoreEntry } from './entry.ts';

const DIR = restoreArchiveDir(join('/', 'kit'));
const FIRST = '0123abcd-0000-4000-8000-00000000000a';
const SECOND = '0123abcd-0000-4000-8000-00000000000b';
const NOW = Date.parse('2030-01-08T09:00:00Z');

function entry(claudeSession: string): RestoreEntry {
  return {
    claudeSession,
    projectDir: '/work/app',
    transcriptPath: undefined,
    entrypoint: 'cli',
    sessionKind: undefined,
    pid: undefined,
    team: 'app',
    session: 'alpha',
    state: 'ready',
    createdAt: NOW - 3_600_000,
    updatedAt: NOW - 60_000,
    restoreAttempts: 0,
    restoredAt: undefined,
    endedAt: NOW - 60_000,
    endReason: 'other',
  };
}

function archived(claudeSession: string, archivedAt: number, reason = 'closed by hand'): ArchivedEntry {
  return { entry: entry(claudeSession), archivedAt, reason };
}

function fileText(record: Readonly<Record<string, unknown>>): string {
  return `${JSON.stringify(record, null, 2)}\n`;
}

describe('RestoreArchive', () => {
  it('keeps one file per session beside the sessions folder and reads it back whole', async () => {
    const files = new MemoryFiles();
    const archive = new RestoreArchive(files, DIR);
    await archive.put(archived(FIRST, NOW));
    assert.equal(DIR, join('/', 'kit', 'restore', 'archive'));
    assert.ok((await files.read(join(DIR, `${FIRST}.json`)))?.includes('"archivedAt": "2030-01-08T09:00:00.000Z"'));
    assert.deepEqual(await archive.read(FIRST), archived(FIRST, NOW));
    assert.equal(await archive.read(SECOND), undefined);
  });

  it('replaces the older copy when a session is archived again', async () => {
    const archive = new RestoreArchive(new MemoryFiles(), DIR);
    await archive.put(archived(FIRST, NOW - 60_000, 'background session'));
    await archive.put(archived(FIRST, NOW));
    assert.deepEqual(await archive.list(), [archived(FIRST, NOW)]);
  });

  it('lists the readable entries earliest archived first, skipping damaged, misnamed and other files', async () => {
    const files = new MemoryFiles({
      [join(DIR, '0123abcd-0000-4000-8000-00000000000c.json')]: '{"archivedAt',
      [join(DIR, '0123abcd-0000-4000-8000-00000000000d.json')]: fileText({ archivedAt: new Date(NOW).toISOString(), reason: 'x', entry: entryRecord(entry(FIRST)) }),
      [join(DIR, 'notes.txt')]: 'x',
    });
    const archive = new RestoreArchive(files, DIR);
    await archive.put(archived(SECOND, NOW - 60_000));
    await archive.put(archived(FIRST, NOW - 120_000));
    assert.deepEqual(
      (await archive.list()).map(({ entry: one }) => one.claudeSession),
      [FIRST, SECOND],
    );
  });

  it('refuses an id that is not a Claude Code session id, so none reaches a path', async () => {
    const archive = new RestoreArchive(new MemoryFiles(), DIR);
    await assert.rejects(archive.put(archived('../../etc/passwd', NOW)), /is not a Claude Code session id/);
    await assert.rejects(archive.read('../../etc/passwd'), /is not a Claude Code session id/);
  });

  it('purges the entries archived 7 days ago or earlier and keeps the younger ones', async () => {
    const files = new MemoryFiles();
    const archive = new RestoreArchive(files, DIR);
    await archive.put(archived(FIRST, NOW - ARCHIVE_KEEP_MS));
    await archive.put(archived(SECOND, NOW - ARCHIVE_KEEP_MS + 1));
    assert.deepEqual(await archive.purge(NOW), [archived(FIRST, NOW - ARCHIVE_KEEP_MS)]);
    assert.equal(await files.read(join(DIR, `${FIRST}.json`)), undefined);
    assert.deepEqual(await archive.list(), [archived(SECOND, NOW - ARCHIVE_KEEP_MS + 1)]);
    assert.deepEqual(await new RestoreArchive(new MemoryFiles(), DIR).purge(NOW), []);
  });
});

describe('parseArchived', () => {
  it('reads an archive file written by the archive', () => {
    const text = fileText({ archivedAt: new Date(NOW).toISOString(), reason: 'closed by hand', entry: entryRecord(entry(FIRST)) });
    assert.deepEqual(parseArchived(text), archived(FIRST, NOW));
  });

  it('refuses a file with no reason, no instant, no entry or a damaged one', () => {
    const record = entryRecord(entry(FIRST));
    assert.equal(parseArchived(fileText({ archivedAt: new Date(NOW).toISOString(), entry: record })), undefined);
    assert.equal(parseArchived(fileText({ archivedAt: 'yesterday', reason: 'x', entry: record })), undefined);
    assert.equal(parseArchived(fileText({ archivedAt: new Date(NOW).toISOString(), reason: 'x' })), undefined);
    assert.equal(parseArchived(fileText({ archivedAt: new Date(NOW).toISOString(), reason: 'x', entry: { claudeSession: FIRST } })), undefined);
    assert.equal(parseArchived('not json'), undefined);
  });
});
