import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tokensOf } from './scan-finding.ts';

describe('tokensOf', () => {
  it('counts a token per four characters, rounding up', () => {
    assert.deepEqual([tokensOf(0), tokensOf(1), tokensOf(8), tokensOf(9)], [0, 1, 2, 3]);
  });
});
