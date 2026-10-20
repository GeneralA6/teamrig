import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { NewerDataError } from '../core/jsonl.ts';
import { fieldPaths } from '../testing/field-paths.ts';
import { MemoryFiles } from '../testing/memory-files.ts';
import { BURST_FORMAT, BurstLog, burstRecordOf, parseBurstRecord } from './burst-log.ts';
import type { Burst, BurstEnd } from './burst.ts';

const NOW = Date.parse('2030-01-08T10:00:00Z');
const PATH = '/kit/teams/app/state/usage/bursts.jsonl';

const SURPLUS: Burst = {
  kind: 'surplus',
  sessions: ['alpha', 'bravo'],
  helpers: 3,
  hires: 1,
  dailyPct: 19.75,
  stopPct: 99.5,
  endsAt: Date.parse('2030-01-09T00:00:00Z'),
  tasks: [],
  reason: 'week-end surplus',
  approvedBy: 'owner',
  by: 'lead',
  at: NOW,
};
const DEADLINE: Burst = {
  kind: 'deadline',
  sessions: ['alpha'],
  helpers: 2,
  hires: 0,
  dailyPct: 10,
  stopPct: 80,
  endsAt: Date.parse('2030-01-08T20:00:00Z'),
  tasks: ['T1'],
  deadline: Date.parse('2030-01-08T20:00:00Z'),
  reason: 'release',
  by: 'lead',
  at: NOW + 1,
};
const END: BurstEnd = { kind: 'end', burstAt: NOW, reason: 'done early', by: 'lead', at: NOW + 2 };

describe('burst records', () => {
  it('write the pinned fields of their format: a field added to a burst or an end raises BURST_FORMAT', () => {
    const written: Readonly<Record<number, { readonly burst: readonly string[]; readonly end: readonly string[] }>> = {
      1: {
        burst: ['approvedBy', 'at', 'by', 'dailyPct', 'deadline', 'endsAt', 'helpers', 'hires', 'kind', 'reason', 'sessions[]', 'stopPct', 'tasks[]', 'v'],
        end: ['at', 'burstAt', 'by', 'kind', 'reason', 'v'],
      },
    };
    const full: Burst = { ...DEADLINE, approvedBy: 'owner' };
    assert.deepEqual({ burst: fieldPaths(burstRecordOf(full)), end: fieldPaths(burstRecordOf(END)) }, written[BURST_FORMAT]);
  });

  it('round-trips a surplus burst, a deadline burst and an end, with instants as ISO strings', () => {
    for (const record of [SURPLUS, DEADLINE, END]) {
      assert.deepEqual(parseBurstRecord(burstRecordOf(record)), record);
    }
    assert.equal(burstRecordOf(SURPLUS)['endsAt'], '2030-01-09T00:00:00.000Z');
    assert.equal('deadline' in burstRecordOf(SURPLUS), false);
    assert.equal('approvedBy' in burstRecordOf(DEADLINE), false);
  });

  it('reads damage as nothing', () => {
    const start = burstRecordOf(SURPLUS);
    for (const damage of [
      { kind: 'sprint' },
      { sessions: 'alpha' },
      { helpers: -1 },
      { hires: 1.5 },
      { tasks: [1] },
      { dailyPct: 101 },
      { stopPct: Number.NaN },
      { endsAt: 'soon' },
      { reason: undefined },
      { by: 3 },
      { at: 5 },
      { deadline: 'soon' },
      { approvedBy: 7 },
    ]) {
      assert.equal(parseBurstRecord({ ...start, ...damage }), undefined, JSON.stringify(damage));
    }
    const stop = burstRecordOf(END);
    for (const damage of [{ burstAt: 'then' }, { reason: 1 }, { by: undefined }, { at: 'now' }]) {
      assert.equal(parseBurstRecord({ ...stop, ...damage }), undefined, JSON.stringify(damage));
    }
  });
});

describe('BurstLog', () => {
  it('appends whole lines and reads them back, skipping damaged ones', async () => {
    const files = new MemoryFiles({ [PATH]: '{"v":1,"kind":"surplus"}' });
    const log = new BurstLog(files, PATH);
    await log.append(SURPLUS);
    await log.append(END);
    assert.deepEqual(await log.read(), { records: [SURPLUS, END], skipped: 1 });
    assert.equal((await files.read(PATH))?.split('\n').filter((line) => line !== '').length, 3);
  });

  it('starts a missing log, and refuses to write beside a newer teamrig', async () => {
    const empty = new BurstLog(new MemoryFiles(), PATH);
    assert.deepEqual(await empty.read(), { records: [], skipped: 0 });
    await empty.append(DEADLINE);
    assert.deepEqual((await empty.read()).records, [DEADLINE]);
    const newer = new BurstLog(new MemoryFiles({ [PATH]: `{"v":${BURST_FORMAT + 1},"kind":"surplus"}\n` }), PATH);
    assert.deepEqual(await newer.read(), { records: [], skipped: 1 });
    await assert.rejects(newer.append(SURPLUS), NewerDataError);
  });
});
