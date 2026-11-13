import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FakeCredentials } from '../testing/fake-credentials.ts';
import { repoOwner, RepoTokens, TokenReadError, tokenName } from './tokens.ts';

const ENV = { HOME: '/u' };

describe('tokenName', () => {
  it('names an owner\'s credential teamrig-gh-<owner> in lowercase', () => {
    assert.equal(repoOwner('Acme/Web'), 'acme');
    assert.equal(tokenName('Acme'), 'teamrig-gh-acme');
  });
});

describe('RepoTokens', () => {
  it("gives gh an owner's token only for that owner's repositories, reading each credential once", async () => {
    const store = new FakeCredentials().saves('teamrig-gh-acme', 'acme-token');
    const tokens = new RepoTokens(store, ENV);
    assert.deepEqual(await tokens.accessFor('acme/web'), {
      via: 'token', env: { HOME: '/u', GH_TOKEN: 'acme-token' }, owner: 'acme', credential: 'teamrig-gh-acme', save: 'save teamrig-gh-acme',
    });
    const api = await tokens.accessFor('acme/api');
    assert.ok(!(api instanceof TokenReadError));
    assert.equal(api.env['GH_TOKEN'], 'acme-token');
    assert.deepEqual(await tokens.accessFor('globex/api'), {
      via: 'login', env: ENV, owner: 'globex', credential: 'teamrig-gh-globex', save: 'save teamrig-gh-globex',
    });
    assert.deepEqual(store.reads, ['teamrig-gh-acme', 'teamrig-gh-globex']);
  });

  it('gives no access, never the gh login, when the store holds the key but cannot read it', async () => {
    const tokens = new RepoTokens(new FakeCredentials().failsOn('teamrig-gh-acme', 'the keyring is locked'), ENV);
    const access = await tokens.accessFor('acme/web');
    assert.ok(access instanceof TokenReadError);
    assert.equal(
      access.message,
      'could not read teamrig-gh-acme from the test store: the keyring is locked; unlock the store and rerun, or save the key again with: save teamrig-gh-acme',
    );
  });
});
