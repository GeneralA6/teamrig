import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FakeCredentials } from '../testing/fake-credentials.ts';
import { NoAccessError, repoOwner, RepoTokens, TokenMissingError, TokenReadError, tokenName } from './tokens.ts';

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
      env: { HOME: '/u', GH_TOKEN: 'acme-token' }, owner: 'acme', credential: 'teamrig-gh-acme', save: 'save teamrig-gh-acme',
    });
    const api = await tokens.accessFor('acme/api');
    assert.ok(!(api instanceof NoAccessError));
    assert.equal(api.env['GH_TOKEN'], 'acme-token');
    assert.ok(await tokens.accessFor('globex/api') instanceof NoAccessError);
    assert.deepEqual(store.reads, ['teamrig-gh-acme', 'teamrig-gh-globex']);
  });

  it('gives no access, never the gh login, when no key is saved for the owner', async () => {
    const access = await new RepoTokens(new FakeCredentials(), { HOME: '/u', GH_TOKEN: 'login-token' }).accessFor('globex/api');
    assert.ok(access instanceof TokenMissingError);
    assert.equal(
      access.message,
      "no token for globex is saved as teamrig-gh-globex in the test store; teamrig reaches a repository only with its owner's saved token, never the gh login: save one with: save teamrig-gh-globex",
    );
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
