import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { LedgerRecord, QueuedStepRecord, RefusalRecord } from './ledger.ts';
import { learnedNeedOf, NEED_RUNS, stepNeedOf, type NeedAsk, type NeedDefaults } from './step-need.ts';

const ASK: NeedAsk = { session: 'alpha', what: 'T7 build', kind: 'build', small: false };
const DEFAULTS: NeedDefaults = { smallReserveMb: 2048, heavyReserveMb: 4096 };

/** What a run measured, and what sets it apart from alpha's heavy `build` runs. */
type RunFields = Partial<Pick<QueuedStepRecord, 'session' | 'kind' | 'shared' | 'peakTreeMb' | 'startFreeMb' | 'lowFreeMb' | 'endedAt'>>;

let runs = 0;

/** An ended run of `what` by alpha, a build, the day before, with `fields`. */
function ran(what: string, fields: RunFields): QueuedStepRecord {
  runs += 1;
  return { type: 'heavy', id: `run-${runs}`, session: 'alpha', what, kind: 'build', startedAt: '2030-01-07T10:00:00.000Z', endedAt: '2030-01-07T10:05:00.000Z', exitCode: 0, ...fields };
}

/** An ended run whose host went from `startFreeMb` to at least `lowFreeMb` free while its tree held `peakTreeMb`. */
function dropped(what: string, peakTreeMb: number, startFreeMb: number, lowFreeMb: number): QueuedStepRecord {
  return ran(what, { peakTreeMb, startFreeMb, lowFreeMb });
}

describe('learnedNeedOf', () => {
  it(`learns from the latest ${NEED_RUNS} runs of the same session and label: their most held, with a quarter more`, () => {
    const records = [ran('T7 build', { peakTreeMb: 9000 }), ...Array.from({ length: 19 }, () => ran('T7 build', { peakTreeMb: 1000 })), ran('T7 build', { peakTreeMb: 1900 })];
    assert.deepEqual(learnedNeedOf(records, ASK), { reserveMb: 2375, medianMinutes: 5, runs: 20, from: 'label' });
  });

  it('learns the median minutes the same runs took, start to end, unrounded, a clock set back counting none', () => {
    const took = (what: string, endedAt: string): QueuedStepRecord => ran(what, { peakTreeMb: 1000, endedAt });
    const odd = [took('T7 build', '2030-01-07T10:02:00.000Z'), took('T7 build', '2030-01-07T10:30:00.000Z'), took('T7 build', '2030-01-07T10:04:00.000Z')];
    assert.equal(learnedNeedOf(odd, ASK)?.medianMinutes, 4);
    const even = [took('T7 build', '2030-01-07T10:03:00.000Z'), took('T7 build', '2030-01-07T10:06:30.000Z')];
    assert.equal(learnedNeedOf(even, ASK)?.medianMinutes, 4.75, 'the mean of 3 and 6.5 minutes');
    assert.equal(learnedNeedOf([took('T7 build', '2030-01-07T09:00:00.000Z')], ASK)?.medianMinutes, 0);
    const older = [took('T7 build', '2030-01-07T11:00:00.000Z'), ...Array.from({ length: NEED_RUNS }, () => took('T7 build', '2030-01-07T10:01:00.000Z'))];
    assert.equal(learnedNeedOf(older, ASK)?.medianMinutes, 1, `a run before the latest ${NEED_RUNS} counts for nothing`);
  });

  it('takes the median of what the host lost while its runs ran when that passes their peak', () => {
    const records = [dropped('T7 build', 1000, 12_000, 9000), dropped('T7 build', 1000, 12_000, 2000), dropped('T7 build', 1000, 12_000, 8800)];
    assert.deepEqual(learnedNeedOf(records, ASK), { reserveMb: 3200, medianMinutes: 5, runs: 3, from: 'label' }, 'drops 3000, 10000 and 3200: one spike does not pin it');
  });

  it('rounds up the mean of the two middle drops of an even count, and counts a rise in free memory as no drop', () => {
    assert.equal(learnedNeedOf([dropped('T7 build', 100, 9000, 6000), dropped('T7 build', 100, 9000, 5799)], ASK)?.reserveMb, 3101);
    assert.equal(learnedNeedOf([dropped('T7 build', 800, 5000, 6000)], ASK)?.reserveMb, 1000, 'a run the host gained memory over counts its peak only');
  });

  it('reads only ended queued-step runs of its own session that measured something', () => {
    const refusal: RefusalRecord = { type: 'refusal', id: 'r-1', session: 'alpha', what: 'T7 build', queuedAt: '2030-01-07T10:00:00.000Z', endedAt: '2030-01-07T11:00:00.000Z', outcome: 'timedOut', reason: 'host memory still short', lastWait: { cause: 'memory', text: 'host memory short' } };
    const records: LedgerRecord[] = [ran('T7 build', { peakTreeMb: 9000, endedAt: null }), ran('T7 build', { session: 'bravo', peakTreeMb: 9000 }), ran('T7 build', {}), ran('T7 build', { startFreeMb: 9000 }), refusal];
    assert.equal(learnedNeedOf(records, ASK), undefined);
  });

  it('learns nothing from runs that measured 0 MB', () => {
    assert.equal(learnedNeedOf([ran('T7 build', { peakTreeMb: 0 })], ASK), undefined);
  });

  it('falls back to its session\'s runs of the same kind and size when no run has its label', () => {
    const records = [ran('T8 build', { peakTreeMb: 6000 }), ran('T9 build', { peakTreeMb: 2000 }), ran('lint', { kind: 'lint', peakTreeMb: 9000 }), ran('T9 build', { shared: true, peakTreeMb: 9000 }), ran('build', { peakTreeMb: 9000, session: 'bravo' })];
    assert.deepEqual(learnedNeedOf(records, ASK), { reserveMb: 7500, medianMinutes: 5, runs: 2, from: 'kind' });
    assert.deepEqual(learnedNeedOf(records, { ...ASK, small: true }), { reserveMb: 11_250, medianMinutes: 5, runs: 1, from: 'kind' },'a small step learns from small runs');
  });

  it('prefers its own label\'s runs to its kind\'s, even when they need less', () => {
    const records = [ran('T8 build', { peakTreeMb: 9000 }), ran('T7 build', { peakTreeMb: 2000 })];
    assert.deepEqual(learnedNeedOf(records, ASK), { reserveMb: 2500, medianMinutes: 5, runs: 1, from: 'label' });
  });

  it('never falls back by kind for kind other, which spans ships, checks and installs', () => {
    const records = [ran('T8 ship', { kind: 'other', peakTreeMb: 9000 })];
    assert.equal(learnedNeedOf(records, { ...ASK, what: 'T7 ship', kind: 'other' }), undefined);
    assert.deepEqual(learnedNeedOf(records, { ...ASK, what: 'T8 ship', kind: 'other' }), { reserveMb: 11_250, medianMinutes: 5, runs: 1, from: 'label' });
  });
});

