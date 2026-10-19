import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { MemoryFiles, normalisePath } from '../testing/memory-files.ts';
import { formatSessionRecord, parseSessionRecord, SessionRecordStore, type SessionRecord } from './record.ts';

const PATHS = { sessions: join('/', 'team', 'state', 'sessions') };
const RECORD: SessionRecord = { claudePid: 6900, claudeSession: 'claude-1', at: '2030-01-08T10:00:00.000Z' };

describe('SessionRecordStore', () => {
  it('keeps one record per session, and the newest start overwrites the last', async () => {
    const files = new MemoryFiles();
    const store = new SessionRecordStore(files, PATHS);
    assert.equal(await store.read('alpha'), undefined);
    await store.write('alpha', RECORD);
    const cleared = { ...RECORD, claudeSession: 'claude-2', at: '2030-01-08T11:00:00.000Z' };
    await store.write('alpha', cleared);
    assert.deepEqual(await store.read('alpha'), cleared);
    assert.equal(await store.read('bravo'), undefined);
    assert.deepEqual(files.paths(), [normalisePath(join(PATHS.sessions, 'alpha.json'))]);
  });
});

describe('parseSessionRecord', () => {
  it('reads what formatSessionRecord wrote', () => {
    assert.deepEqual(parseSessionRecord(formatSessionRecord(RECORD)), RECORD);
  });

  it('reads a damaged file, another format or a bad field as absent', () => {
    const line = (fields: Record<string, unknown>): string => JSON.stringify({ v: 1, ...RECORD, ...fields });
    for (const text of ['{not json', JSON.stringify({ ...RECORD, v: 2 }), line({ claudePid: 0 }), line({ claudePid: -4 }), line({ claudePid: '6900' }), line({ claudeSession: 7 }), line({ at: null }), line({ at: 'yesterday' })]) {
      assert.equal(parseSessionRecord(text), undefined, text);
    }
  });
});
