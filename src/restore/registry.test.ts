import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { MemoryFiles } from '../testing/memory-files.ts';
import { formatEntry, type RestoreEntry } from './entry.ts';
import { RestoreRegistry, restoreSessionsDir } from './registry.ts';

const DIR = restoreSessionsDir(join('/', 'kit'));
const OLDER = '0123abcd-0000-4000-8000-00000000000a';
const NEWER = '0123abcd-0000-4000-8000-00000000000b';

function entry(claudeSession: string, createdAt: string): RestoreEntry {
  return {
    claudeSession,
    projectDir: '/work/app',
    transcriptPath: undefined,
    entrypoint: 'cli',
    sessionKind: undefined,
    pid: undefined,
    team: undefined,
    session: undefined,
    state: 'ready',
    createdAt: Date.parse(createdAt),
    updatedAt: Date.parse(createdAt),
    restoreAttempts: 0,
    restoredAt: undefined,
    endedAt: undefined,
    endReason: undefined,
  };
}

describe('RestoreRegistry', () => {
  it('keeps one file per session under the kit home', async () => {
    const files = new MemoryFiles();
    const registry = new RestoreRegistry(files, DIR);
    await registry.write(entry(OLDER, '2030-01-08T09:00:00Z'));
    assert.equal(DIR, join('/', 'kit', 'restore', 'sessions'));
    assert.ok((await files.read(join(DIR, `${OLDER}.json`)))?.includes(OLDER));
    assert.deepEqual(await registry.read(OLDER), entry(OLDER, '2030-01-08T09:00:00Z'));
    await registry.remove(OLDER);
    assert.equal(await registry.read(OLDER), undefined);
  });

  it('lists the readable entries oldest first, skipping damaged, misnamed and other files', async () => {
    const files = new MemoryFiles({
      [join(DIR, `${NEWER}.json`)]: formatEntry(entry(NEWER, '2030-01-08T09:30:00Z')),
      [join(DIR, `${OLDER}.json`)]: formatEntry(entry(OLDER, '2030-01-08T09:00:00Z')),
      [join(DIR, '0123abcd-0000-4000-8000-00000000000c.json')]: '{"claudeSe',
      [join(DIR, '0123abcd-0000-4000-8000-00000000000d.json')]: formatEntry(entry(OLDER, '2030-01-08T08:00:00Z')),
      [join(DIR, 'notes.txt')]: 'x',
    });
    const listed = await new RestoreRegistry(files, DIR).list();
    assert.deepEqual(
      listed.map((one) => one.claudeSession),
      [OLDER, NEWER],
    );
  });

  it('refuses an id that is not a Claude Code session id, so none reaches a path', () => {
    const registry = new RestoreRegistry(new MemoryFiles(), DIR);
    assert.throws(() => registry.pathOf('../../etc/passwd'), /is not a Claude Code session id/);
  });
});
