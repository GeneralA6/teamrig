import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { MemoryFiles, MemoryPathProbe } from '../testing/memory-files.ts';
import type { RestoreEntry } from './entry.ts';
import { TranscriptFinder } from './transcripts.ts';

const SESSION = '11111111-2222-4333-8444-555555555555';
const PROJECTS = '/home/me/.claude/projects';

function entry(transcriptPath: string | undefined): RestoreEntry {
  return {
    claudeSession: SESSION,
    projectDir: '/work/app',
    transcriptPath,
    entrypoint: 'cli',
    sessionKind: undefined,
    pid: undefined,
    team: undefined,
    session: undefined,
    state: 'ready',
    createdAt: 0,
    updatedAt: 0,
    restoreAttempts: 0,
    restoredAt: undefined,
    endedAt: undefined,
    endReason: undefined,
  };
}

describe('TranscriptFinder', () => {
  it('takes the stored path while it is a file', async () => {
    const files = new MemoryFiles({ '/elsewhere/t.jsonl': '{}' });
    const finder = new TranscriptFinder(files, new MemoryPathProbe(files), PROJECTS);
    assert.equal(await finder.find(entry('/elsewhere/t.jsonl')), '/elsewhere/t.jsonl');
  });

  it('looks in every project folder when the stored path is gone or missing', async () => {
    const moved = join(PROJECTS, 'C--work-renamed', `${SESSION}.jsonl`);
    const files = new MemoryFiles({ [`${PROJECTS}/C--work-other/other.jsonl`]: '{}', [moved]: '{}' });
    const finder = new TranscriptFinder(files, new MemoryPathProbe(files), PROJECTS);
    assert.equal(await finder.find(entry('/gone/t.jsonl')), moved);
    assert.equal(await finder.find(entry(undefined)), moved);
  });

  it('is undefined when no transcript is left', async () => {
    const files = new MemoryFiles({ [`${PROJECTS}/C--work-app/other.jsonl`]: '{}' });
    const finder = new TranscriptFinder(files, new MemoryPathProbe(files), PROJECTS);
    assert.equal(await finder.find(entry(undefined)), undefined);
  });
});
