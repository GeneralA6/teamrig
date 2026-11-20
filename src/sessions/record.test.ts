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
    assert.deepEqual([...(await store.readEach(['bravo', 'alpha']))], [
      ['bravo', undefined],
      ['alpha', cleared],
    ]);
  });
});

describe('parseSessionRecord', () => {
  it('reads what formatSessionRecord wrote, with the transcript or without it as an older record has none', () => {
    const withTranscript: SessionRecord = { ...RECORD, transcript: join('/', 'claude', 'projects', 'w-fix', 'claude-1.jsonl') };
    assert.deepEqual(parseSessionRecord(formatSessionRecord(withTranscript)), withTranscript);
    assert.deepEqual(parseSessionRecord(formatSessionRecord(RECORD)), RECORD);
  });

  it('writes a record as the very line every installed teamrig reads (T4762)', () => {
    // The record's own keys are spread into the line, so a renamed property renames the key on disk: this line may
    // change only in the commit that raises the written format.
    assert.equal(formatSessionRecord(RECORD), '{"v":1,"claudePid":6900,"claudeSession":"claude-1","at":"2030-01-08T10:00:00.000Z"}\n');
  });

  it('reads a record a later teamrig wrote, naming the tab hostSession, and one newer still as absent (T4762)', () => {
    const later = { v: 2, claudePid: 6900, hostSession: 'claude-1', at: '2030-01-08T10:00:00.000Z' };
    assert.deepEqual(parseSessionRecord(`${JSON.stringify(later)}\n`), RECORD);
    assert.deepEqual(parseSessionRecord(JSON.stringify({ ...later, transcript: 't.jsonl' })), { ...RECORD, transcript: 't.jsonl' });
    assert.equal(parseSessionRecord(JSON.stringify({ ...later, v: 3 })), undefined);
    assert.equal(parseSessionRecord(JSON.stringify({ ...later, hostSession: 7 })), undefined);
  });

  it('reads a damaged file, another format or a bad field as absent', () => {
    const line = (fields: Record<string, unknown>): string => JSON.stringify({ v: 1, ...RECORD, ...fields });
    const badTranscripts = [line({ transcript: 7 }), line({ transcript: '' }), line({ transcript: null })];
    for (const text of ['{not json', JSON.stringify({ ...RECORD, v: 3 }), JSON.stringify({ ...RECORD, v: 0 }), JSON.stringify(RECORD), line({ claudePid: 0 }), line({ claudePid: -4 }), line({ claudePid: '6900' }), line({ claudeSession: 7 }), line({ at: null }), line({ at: 'yesterday' }), ...badTranscripts]) {
      assert.equal(parseSessionRecord(text), undefined, text);
    }
  });
});
