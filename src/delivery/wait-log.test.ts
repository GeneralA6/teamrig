import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FakeClock } from '../testing/fake-clock.ts';
import type { HostLockInfo, LockWait } from './host-lock.ts';
import { causeOfLockWait, WaitLog, type WaitCause } from './wait-log.ts';

const QUEUED = Date.parse('2030-01-08T10:00:00Z');
const INFO: HostLockInfo = { id: 'lock-1', pid: 77, session: 'po', purpose: 'build api', acquiredAt: '2030-01-08T09:58:00Z', expiresAt: '2030-01-08T10:58:00Z' };

describe('WaitLog', () => {
  it('sums the wait by cause, each reason counting until the next one, and leaves out the causes that took no time', () => {
    const clock = new FakeClock(QUEUED);
    const log = new WaitLog(clock, 6100);
    log.tell({ cause: 'line', text: 'po (build api), first in line' });
    log.tell({ cause: 'lock', text: 'po (build api) since 11:58' });
    clock.advance(60_000);
    log.tell({ cause: 'memory', text: 'host memory short' });
    clock.advance(30_000);
    log.tell({ cause: 'lock', text: 'beta (merge api) since 12:01' });
    clock.advance(10_000);
    assert.deepEqual(log.end(), { queuedAt: QUEUED, waits: { lock: 70_000, memory: 30_000 }, queueFreeMb: 6100 });
  });

  it('counts no cause before the first reason, and none at all for a step that never waited', () => {
    const clock = new FakeClock(QUEUED);
    const log = new WaitLog(clock);
    clock.advance(5_000);
    assert.equal(log.last(), undefined);
    assert.deepEqual(log.end(), { queuedAt: QUEUED, waits: {} });
  });

  it('keeps the last reason after the wait ends, and counts nothing past the end', () => {
    const clock = new FakeClock(QUEUED);
    const log = new WaitLog(clock, 4000);
    log.tell({ cause: 'freeze', text: 'deploy freeze by po on api' });
    clock.advance(20_000);
    log.tell({ cause: 'check', text: 'check flow holds the deploy' });
    clock.advance(15_000);
    const waited = log.end();
    clock.advance(99_000);
    assert.deepEqual(log.last(), { cause: 'check', text: 'check flow holds the deploy' });
    assert.deepEqual(waited.waits, { freeze: 20_000, check: 15_000 });
    assert.deepEqual(log.end().waits, waited.waits);
  });
});

describe('causeOfLockWait', () => {
  it('names the cause of each wait on the host lock, a lock still being written counting as held, a step being admitted as the line', () => {
    const waits: readonly (readonly [LockWait, WaitCause])[] = [
      [{ kind: 'held', info: INFO }, 'lock'],
      [{ kind: 'unknown' }, 'lock'],
      [{ kind: 'queued', first: { id: 'ticket-1', pid: 78, session: 'beta', purpose: 'merge api', arrivedAt: INFO.acquiredAt, expiresAt: INFO.expiresAt } }, 'line'],
      [{ kind: 'draining', shares: [{ ...INFO, reserveMb: 1024 }] }, 'draining'],
      [{ kind: 'memory', freeMb: 3000, heldMb: 0, needMb: 8000, floorMb: 2000, reserveMb: 6000, shares: [] }, 'memory'],
      [{ kind: 'commit', usedMb: 60_000, limitMb: 64_000, maxPct: 90, reserveMb: 6000, shares: [] }, 'commit'],
      [{ kind: 'sessionCap', cap: 2, running: [INFO] }, 'session'],
      [{ kind: 'admitting' }, 'line'],
    ];
    assert.deepEqual(
      waits.map(([wait]) => causeOfLockWait(wait)),
      waits.map(([, cause]) => cause),
    );
  });
});
