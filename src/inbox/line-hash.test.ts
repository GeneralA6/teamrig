import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { lineHash } from './line-hash.ts';

describe('lineHash', () => {
  it('is short, stable and line-specific', () => {
    assert.equal(lineHash('- a'), lineHash('- a'));
    assert.notEqual(lineHash('- a'), lineHash('- b'));
    assert.match(lineHash('- a'), /^[0-9a-f]{16}$/);
  });

  it('is the first 16 hex digits of the SHA-256 of the UTF-8 text, so marks stay readable by any reader', () => {
    assert.equal(lineHash(''), 'e3b0c44298fc1c14');
    assert.equal(lineHash('- a'), 'ae030a32f1f546fd');
    assert.equal(lineHash('- 2030-01-07 09:00 lead: first'), '03d55a9ff7564bab');
    assert.equal(lineHash('é ünïcode 日本'), '9ebc12f06fbcec7d');
  });
});
