import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { contextTokens, usageOf, weightOf } from './weights.ts';

describe('usageOf', () => {
  it('reads every count and splits cache writes by lifetime, the rest unsplit', () => {
    const message = {
      usage: {
        input_tokens: 3,
        cache_creation_input_tokens: 1_000,
        cache_read_input_tokens: 50_000,
        output_tokens: 200,
        cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 600 },
      },
    };
    assert.deepEqual(usageOf(message), { input: 3, cacheWrite5m: 100, cacheWrite1h: 600, cacheWriteUnsplit: 300, cacheRead: 50_000, output: 200 });
  });

  it('reads a missing or null count as 0 and a write without a split as unsplit', () => {
    assert.equal(usageOf({ usage: { input_tokens: null } })?.input, 0);
    assert.deepEqual(usageOf({ usage: { cache_creation_input_tokens: 40 } }), {
      input: 0,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
      cacheWriteUnsplit: 40,
      cacheRead: 0,
      output: 0,
    });
  });

  it('never makes the unsplit part negative when the split exceeds the total', () => {
    const usage = usageOf({ usage: { cache_creation_input_tokens: 10, cache_creation: { ephemeral_1h_input_tokens: 25 } } });
    assert.equal(usage?.cacheWriteUnsplit, 0);
    assert.equal(usage?.cacheWrite1h, 25);
  });

  it('refuses a message without usage and any damaged count', () => {
    assert.equal(usageOf({}), undefined);
    assert.equal(usageOf({ usage: 'none' }), undefined);
    for (const damaged of [-1, 1.5, '7']) {
      assert.equal(usageOf({ usage: { input_tokens: damaged } }), undefined);
      assert.equal(usageOf({ usage: { output_tokens: damaged } }), undefined);
      assert.equal(usageOf({ usage: { cache_creation_input_tokens: damaged } }), undefined);
      assert.equal(usageOf({ usage: { cache_read_input_tokens: damaged } }), undefined);
      assert.equal(usageOf({ usage: { cache_creation: { ephemeral_5m_input_tokens: damaged } } }), undefined);
      assert.equal(usageOf({ usage: { cache_creation: { ephemeral_1h_input_tokens: damaged } } }), undefined);
    }
  });
});

describe('contextTokens and weightOf', () => {
  const usage = { input: 4, cacheWrite5m: 8, cacheWrite1h: 10, cacheWriteUnsplit: 20, cacheRead: 1_000, output: 30 };

  it('adds everything the call read', () => {
    assert.equal(contextTokens(usage), 1_042);
  });

  it('prices each kind against a plain input token', () => {
    assert.equal(weightOf(usage), 4 + 8 * 1.25 + 10 * 2 + 20 * 2 + 1_000 * 0.1 + 30 * 5);
  });
});