describe('stepNeedOf', () => {
  it('holds delivery.queue.heavyReserveMb for a heavy step with no learned or declared need, saying no basis', () => {
    assert.deepEqual(stepNeedOf([], ASK, DEFAULTS), { shares: false, reserveMb: 4096 });
  });

  it('holds a heavy step its learned need when more than heavyReserveMb, saying it was learned', () => {
    assert.deepEqual(stepNeedOf([ran('T7 build', { peakTreeMb: 2000 }), ran('T7 build', { peakTreeMb: 6000 })], ASK, DEFAULTS), { shares: false, reserveMb: 7500, basis: 'learned from 2 runs', expectedMinutes: 5 });
    assert.deepEqual(stepNeedOf([ran('T7 build', { peakTreeMb: 2000 })], ASK, DEFAULTS), { shares: false, reserveMb: 4096, expectedMinutes: 5 }, 'heavyReserveMb holds when more');
  });

  it('names the kind a need was learned from when no run had its label', () => {
    assert.deepEqual(stepNeedOf([ran('T8 build', { peakTreeMb: 6000 })], ASK, DEFAULTS), { shares: false, reserveMb: 7500, basis: 'learned from 1 build run', expectedMinutes: 5 });
    assert.deepEqual(stepNeedOf([ran('T8 build', { peakTreeMb: 6000 }), ran('T9 build', { peakTreeMb: 100 })], ASK, DEFAULTS), { shares: false, reserveMb: 7500, basis: 'learned from 2 build runs', expectedMinutes: 5 });
  });

  it('holds the declared --memory-mb when it is at least the learned need, else the learned need', () => {
    const records = [ran('T7 build', { peakTreeMb: 6000 })];
    assert.deepEqual(stepNeedOf(records, { ...ASK, declaredMb: 9000 }, DEFAULTS), { shares: false, reserveMb: 9000, basis: 'declared with --memory-mb', expectedMinutes: 5 });
    assert.deepEqual(stepNeedOf(records, { ...ASK, declaredMb: 7500 }, DEFAULTS), { shares: false, reserveMb: 7500, basis: 'declared with --memory-mb', expectedMinutes: 5 }, 'a tie goes to the declared need');
    assert.deepEqual(stepNeedOf(records, { ...ASK, declaredMb: 5000 }, DEFAULTS), { shares: false, reserveMb: 7500, basis: 'learned from 1 run', expectedMinutes: 5 });
    assert.deepEqual(stepNeedOf([], { ...ASK, declaredMb: 3000 }, DEFAULTS), { shares: false, reserveMb: 4096 }, 'a heavy step holds heavyReserveMb at least');
  });

  it('holds a small step its learned or declared need, even under smallReserveMb, else smallReserveMb', () => {
    const small: NeedAsk = { ...ASK, what: 'lint', kind: 'lint', small: true };
    assert.deepEqual(stepNeedOf([], small, DEFAULTS), { shares: true, reserveMb: 2048 });
    assert.deepEqual(stepNeedOf([ran('lint', { kind: 'lint', shared: true, peakTreeMb: 300 })], small, DEFAULTS), { shares: true, reserveMb: 375, basis: 'learned from 1 run', expectedMinutes: 5 });
    assert.deepEqual(stepNeedOf([], { ...small, declaredMb: 500 }, DEFAULTS), { shares: true, reserveMb: 500, basis: 'declared with --memory-mb' });
  });
});
