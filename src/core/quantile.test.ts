import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { median, quantile } from './quantile.ts';

describe('quantile', () => {
  it('interpolates between the two nearest sorted values', () => {
    assert.equal(quantile([10, 20, 30, 40, 50], 0.85), 44);
    assert.equal(quantile([10, 20], 0.5), 15);
  });

  it('gives the one value at any quantile, and null with none', () => {
    assert.equal(quantile([7], 0.85), 7);
    assert.equal(quantile([], 0.5), null);
  });
});

describe('median', () => {
  it('sorts what it is given and takes the middle value', () => {
    assert.equal(median([9, 1, 5]), 5);
  });

  it('takes the mean of the two middle values for an even count', () => {
    assert.equal(median([4, 1, 2, 3]), 2.5);
  });

  it('is null with none, and leaves the values given in their order', () => {
    const values = [3, 1, 2];
    median(values);
    assert.deepEqual(values, [3, 1, 2]);
    assert.equal(median([]), null);
  });
});
