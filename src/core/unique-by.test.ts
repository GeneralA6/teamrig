import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { uniqueBy } from './unique-by.ts';

describe('uniqueBy', () => {
  it('keeps the first item of each key, in order', () => {
    const items = [
      { bin: 'tsc', flag: '--version', at: 1 },
      { bin: 'eslint', flag: '--fix', at: 2 },
      { bin: 'tsc', flag: '--version', at: 3 },
      { bin: 'tsc', flag: '--help', at: 4 },
    ];
    assert.deepEqual(
      uniqueBy(items, ({ bin, flag }) => `${bin} ${flag}`).map(({ at }) => at),
      [1, 2, 4],
    );
  });

  it('gives an empty list for none, and keeps items whose keys all differ', () => {
    assert.deepEqual(uniqueBy([], (item: string) => item), []);
    assert.deepEqual(uniqueBy(['b', 'a', 'c'], (item) => item), ['b', 'a', 'c']);
  });
});
