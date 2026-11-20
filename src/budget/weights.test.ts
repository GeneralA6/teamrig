import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { contextTokens, modelWeightOf, weightOf } from './weights.ts';

describe('contextTokens and weightOf', () => {
  const usage = { input: 4, cacheWrite5m: 8, cacheWrite1h: 10, cacheWriteUnsplit: 20, cacheRead: 1_000, output: 30 };

  it('adds everything the call read', () => {
    assert.equal(contextTokens(usage), 1_042);
  });

  it('prices each kind against a plain input token', () => {
    assert.equal(weightOf(usage), 4 + 8 * 1.25 + 10 * 2 + 20 * 2 + 1_000 * 0.1 + 30 * 5);
  });
});

describe('modelWeightOf (T2454)', () => {
  const weights = [
    { model: 'claude-fable', weight: 4.4 },
    { model: 'claude-fable-5-1', weight: 3 },
    { model: 'claude-haiku', weight: 0.5 },
  ];

  it('takes the weight of the longest listed prefix of the model id', () => {
    assert.equal(modelWeightOf('claude-fable-5-1', weights), 3);
    assert.equal(modelWeightOf('claude-fable-5-2', weights), 4.4);
    assert.equal(modelWeightOf('claude-haiku-5-5', weights), 0.5);
  });

  it('counts an unlisted model, a line naming none and an empty list at 1', () => {
    assert.equal(modelWeightOf('claude-opus-5-5', weights), 1);
    assert.equal(modelWeightOf(undefined, weights), 1);
    assert.equal(modelWeightOf('claude-fable-5-1', []), 1);
  });
});
