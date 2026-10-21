import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { numberField } from './guards.ts';

describe('numberField', () => {
  it('reads a finite number, and nothing for one absent, not a number, NaN or infinite', () => {
    const record = { zero: 0, negative: -2.5, text: '3', nan: Number.NaN, infinite: Number.POSITIVE_INFINITY, empty: null };
    assert.deepEqual(
      ['zero', 'negative', 'text', 'nan', 'infinite', 'empty', 'absent'].map((key) => numberField(record, key)),
      [0, -2.5, undefined, undefined, undefined, undefined, undefined],
    );
  });
});
