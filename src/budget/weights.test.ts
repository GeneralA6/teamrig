import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { modelWeightOf } from './weights.ts';

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
