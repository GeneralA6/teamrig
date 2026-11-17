import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

/**
 * Runs `work` and fails when it took longer than `maxMs`. A spec's `timeout` cannot stop synchronous code (a
 * backtracking regex holds the thread until it ends, and the spec then passes), so a spec that holds a parser to
 * linear time on outside text measures the run itself. The bound sits far above the linear run and far below the
 * super-linear one, so a slow machine does not fail it.
 */
export async function assertWithin<T>(maxMs: number, work: () => T | Promise<T>): Promise<T> {
  const start = performance.now();
  const result = await work();
  const took = performance.now() - start;
  assert.ok(took <= maxMs, `took ${Math.round(took)} ms, over the ${maxMs} ms bound`);
  return result;
}
