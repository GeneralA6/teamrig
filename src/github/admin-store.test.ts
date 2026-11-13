import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FakeCredentials } from '../testing/fake-credentials.ts';
import { MemoryFiles } from '../testing/memory-files.ts';
import { newAdminKey, signAdminRole } from './admin-role.ts';
import { adminKeyName, adminRolePath, adminSessionOf, clearAdminRole, readAdminRole, setAdminRole, type AdminRoleStore } from './admin-store.ts';

const HOME = '/kit/teams/acme';
const SET_AT = '2030-01-05T10:00:00.000Z';

function storeOf(credentials = new FakeCredentials(), files = new MemoryFiles()): AdminRoleStore {
  return { files, credentials, teamHome: HOME, team: 'acme' };
}

/** A random source whose every call fills with the next byte, so two sets make two different keys. */
function counting(): (bytes: number) => Buffer {
  let fill = 0;
  return (bytes) => Buffer.alloc(bytes, ++fill);
}

describe('admin role names', () => {
  it('keeps the role file in the team home and the key under the team name', () => {
    assert.equal(adminRolePath(HOME).replaceAll('\\', '/'), '/kit/teams/acme/github-admin.json');
    assert.equal(adminKeyName('acme'), 'teamrig-github-admin-acme');
  });
});

describe('setAdminRole and readAdminRole', () => {
  it('reads no admin before the owner sets one', async () => {
    const store = storeOf();
    assert.deepEqual(await readAdminRole(store), { kind: 'none' });
    assert.equal(adminSessionOf(await readAdminRole(store)), undefined);
  });

  it('saves a key, writes the file signed by it, and reads the session back', async () => {
    const store = storeOf();
    assert.deepEqual(await setAdminRole(store, 'github', SET_AT, counting()), { kind: 'saved' });
    const credentials = store.credentials;
    assert.ok(credentials instanceof FakeCredentials);
    assert.deepEqual(credentials.saved, ['teamrig-github-admin-acme']);
    const read = await readAdminRole(store);
    assert.deepEqual(read, { kind: 'admin', role: { team: 'acme', session: 'github', setAt: SET_AT } });
    assert.equal(adminSessionOf(read), 'github');
  });

  it('turns a file saved before the last set into no admin, since each set makes a new key', async () => {
    const files = new MemoryFiles();
    const store = storeOf(new FakeCredentials(), files);
    const random = counting();
    await setAdminRole(store, 'old', SET_AT, random);
    const oldFile = files.get(adminRolePath(HOME));
    assert.ok(oldFile !== undefined);
    await setAdminRole(store, 'github', SET_AT, random);
    await files.write(adminRolePath(HOME), oldFile);
    const read = await readAdminRole(store);
    assert.equal(read.kind, 'broken');
    assert.equal(adminSessionOf(read), undefined);
  });

  it('writes no file when the key cannot be saved, so the role stays as it was', async () => {
    const files = new MemoryFiles();
    const store = storeOf(new FakeCredentials().failsSaving('no keyring is running'), files);
    assert.deepEqual(await setAdminRole(store, 'github', SET_AT), { kind: 'failed', reason: 'no keyring is running' });
    assert.equal(files.get(adminRolePath(HOME)), undefined);
  });

  it('reads a role file as broken when its key is gone or cannot be read', async () => {
    const key = newAdminKey(counting());
    const file = signAdminRole({ team: 'acme', session: 'github', setAt: SET_AT }, key);
    const files = new MemoryFiles({ [adminRolePath(HOME)]: file });
    assert.deepEqual(await readAdminRole(storeOf(new FakeCredentials(), files)), {
      kind: 'broken',
      reason: 'the GitHub admin key teamrig-github-admin-acme is not in the test store: the owner sets the role again',
    });
    assert.deepEqual(await readAdminRole(storeOf(new FakeCredentials().failsOn('teamrig-github-admin-acme', 'the keyring is locked'), files)), {
      kind: 'broken',
      reason: 'the GitHub admin key teamrig-github-admin-acme could not be read: the keyring is locked',
    });
    assert.deepEqual(await readAdminRole(storeOf(new FakeCredentials().saves('teamrig-github-admin-acme', key), files)), {
      kind: 'admin',
      role: { team: 'acme', session: 'github', setAt: SET_AT },
    });
  });
});

describe('clearAdminRole', () => {
  it('removes the role file so no session is admin, and says whether there was one', async () => {
    const store = storeOf();
    await setAdminRole(store, 'github', SET_AT);
    assert.equal(await clearAdminRole(store), true);
    assert.deepEqual(await readAdminRole(store), { kind: 'none' });
    assert.equal(await clearAdminRole(store), false);
  });
});
