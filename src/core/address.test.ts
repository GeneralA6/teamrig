import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ADDRESS_PATTERN, formatAddress, splitAddress } from './address.ts';

describe('session addresses', () => {
  it('splits a bare session and a team-qualified one', () => {
    assert.deepEqual(splitAddress('alpha'), { team: undefined, session: 'alpha' });
    assert.deepEqual(splitAddress('web/alpha'), { team: 'web', session: 'alpha' });
    assert.deepEqual(splitAddress('web/web-front-end'), { team: 'web', session: 'web-front-end' });
  });

  it('refuses anything else', () => {
    for (const text of ['', 'Alpha', 'web/', '/alpha', 'a/b/c', 'Web/alpha', 'web/al pha']) {
      assert.equal(splitAddress(text), undefined, text);
    }
  });

  it('formats an address and matches only qualified ids', () => {
    assert.equal(formatAddress({ team: 'web', id: 'lead' }), 'web/lead');
    assert.match('web/lead', ADDRESS_PATTERN);
    assert.doesNotMatch('lead', ADDRESS_PATTERN);
    assert.doesNotMatch('web/lead/x', ADDRESS_PATTERN);
  });
});
