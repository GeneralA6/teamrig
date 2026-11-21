import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { plainArithmetic } from './arithmetic.ts';

describe('plainArithmetic', () => {
  it('gives the names arithmetic reads when it can neither assign nor read text again', () => {
    assert.deepEqual(plainArithmetic(' 1 + 2 * (3 - 4) '), []);
    assert.deepEqual(plainArithmetic('n + 1'), ['n']);
    assert.deepEqual(plainArithmetic('i < j ? i : j'), ['i', 'j', 'i', 'j']);
    assert.deepEqual(plainArithmetic('0x1f >> 2 == 7 && a != b || c <= 3 && d >= 4'), ['a', 'b', 'c', 'd']);
    assert.deepEqual(plainArithmetic('!n, ~m, -k % 2 ^ 1 & 3 | 4'), ['n', 'm', 'k']);
  });

  it('refuses arithmetic that assigns', () => {
    for (const text of ['n = 1', 'n += 1', 'n <<= 1', 'n >>= 1', 'n++', '--n', 'n === 1', 'a = b == c']) {
      assert.equal(plainArithmetic(text), undefined, text);
    }
  });

  it('refuses arithmetic that reads text again or is not plain', () => {
    for (const text of ['$n', '`n`', '"1"', "'1'", 'a[1]', '16#ff', '1.5', '1a', '(n', 'n)', ') + (', '${n}', 'n\\']) {
      assert.equal(plainArithmetic(text), undefined, text);
    }
  });
});
