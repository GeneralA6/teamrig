import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { activeHires, HIRE_FORMAT, parseHiringRecord, readHiringLog, rehiredFrom, retiredSessions, type HireRecord, type KeepRecord, type RetireRecord } from './record.ts';

const AT = Date.parse('2030-01-08T10:00:00Z');

function hire(overrides: Partial<HireRecord> = {}): HireRecord {
  return { kind: 'hire', session: 'helper', scope: 'port the importer', reason: 'release week', reviewBy: '2030-01-15', by: 'lead', at: AT, ...overrides };
}

function retire(overrides: Partial<RetireRecord> = {}): RetireRecord {
  return { kind: 'retire', session: 'helper', reason: 'its tasks are closed', by: 'lead', at: AT + 1000, ...overrides };
}

function keep(overrides: Partial<KeepRecord> = {}): KeepRecord {
  return { kind: 'keep', session: 'helper', reviewBy: '2030-02-01', reason: 'the importer grew', by: 'lead', at: AT + 500, ...overrides };
}

describe('parseHiringRecord', () => {
  it('reads a hire and a retire with their optional fields', () => {
    const full = hire({ approvedBy: 'owner', model: 'opus', effort: 'high' });
    assert.deepEqual(parseHiringRecord({ kind: 'hire', session: 'helper', scope: 'port the importer', reason: 'release week', approvedBy: 'owner', model: 'opus', effort: 'high', reviewBy: '2030-01-15', by: 'lead', at: '2030-01-08T10:00:00.000Z' }), full);
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
    const record = { kind: 'hire', session: 'helper', scope: 'port the importer', reason: 'release week', reviewBy: '2030-01-15', by: 'lead', at: '2030-01-08T10:00:00.000Z', burst: '2030-01-08T09:00:00.000Z' };
    assert.deepEqual(parseHiringRecord(record), hire({ burst: AT - 3_600_000 }));
    assert.equal(parseHiringRecord({ ...record, burst: 'last night' }), undefined);
  });

  it('skips a damaged record', () => {
    const good = { kind: 'hire', session: 'helper', scope: 'x', reason: 'y', reviewBy: '2030-01-15', by: 'lead', at: '2030-01-08T10:00:00Z' };
    assert.notEqual(parseHiringRecord(good), undefined);
    for (const damage of [{ kind: 'fire' }, { session: 7 }, { at: 'soon' }, { scope: undefined }, { reviewBy: 'next week' }, { effort: 'extreme' }]) {
      assert.equal(parseHiringRecord({ ...good, ...damage }), undefined, JSON.stringify(damage));
    }
  });

  it('reads a keep, and skips one with no review day or a bad one', () => {
    const line = { kind: 'keep', session: 'helper', reviewBy: '2030-02-01', reason: 'the importer grew', by: 'lead', at: '2030-01-08T10:00:00.500Z' };
    assert.deepEqual(parseHiringRecord(line), keep());
    assert.equal(parseHiringRecord({ ...line, reviewBy: undefined }), undefined);
    assert.equal(parseHiringRecord({ ...line, reviewBy: 'next month' }), undefined);
    assert.equal(parseHiringRecord({ ...line, reason: undefined }), undefined);
  });
});

describe('activeHires', () => {
  it('keeps the sessions whose newest record is a hire, with that hire', () => {
    const rehire = hire({ at: AT + 2000, scope: 'second round' });
    const records = [hire(), hire({ session: 'other' }), retire(), rehire, hire({ session: 'gone' }), retire({ session: 'gone' })];
    assert.deepEqual(activeHires(records), [rehire, hire({ session: 'other' })]);
    assert.deepEqual(activeHires([]), []);
  });

  it("moves a hire's review day to its newest keep's, in hire order, and nothing else of it", () => {
    const records = [hire(), hire({ session: 'other' }), keep(), keep({ reviewBy: '2030-03-01', at: AT + 600 })];
    assert.deepEqual(activeHires(records), [hire({ reviewBy: '2030-03-01' }), hire({ session: 'other' })]);
  });

  it('keeps no one with a keep after a retire or before any hire, and a rehire takes its own review day', () => {
    assert.deepEqual(activeHires([hire(), retire(), keep({ at: AT + 2000 })]), []);
    assert.deepEqual(retiredSessions([hire(), retire(), keep({ at: AT + 2000 })]), [retire()]);
    assert.deepEqual(activeHires([keep({ session: 'nobody' })]), []);
    const rehire = hire({ at: AT + 3000, reviewBy: '2030-01-20' });
    assert.deepEqual(activeHires([hire(), keep(), retire({ at: AT + 2000 }), rehire]), [rehire]);
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

  it('reads past a keep: it neither retires nor rehires', () => {
    const first = retire({ session: 'back', at: AT + 1000 });
    const records = [hire({ session: 'back' }), first, hire({ session: 'back', at: AT + 2000 }), keep({ session: 'back', at: AT + 2500 })];
    assert.deepEqual(rehiredFrom(records, 'back'), first);
    assert.equal(rehiredFrom([hire(), keep()], 'helper'), undefined);
  });
});

describe('readHiringLog', () => {
  it('reads a text without files, skipping damaged lines and lines from a newer teamrig', () => {
    const line = (record: object): string => `${JSON.stringify(record)}\n`;
    const hireLine = { v: HIRE_FORMAT, kind: 'hire', session: 'helper', scope: 'port the importer', reason: 'release week', reviewBy: '2030-01-15', by: 'lead', at: '2030-01-08T10:00:00.000Z' };
    const retireLine = { v: HIRE_FORMAT, kind: 'retire', session: 'helper', reason: 'its tasks are closed', by: 'lead', at: '2030-01-08T10:00:01.000Z' };
    const keepLine = { v: HIRE_FORMAT, kind: 'keep', session: 'helper', reviewBy: '2030-02-01', reason: 'the importer grew', by: 'lead', at: '2030-01-08T10:00:00.500Z' };
    const text = line(hireLine) + 'not json\n' + line({ ...hireLine, v: HIRE_FORMAT + 1 }) + line({ v: HIRE_FORMAT, kind: 'hire' }) + line(keepLine) + line(retireLine);
    assert.deepEqual(readHiringLog(text), { records: [hire(), keep(), retire()], skipped: 3 });
    assert.deepEqual(readHiringLog(''), { records: [], skipped: 0 });
  });
});
