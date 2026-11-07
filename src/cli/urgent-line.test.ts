import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { inboxLineOf } from '../inbox/inbox.ts';
import { lineHash } from '../inbox/line-hash.ts';
import { urgentAskOf } from './urgent-line.ts';

const AT = Date.parse('2030-01-08T10:00:00Z');

describe('urgentAskOf', () => {
  it('is a plain ask unless the line is for someone waiting live', () => {
    const line = { to: 'alpha', from: 'owner', text: 'bring your cards' };
    assert.deepEqual(urgentAskOf(line, line.text, AT), { from: 'owner', text: 'bring your cards', at: AT });
    assert.deepEqual(urgentAskOf({ ...line, atOnce: false }, line.text, AT), { from: 'owner', text: 'bring your cards', at: AT });
  });

  it('is due at its post time and bound to the posted inbox line when atOnce', () => {
    const line = { to: 'alpha', from: 'owner', text: 'bring your cards', atOnce: true };
    const by = { at: AT, line: lineHash(inboxLineOf(new Date(AT), 'owner', 'bring your cards')) };
    assert.deepEqual(urgentAskOf(line, line.text, AT), { from: 'owner', text: 'bring your cards', at: AT, by });
  });
});
