import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { NewerDataError } from '../core/jsonl.ts';
import { MemoryFiles } from '../testing/memory-files.ts';
import { activeHires, HIRE_FORMAT, HiringLog, parseHiringRecord, rehiredFrom, retiredSessions, type HireRecord, type RetireRecord } from './log.ts';

const PATH = '/kit/teams/app/state/hires.jsonl';
const AT = Date.parse('2030-01-08T10:00:00Z');

function hire(overrides: Partial<HireRecord> = {}): HireRecord {
  return { kind: 'hire', session: 'helper', scope: 'port the importer', reason: 'release week', dailyPct: 1, reviewBy: '2030-01-15', by: 'lead', at: AT, ...overrides };
}

function retire(overrides: Partial<RetireRecord> = {}): RetireRecord {
  return { kind: 'retire', session: 'helper', reason: 'its tasks are closed', by: 'lead', at: AT + 1000, ...overrides };
}

describe('parseHiringRecord', () => {
  it('reads a hire and a retire with their optional fields', () => {
    const full = hire({ approvedBy: 'owner', model: 'opus', effort: 'high' });
    assert.deepEqual(parseHiringRecord({ kind: 'hire', session: 'helper', scope: 'port the importer', reason: 'release week', approvedBy: 'owner', model: 'opus', effort: 'high', dailyPct: 1, reviewBy: '2030-01-15', by: 'lead', at: '2030-01-08T10:00:00.000Z' }), full);
    assert.deepEqual(
      parseHiringRecord({ kind: 'retire', session: 'helper', reason: 'done', handover: 'handover/helper.md', heir: 'alpha', by: 'lead', at: '2030-01-08T10:00:00.000Z' }),
      retire({ reason: 'done', handover: 'handover/helper.md', heir: 'alpha', at: AT }),
    );
    assert.deepEqual(
      parseHiringRecord({ kind: 'retire', session: 'helper', reason: 'done', noHandover: 'nothing to hand over', by: 'helper', at: '2030-01-08T10:00:00.000Z' }),
      retire({ reason: 'done', noHandover: 'nothing to hand over', by: 'helper', at: AT }),
    );
  });

  it('reads back the burst a hire was for', () => {
    const record = { kind: 'hire', session: 'helper', scope: 'port the importer', reason: 'release week', dailyPct: 1, reviewBy: '2030-01-15', by: 'lead', at: '2030-01-08T10:00:00.000Z', burst: '2030-01-08T09:00:00.000Z' };
    assert.deepEqual(parseHiringRecord(record), hire({ burst: AT - 3_600_000 }));
    assert.equal(parseHiringRecord({ ...record, burst: 'last night' }), undefined);
  });

  it('skips a damaged record', () => {
    const good = { kind: 'hire', session: 'helper', scope: 'x', reason: 'y', dailyPct: 1, reviewBy: '2030-01-15', by: 'lead', at: '2030-01-08T10:00:00Z' };
    assert.notEqual(parseHiringRecord(good), undefined);
    for (const damage of [{ kind: 'fire' }, { session: 7 }, { at: 'soon' }, { scope: undefined }, { reviewBy: 'next week' }, { dailyPct: 0 }, { dailyPct: 101 }, { dailyPct: '1' }, { effort: 'extreme' }]) {
      assert.equal(parseHiringRecord({ ...good, ...damage }), undefined, JSON.stringify(damage));
    }
  });
});

describe('activeHires', () => {
  it('keeps the sessions whose newest record is a hire, with that hire', () => {
    const rehire = hire({ at: AT + 2000, scope: 'second round' });
    const records = [hire(), hire({ session: 'other' }), retire(), rehire, hire({ session: 'gone' }), retire({ session: 'gone' })];
    assert.deepEqual(activeHires(records), [rehire, hire({ session: 'other' })]);
    assert.deepEqual(activeHires([]), []);
  });
});

describe('retiredSessions', () => {
  it('keeps the sessions whose newest record is a retire, with that retire', () => {
    const records = [hire(), hire({ session: 'other' }), retire(), hire({ session: 'back' }), retire({ session: 'back' }), hire({ session: 'back', at: AT + 2000 })];
    assert.deepEqual(retiredSessions(records), [retire()]);
    assert.deepEqual(retiredSessions([]), []);
  });
});

describe('rehiredFrom', () => {
  it("finds the retire before a session's newest hire, only while it is hired back", () => {
    const first = retire({ session: 'back', at: AT + 1000 });
    const records = [hire({ session: 'back' }), hire(), first, hire({ session: 'back', at: AT + 2000 })];
    assert.deepEqual(rehiredFrom(records, 'back'), first);
    assert.equal(rehiredFrom(records, 'helper'), undefined, 'a first hire came back from nothing');
    assert.equal(rehiredFrom([...records, retire({ session: 'back', at: AT + 3000 })], 'back'), undefined, 'retired again');
    assert.equal(rehiredFrom(records, 'nobody'), undefined);
  });
});

describe('HiringLog', () => {
  it('appends whole lines and reads them back, skipping damaged ones', async () => {
    const files = new MemoryFiles({ [PATH]: '{"v":1,"kind":"hire"}' });
    const log = new HiringLog(files, PATH);
    await log.append(hire({ effort: 'xhigh', burst: AT }));
    await log.append(retire({ heir: 'alpha' }));
    assert.deepEqual(await log.read(), { records: [hire({ effort: 'xhigh', burst: AT }), retire({ heir: 'alpha' })], skipped: 1 });
    assert.equal((await files.read(PATH))?.split('\n').filter((line) => line !== '').length, 3);
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
