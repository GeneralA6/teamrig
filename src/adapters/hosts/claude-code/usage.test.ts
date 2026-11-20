import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { usageMeter } from './usage.ts';

describe("Claude Code's usage meter", () => {
  const usage = { input: 4, cacheWrite5m: 8, cacheWrite1h: 10, cacheWriteUnsplit: 20, cacheRead: 1_000, output: 30 };

  it('prices each kind of token against a plain input token', () => {
    assert.deepEqual(usageMeter.weights, { input: 1, cacheWrite5m: 1.25, cacheWrite1h: 2, cacheWriteUnsplit: 2, cacheRead: 0.1, output: 5 });
    assert.equal(usageMeter.ofCall(usage), 4 + 8 * 1.25 + 10 * 2 + 20 * 2 + 1_000 * 0.1 + 30 * 5);
  });

  it('prices each kind alone at its weight, and a call that used nothing at nothing', () => {
    const none = { input: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheWriteUnsplit: 0, cacheRead: 0, output: 0 };
    assert.equal(usageMeter.ofCall(none), 0);
    assert.equal(usageMeter.ofCall({ ...none, output: 7 }), 7 * usageMeter.weights.output);
    assert.equal(usageMeter.ofCall({ ...none, cacheRead: 50 }), 50 * usageMeter.weights.cacheRead);
  });

  it('reads the context as everything the call was sent, its output left out', () => {
    assert.equal(usageMeter.contextReading(usage), 1_042);
  });

  it('takes 2.28 characters of tool output for one token', () => {
    assert.equal(usageMeter.charsPerToken, 2.28);
  });
});
