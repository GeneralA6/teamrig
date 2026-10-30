import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { HostLock, HostLockInfo, Taking } from '../delivery/host-lock.ts';
import type { StepRequest } from '../delivery/steps.ts';
import { KIT_VERSION } from '../core/version.ts';
import type { HookRequest } from '../deploy/hooks.ts';
import { FakeHooks } from '../testing/fake-hooks.ts';
import { FakeStarterWatch } from '../testing/fake-starter-watch.ts';
import { FakeSteps } from '../testing/fake-steps.ts';
import { stoppableHooks, stoppableLock, stoppableSleep, stoppableSteps, unlessStopped, watchStarters } from './stoppable.ts';

const HELD: HostLockInfo = { id: 't1', pid: 4242, session: 'alpha', purpose: 'merge app', kit: KIT_VERSION, acquiredAt: '2030-01-08T10:00:00.000Z', expiresAt: '2030-01-08T12:30:00.000Z' };
const STEP: StepRequest = { command: 'npm test', cwd: '/repo', env: {}, timeoutMs: 60_000 };
const HOOK: HookRequest = { argv: ['node', 'deploy.js'], cwd: '/repo', env: {}, timeoutMs: 60_000, onLine: () => undefined };

/** A lock that takes at once and keeps the stop each wait was given and each lock released. */
class SeenLock implements Pick<HostLock, 'acquire' | 'release'> {
  readonly stops: (AbortSignal | undefined)[] = [];
  readonly released: HostLockInfo[] = [];

  async acquire(...args: Parameters<HostLock['acquire']>): Promise<Taking> {
    this.stops.push(args[6]);
    return { kind: 'taken', lock: HELD };
  }

  async release(lock: HostLockInfo): Promise<boolean> {
    this.released.push(lock);
    return true;
  }
}

describe('stoppable ports', () => {
  it("gives the lock's wait the stop, or either stop when its caller passed one, and releases as asked", async () => {
    const lock = new SeenLock();
    const stop = new AbortController();
    const own = new AbortController();
    const stoppable = stoppableLock(lock, stop.signal);
    await stoppable.acquire('alpha', 'deploy app', 60_000, 30_000, () => undefined);
    await stoppable.acquire('alpha', 'deploy app', 60_000, 30_000, () => undefined, undefined, own.signal);
    await stoppable.release(HELD);
    assert.equal(lock.stops[0], stop.signal);
    own.abort();
    assert.deepEqual([lock.stops[1]?.aborted, stop.signal.aborted, lock.released], [true, false, [HELD]]);
  });

  it('sleeps as asked until the stop aborts, then rejects with its reason, before a sleep or by its end', async () => {
    const stop = new AbortController();
    const slept: number[] = [];
    const sleep = stoppableSleep(async (ms) => {
      slept.push(ms);
      if (ms === 2) {
        stop.abort();
      }
    }, stop.signal);
    await sleep(1);
    await assert.rejects(sleep(2), (error) => error === stop.signal.reason);
    await assert.rejects(sleep(3), (error) => error === stop.signal.reason);
    assert.deepEqual(slept, [1, 2]);
  });

  it('gives each step and hook the stop, or either stop when the request had one', async () => {
    const stop = new AbortController();
    const own = new AbortController();
    const steps = new FakeSteps();
    const hooks = new FakeHooks();
    await stoppableSteps(steps, stop.signal).run(STEP);
    await stoppableHooks(hooks, stop.signal).run({ ...HOOK, stop: own.signal });
    assert.equal(steps.ran[0]?.stop, stop.signal);
    stop.abort();
    assert.equal(hooks.ran[0]?.stop?.aborted, true);
  });

  it('ends a step and a hook its stop already aborted as stopped', async () => {
    const stop = new AbortController();
    stop.abort();
    assert.deepEqual([await stoppableSteps(new FakeSteps(), stop.signal).run(STEP), await stoppableHooks(new FakeHooks(), stop.signal).run(HOOK)], [{ kind: 'stopped' }, { kind: 'stopped' }]);
  });
});

describe('unlessStopped', () => {
  it('passes on what a run settles to, and an error while its stop has not aborted', async () => {
    const stop = new AbortController();
    assert.equal(await unlessStopped(stop.signal, Promise.resolve(3)), 3);
    await assert.rejects(unlessStopped(stop.signal, Promise.reject(new Error('disk full'))), /disk full/);
  });

  it('turns any error once its stop aborted into undefined', async () => {
    const stop = new AbortController();
    stop.abort();
    assert.equal(await unlessStopped(stop.signal, Promise.reject(new Error('lock file gone'))), undefined);
  });
});

describe('watchStarters', () => {
  it('says when it cannot list the processes that started this one, and says nothing when it can', async () => {
    const said: string[] = [];
    const listed = await watchStarters({ starters: new FakeStarterWatch() }, (text) => said.push(text));
    const none = await watchStarters({ starters: new FakeStarterWatch([]) }, (text) => said.push(text));
    assert.deepEqual([listed.starters.length, none.starters.length, said], [2, 0, ['could not list the processes that started this one: the step runs on if its shell ends']]);
  });
});
