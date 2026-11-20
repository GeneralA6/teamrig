import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatWatchLease, IDLE_STOP_MS, idleDone, leaseHeld, leaseOutdated, LIFETIME_MS, lifetimeDone, parseWatchLease, readDue, RETRY_MS } from './watch.ts';

const NOW = Date.UTC(2029, 11, 25, 9);
const MINUTE = 60_000;

describe('the watch lease', () => {
  it('reads back what it writes, with or without a pid', () => {
    for (const lease of [
      { pid: 4242, kitVersion: '1.2.3', startedAt: NOW - MINUTE, beatAt: NOW },
      { pid: undefined, kitVersion: '1.2.3', startedAt: NOW, beatAt: NOW },
    ]) {
      assert.deepEqual(parseWatchLease(formatWatchLease(lease)), lease);
    }
  });

  it('reads no lease from a damaged file, another format or a bad field', () => {
    for (const text of ['', 'not json', '{"v":2,"kitVersion":"1.2.3","startedAt":1,"beatAt":1}', '{"v":1,"startedAt":1,"beatAt":1}', '{"v":1,"kitVersion":5,"startedAt":1,"beatAt":1}', '{"v":1,"kitVersion":"1.2.3","startedAt":"x","beatAt":1}', '{"v":1,"kitVersion":"1.2.3","pid":-3,"startedAt":1,"beatAt":1}', '{"v":1,"kitVersion":"1.2.3","pid":1.5,"startedAt":1,"beatAt":1}']) {
      assert.equal(parseWatchLease(text), undefined, text);
    }
  });

  it('holds while the beat is within three probe intervals and two minutes, either way of now', () => {
    const lease = (beatAt: number) => ({ pid: 7, kitVersion: '1.2.3', startedAt: NOW - 60 * MINUTE, beatAt });
    assert.equal(leaseHeld(undefined, NOW, 60), false);
    assert.equal(leaseHeld(lease(NOW - 5 * MINUTE), NOW, 60), true);
    assert.equal(leaseHeld(lease(NOW - 5 * MINUTE - 1), NOW, 60), false);
    assert.equal(leaseHeld(lease(NOW - 31 * MINUTE), NOW, 600), true);
    assert.equal(leaseHeld(lease(NOW + 5 * MINUTE), NOW, 60), true);
    assert.equal(leaseHeld(lease(NOW + 6 * MINUTE), NOW, 60), false);
  });

  it('is outdated only for a kit older than ours, or one that does not read as a version', () => {
    const of = (kitVersion: string) => ({ pid: 7, kitVersion, startedAt: NOW, beatAt: NOW });
    assert.equal(leaseOutdated(of('1.2.2'), '1.2.3'), true);
    assert.equal(leaseOutdated(of('0.9.9'), '1.0.0'), true);
    assert.equal(leaseOutdated(of('nightly'), '1.2.3'), true);
    assert.equal(leaseOutdated(of('1.2.3'), '1.2.3'), false);
    assert.equal(leaseOutdated(of('1.10.0'), '1.9.9'), false);
    // A kit whose own version does not read as one cannot judge another's age, so it takes nothing over.
    assert.equal(leaseOutdated(of('1.2.3'), 'dev'), false);
  });
});

describe('lifetimeDone', () => {
  it('ends a watch once it ran its 24 hours, and never one whose start is dated ahead of now', () => {
    assert.equal(LIFETIME_MS, 24 * 60 * MINUTE);
    assert.equal(lifetimeDone(NOW - LIFETIME_MS + 1, NOW), false);
    assert.equal(lifetimeDone(NOW - LIFETIME_MS, NOW), true);
    assert.equal(lifetimeDone(NOW + MINUTE, NOW), false);
  });
});

describe('readDue', () => {
  it('never syncs on an unchanged round, and syncs the first change', () => {
    assert.equal(readDue(undefined, 'unchanged', NOW), false);
    assert.equal(readDue({ at: NOW - 600 * MINUTE, ok: false }, 'unchanged', NOW), false);
    assert.equal(readDue(undefined, 'changed', NOW), true);
    assert.equal(readDue(undefined, 'failed', NOW), true);
  });

  it('syncs each change after a good sync at once, and after a failed one only once the retry time passed', () => {
    assert.equal(readDue({ at: NOW - MINUTE, ok: true }, 'changed', NOW), true);
    assert.equal(readDue({ at: NOW - RETRY_MS + 1, ok: false }, 'changed', NOW), false);
    assert.equal(readDue({ at: NOW - RETRY_MS, ok: false }, 'changed', NOW), true);
  });

  it('syncs a failing round once the retry time passed since the last sync, good or not, or the clock went back', () => {
    assert.equal(readDue({ at: NOW - MINUTE, ok: true }, 'failed', NOW), false);
    assert.equal(readDue({ at: NOW - RETRY_MS, ok: true }, 'failed', NOW), true);
    assert.equal(readDue({ at: NOW + MINUTE, ok: false }, 'failed', NOW), true);
  });
});

describe('idleDone', () => {
  it('stops once no session ran for the idle time', () => {
    assert.equal(idleDone(undefined, NOW), false);
    assert.equal(idleDone(NOW - IDLE_STOP_MS + 1, NOW), false);
    assert.equal(idleDone(NOW - IDLE_STOP_MS, NOW), true);
  });
});
