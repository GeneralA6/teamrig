import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { NewerDataError } from '../core/jsonl.ts';
import { MemoryFiles } from '../testing/memory-files.ts';
import { HiringLog } from './log.ts';
import { HIRE_FORMAT, type HireRecord, type KeepRecord, type RetireRecord } from './record.ts';

const PATH = '/kit/teams/app/state/hires.jsonl';
const AT = Date.parse('2030-01-08T10:00:00Z');

function hire(overrides: Partial<HireRecord> = {}): HireRecord {
  return { kind: 'hire', session: 'helper', scope: 'port the importer', reason: 'release week', reviewBy: '2030-01-15', by: 'lead', at: AT, ...overrides };
}

function retire(overrides: Partial<RetireRecord> = {}): RetireRecord {
  return { kind: 'retire', session: 'helper', reason: 'its tasks are closed', by: 'lead', at: AT + 1000, ...overrides };
}

describe('HiringLog', () => {
  it('appends whole lines and reads them back, skipping damaged ones', async () => {
    const files = new MemoryFiles({ [PATH]: '{"v":1,"kind":"hire"}' });
    const log = new HiringLog(files, PATH);
    const keep: KeepRecord = { kind: 'keep', session: 'helper', reviewBy: '2030-02-01', reason: 'the importer grew', by: 'lead', at: AT + 500 };
    await log.append(hire({ effort: 'xhigh', burst: AT }));
    await log.append(keep);
    await log.append(retire({ heir: 'alpha' }));
    assert.deepEqual(await log.read(), { records: [hire({ effort: 'xhigh', burst: AT }), keep, retire({ heir: 'alpha' })], skipped: 1 });
    assert.equal((await files.read(PATH))?.split('\n').filter((line) => line !== '').length, 4);
    assert.match(await files.read(PATH) ?? '', /\{"v":2,"kind":"keep","session":"helper","reason":"the importer grew","by":"lead","at":"2030-01-08T10:00:00\.500Z","reviewBy":"2030-02-01"\}/);
    assert.match(await files.read(PATH) ?? '', new RegExp(`\\{"v":${HIRE_FORMAT},"kind":"retire"`));
  });

  it("still counts a format-1 hire, its fixed daily % ignored", async () => {
    const v1 = { v: 1, kind: 'hire', session: 'helper', scope: 'port the importer', reason: 'release week', dailyPct: 1, reviewBy: '2030-01-15', by: 'lead', at: '2030-01-08T10:00:00.000Z' };
    const log = new HiringLog(new MemoryFiles({ [PATH]: `${JSON.stringify(v1)}\n` }), PATH);
    assert.deepEqual(await log.read(), { records: [hire()], skipped: 0 });
    await log.append(retire());
    assert.deepEqual((await log.read()).records, [hire(), retire()]);
  });

  it('starts a missing log, and refuses to write beside a newer teamrig', async () => {
    const empty = new HiringLog(new MemoryFiles(), PATH);
    assert.deepEqual(await empty.read(), { records: [], skipped: 0 });
    await empty.append(hire());
    assert.equal((await empty.read()).records.length, 1);
    const newer = new HiringLog(new MemoryFiles({ [PATH]: `{"v":${HIRE_FORMAT + 1},"kind":"hire"}\n` }), PATH);
    assert.deepEqual(await newer.read(), { records: [], skipped: 1 });
    await assert.rejects(newer.append(hire()), NewerDataError);
  });
});
