import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SHIP_TOKEN, TOKEN_PREFIX, tokenName } from './token-names.ts';

describe('tokenName', () => {
  it("names an owner's credential teamrig-gh-<owner> in lowercase", () => {
    assert.equal(tokenName('Acme'), 'teamrig-gh-acme');
    assert.equal(tokenName('acme').startsWith(TOKEN_PREFIX), true);
  });

  it("keeps the ship tool's credential apart from every owner's", () => {
    assert.equal(SHIP_TOKEN.startsWith(TOKEN_PREFIX), false);
  });
});
