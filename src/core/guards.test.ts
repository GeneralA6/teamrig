import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { instantField, numberField } from './guards.ts';

describe('numberField', () => {
  it('reads a finite number, and nothing for one absent, not a number, NaN or infinite', () => {
    const record = { zero: 0, negative: -2.5, text: '3', nan: Number.NaN, infinite: Number.POSITIVE_INFINITY, empty: null };
    assert.deepEqual(
      ['zero', 'negative', 'text', 'nan', 'infinite', 'empty', 'absent'].map((key) => numberField(record, key)),
      [0, -2.5, undefined, undefined, undefined, undefined, undefined],
    );
  });
});

describe('instantField', () => {
  it('reads an ISO instant as ms, and nothing for one absent, not text or no instant', () => {
    const record = { at: '2030-01-08T10:00:00.000Z', number: 1_000, garbled: 'soon', empty: '' };
    assert.deepEqual(
      ['at', 'number', 'garbled', 'empty', 'absent'].map((key) => instantField(record, key)),
      [Date.parse('2030-01-08T10:00:00.000Z'), undefined, undefined, undefined, undefined],
    );
  });
});
