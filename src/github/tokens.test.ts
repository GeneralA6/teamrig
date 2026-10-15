import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FakeCredentials } from '../testing/fake-credentials.ts';
import { repoOwner, RepoTokens, tokenName } from './tokens.ts';

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
      access: { via: 'token', env: { HOME: '/u', GH_TOKEN: 'acme-token' }, owner: 'acme', credential: 'teamrig-gh-acme', save: 'save teamrig-gh-acme' },
    });
    assert.equal((await tokens.accessFor('acme/api')).access.env['GH_TOKEN'], 'acme-token');
    assert.deepEqual(await tokens.accessFor('globex/api'), {
      access: { via: 'login', env: ENV, owner: 'globex', credential: 'teamrig-gh-globex', save: 'save teamrig-gh-globex' },
    });
    assert.deepEqual(store.reads, ['teamrig-gh-acme', 'teamrig-gh-globex']);
  });

  it('reads through the gh login with a note when the store cannot be read', async () => {
    const tokens = new RepoTokens(new FakeCredentials().failsOn('teamrig-gh-acme', 'the keyring is locked'), ENV);
    assert.deepEqual(await tokens.accessFor('acme/web'), {
      access: { via: 'login', env: ENV, owner: 'acme', credential: 'teamrig-gh-acme', save: 'save teamrig-gh-acme' },
      note: 'could not read teamrig-gh-acme from the test store: the keyring is locked',
    });
  });
});
