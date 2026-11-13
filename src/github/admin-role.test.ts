import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ADMIN_KEY_BYTES, isAdminKey, newAdminKey, signAdminRole, verifyAdminRole, type AdminRole } from './admin-role.ts';

const ROLE: AdminRole = { team: 'acme', session: 'github', setAt: '2030-01-05T10:00:00.000Z' };

/** A fixed key, so a test reads the same file every run. */
const KEY = newAdminKey((bytes) => Buffer.alloc(bytes, 7));
const OTHER_KEY = newAdminKey((bytes) => Buffer.alloc(bytes, 9));

/** The signed file with one field replaced, as an edit by hand would leave it. */
function edited(field: string, value: string): string {
  const parsed: unknown = JSON.parse(signAdminRole(ROLE, KEY));
  assert.ok(typeof parsed === 'object' && parsed !== null);
  return JSON.stringify({ ...parsed, [field]: value });
}

describe('newAdminKey', () => {
  it('makes a key of 32 random bytes as base64url text', () => {
    let asked = 0;
    const key = newAdminKey((bytes) => {
      asked = bytes;
      return Buffer.alloc(bytes, 1);
    });
    assert.equal(asked, ADMIN_KEY_BYTES);
    assert.equal(key, Buffer.alloc(32, 1).toString('base64url'));
    assert.ok(isAdminKey(key));
  });

  it('makes a different key each time by default', () => {
    assert.notEqual(newAdminKey(), newAdminKey());
  });
});

describe('isAdminKey', () => {
  it('takes only base64url text of 32 bytes', () => {
    assert.ok(isAdminKey(KEY));
    assert.equal(isAdminKey(''), false);
    assert.equal(isAdminKey(KEY.slice(1)), false);
    assert.equal(isAdminKey(`${KEY.slice(1)}+`), false);
  });
});

describe('signAdminRole and verifyAdminRole', () => {
  it('reads back the role the owner set with the same key and team', () => {
    const text = signAdminRole(ROLE, KEY);
    assert.ok(text.endsWith('}\n'));
    assert.deepEqual(verifyAdminRole(text, KEY, 'acme'), { kind: 'admin', role: ROLE });
  });

  it('reads a file a session edited to name itself as broken, never as its admin', () => {
    const read = verifyAdminRole(edited('session', 'intruder'), KEY, 'acme');
    assert.deepEqual(read, {
      kind: 'broken',
      reason: 'the GitHub admin role file does not match its signature: it was changed after the owner set it',
    });
  });

  it('reads an edited time or team as broken too', () => {
    assert.equal(verifyAdminRole(edited('setAt', '2031-01-01T00:00:00.000Z'), KEY, 'acme').kind, 'broken');
    assert.equal(verifyAdminRole(edited('team', 'other'), KEY, 'other').kind, 'broken');
  });

  it('reads a file signed by an earlier key as broken, so an old file cannot come back', () => {
    const old = signAdminRole(ROLE, OTHER_KEY);
    assert.equal(verifyAdminRole(old, KEY, 'acme').kind, 'broken');
  });

  it('reads a file signed for another team as broken', () => {
    assert.deepEqual(verifyAdminRole(signAdminRole(ROLE, KEY), KEY, 'web'), {
      kind: 'broken',
      reason: 'the GitHub admin role file was set for team acme, not web',
    });
  });

  it('keeps fields apart, so moving a character between them breaks the signature', () => {
    const text = signAdminRole({ team: 'acme', session: 'git-hub', setAt: ROLE.setAt }, KEY);
    const moved = text.replace('"acme"', '"acme-git"').replace('"git-hub"', '"hub"');
    assert.equal(verifyAdminRole(moved, KEY, 'acme-git').kind, 'broken');
  });

  it('reads a file that is not a signed role as broken, saying why', () => {
    const reasons = [
      ['{', 'the GitHub admin role file is not JSON'],
      ['[]', 'the GitHub admin role file is not a JSON object'],
      ['{"team":"acme","session":"github"}', 'the GitHub admin role file lacks its team, session, setAt or signature'],
      [edited('signature', 'x'.repeat(64)), 'the GitHub admin role file has no signature teamrig wrote'],
    ];
    for (const [text, reason] of reasons) {
      assert.deepEqual(verifyAdminRole(text ?? '', KEY, 'acme'), { kind: 'broken', reason });
    }
  });

  it('reads every file as broken under a saved key teamrig did not make', () => {
    assert.deepEqual(verifyAdminRole(signAdminRole(ROLE, KEY), 'hunter2', 'acme'), {
      kind: 'broken',
      reason: 'the saved GitHub admin key is not one teamrig made',
    });
  });

  it('refuses to sign with a key teamrig did not make, or a field of more than one line', () => {
    assert.throws(() => signAdminRole(ROLE, 'hunter2'), /not a key teamrig made/);
    assert.throws(() => signAdminRole({ ...ROLE, session: 'a\nb' }, KEY), /session must be one line/);
    assert.throws(() => signAdminRole({ ...ROLE, team: '' }, KEY), /team must be one line/);
  });
});
