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

  it("reads the plan's windows from the status input's rate_limits, their resets from epoch seconds", () => {
    const status = JSON.stringify({
      session_id: 'a',
      rate_limits: { five_hour: { used_percentage: 6.5, resets_at: 1_700_000_000 }, seven_day: { used_percentage: 57, resets_at: 1_700_400_000 } },
    });
    assert.deepEqual(usageMeter.weekReading(`${status}\n`), {
      fiveHour: { usedPct: 6.5, resetsAt: 1_700_000_000_000 },
      sevenDay: { usedPct: 57, resetsAt: 1_700_400_000_000 },
    });
  });

  it('reads one window alone, the other as null', () => {
    const week = JSON.stringify({ rate_limits: { seven_day: { used_percentage: 12, resets_at: 1_700_400_000 } } });
    assert.deepEqual(usageMeter.weekReading(week), { fiveHour: null, sevenDay: { usedPct: 12, resetsAt: 1_700_400_000_000 } });
    const torn = JSON.stringify({ rate_limits: { five_hour: { used_percentage: 3, resets_at: 1_700_000_000 }, seven_day: { used_percentage: '12' } } });
    assert.deepEqual(usageMeter.weekReading(torn), { fiveHour: { usedPct: 3, resetsAt: 1_700_000_000_000 }, sevenDay: null });
  });

  it('has no reading without rate_limits, with no whole window, or for a text that is no status input', () => {
    assert.equal(usageMeter.weekReading(JSON.stringify({ session_id: 'a' })), undefined);
    assert.equal(usageMeter.weekReading(JSON.stringify({ rate_limits: null })), undefined);
    assert.equal(usageMeter.weekReading(JSON.stringify({ rate_limits: { seven_day: { used_percentage: 12 } } })), undefined);
    assert.equal(usageMeter.weekReading(JSON.stringify({ rate_limits: { seven_day: { used_percentage: Number.NaN, resets_at: 1 } } })), undefined);
    assert.equal(usageMeter.weekReading('not json'), undefined);
    assert.equal(usageMeter.weekReading('[1]'), undefined);
  });
});
