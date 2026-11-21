import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { HOST_SESSION_FIELD, hostSessionOf, hostSessionValue } from './host-session.ts';

const TAB = '0a1b2c3d-1111-2222-3333-444455556666';
const OTHER_TAB = '9f8e7d6c-1111-2222-3333-444455556666';

describe('hostSessionOf', () => {
  it('reads the session from the new field, and from the old field of a record written before the rename', () => {
    assert.equal(HOST_SESSION_FIELD, 'hostSession');
    assert.equal(hostSessionOf({ hostSession: TAB }, 'claudeSession'), TAB);
    assert.equal(hostSessionOf({ claudeSession: TAB }, 'claudeSession'), TAB);
    assert.equal(hostSessionOf({ claude: TAB }, 'claude'), TAB);
  });

  it('reads only the old field its store used', () => {
    assert.equal(hostSessionOf({ claude: TAB }, 'claudeSession'), undefined);
    assert.equal(hostSessionOf({ claudeSession: TAB }, 'claude'), undefined);
  });

  it('takes the new field over the old one, a null included', () => {
    assert.equal(hostSessionOf({ hostSession: TAB, claudeSession: OTHER_TAB }, 'claudeSession'), TAB);
    assert.equal(hostSessionOf({ hostSession: null, claudeSession: OTHER_TAB }, 'claudeSession'), undefined);
  });

  it('names no session for a record with none, or with one that is not text', () => {
    assert.equal(hostSessionOf({}, 'claudeSession'), undefined);
    assert.equal(hostSessionOf({ hostSession: 7 }, 'claudeSession'), undefined);
    assert.equal(hostSessionOf({ claudeSession: null }, 'claudeSession'), undefined);
  });
});

describe('hostSessionValue', () => {
  it('hands back what the record stores, unchecked', () => {
    assert.equal(hostSessionValue({ hostSession: null, claudeSession: TAB }, 'claudeSession'), null);
    assert.equal(hostSessionValue({ claudeSession: null }, 'claudeSession'), null);
    assert.equal(hostSessionValue({ hostSession: 7 }, 'claudeSession'), 7);
    assert.equal(hostSessionValue({}, 'claudeSession'), undefined);
  });
});
