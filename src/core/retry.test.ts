import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { REPLACE_RETRY_DELAYS_MS, retryTransient, TRANSIENT_RETRY_DELAYS_MS } from './retry.ts';

function fsError(code: string): Error {
  return Object.assign(new Error(`${code}: operation not permitted`), { code });
}

/** An operation that fails with the given codes in order, then returns `done`; it counts its calls. */
class Flaky {
  calls = 0;
  readonly slept: number[] = [];
  readonly sleep = async (ms: number): Promise<void> => {
    this.slept.push(ms);
  };
  private readonly failures: readonly string[];

  constructor(failures: readonly string[]) {
    this.failures = failures;
  }

  readonly operation = async (): Promise<string> => {
    const code = this.failures[this.calls];
    this.calls += 1;
    if (code !== undefined) {
      throw fsError(code);
    }
    return 'done';
  };
}

describe('retryTransient', () => {
  it('returns at once when the operation succeeds', async () => {
    const flaky = new Flaky([]);
    assert.equal(await retryTransient(flaky.operation, flaky.sleep), 'done');
    assert.deepEqual([flaky.calls, flaky.slept], [1, []]);
  });

  it('repeats through EPERM, EBUSY and EACCES with growing waits', async () => {
    const flaky = new Flaky(['EPERM', 'EBUSY', 'EACCES']);
    assert.equal(await retryTransient(flaky.operation, flaky.sleep), 'done');
    assert.deepEqual([flaky.calls, flaky.slept], [4, TRANSIENT_RETRY_DELAYS_MS.slice(0, 3)]);
  });

  it('throws any other error at once', async () => {
    const flaky = new Flaky(['ENOENT']);
    await assert.rejects(retryTransient(flaky.operation, flaky.sleep), { code: 'ENOENT' });
    assert.deepEqual([flaky.calls, flaky.slept], [1, []]);
  });

  it('throws an error that has no code at once', async () => {
    let calls = 0;
    const operation = async (): Promise<never> => {
      calls += 1;
      throw new Error('boom');
    };
    await assert.rejects(retryTransient(operation, async () => {}), /boom/);
    assert.equal(calls, 1);
  });

  it('gives up after the last delay, about a second in all, with the last error', async () => {
    const flaky = new Flaky(Array.from({ length: TRANSIENT_RETRY_DELAYS_MS.length + 1 }, () => 'EBUSY'));
    await assert.rejects(retryTransient(flaky.operation, flaky.sleep), { code: 'EBUSY' });
    assert.equal(flaky.calls, TRANSIENT_RETRY_DELAYS_MS.length + 1);
    assert.deepEqual(flaky.slept, TRANSIENT_RETRY_DELAYS_MS);
    const total = TRANSIENT_RETRY_DELAYS_MS.reduce((sum, ms) => sum + ms, 0);
    assert.ok(total >= 500 && total <= 1_200, `total wait ${total} ms`);
  });

  it('waits about 10 s for a file to replace, through more holds than the short budget, short waits first', async () => {
    const flaky = new Flaky(Array.from({ length: REPLACE_RETRY_DELAYS_MS.length }, () => 'EPERM'));
    assert.equal(await retryTransient(flaky.operation, flaky.sleep, REPLACE_RETRY_DELAYS_MS), 'done');
    assert.ok(REPLACE_RETRY_DELAYS_MS.length > TRANSIENT_RETRY_DELAYS_MS.length);
    assert.deepEqual(flaky.slept, REPLACE_RETRY_DELAYS_MS);
    assert.deepEqual(REPLACE_RETRY_DELAYS_MS.slice(0, TRANSIENT_RETRY_DELAYS_MS.length), TRANSIENT_RETRY_DELAYS_MS);
    const total = REPLACE_RETRY_DELAYS_MS.reduce((sum, ms) => sum + ms, 0);
    assert.ok(total >= 8_000 && total <= 12_000, `total wait ${total} ms`);
  });
});
