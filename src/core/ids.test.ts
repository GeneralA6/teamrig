import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { titleKey } from './ids.ts';

describe('titleKey', () => {
  it('reads a title that is a valid name but for its case as that name', () => {
    assert.equal(titleKey('Shop-Web'), 'shop-web');
    assert.equal(titleKey('shop-web'), 'shop-web');
  });

  it('keeps any other title as typed', () => {
    assert.equal(titleKey('Fix the build'), 'Fix the build');
    assert.equal(titleKey('9Lives'), '9Lives');
  });
});
