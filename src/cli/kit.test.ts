import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Roster } from '../config/roster.ts';
import { checkedNextConfig, leadOrDeliveryOwnerOnly } from './kit.ts';
import { RefusedError } from './runtime.ts';

describe('checkedNextConfig', () => {
  it('reads back a config that loads cleanly', () => {
    assert.deepEqual(checkedNextConfig({ sessions: ['lead', 'alpha'], roles: { lead: 'lead' } }).sessions, ['lead', 'alpha']);
  });

  it('refuses a config that would not load, or would load with a problem', () => {
    assert.throws(() => checkedNextConfig({ configVersion: 'x', sessions: ['lead'] }), (error: unknown) => error instanceof RefusedError && /^the new config cannot be read: configVersion/.test(error.message));
    assert.throws(() => checkedNextConfig({ sessions: ['lead', 'alpha'], roles: { lead: 'ghost' } }), (error: unknown) => error instanceof RefusedError && /^nothing written: roles\.lead/.test(error.message));
  });
});

describe('leadOrDeliveryOwnerOnly', () => {
  const roster = new Roster({ sessions: ['lead', 'alpha', 'bravo'], names: { lead: 'captain' }, roles: { lead: 'lead', deliveryOwner: 'alpha' } }, 'app');

  it('passes the lead and the delivery owner, by id or name', () => {
    assert.deepEqual([leadOrDeliveryOwnerOnly(roster, 'captain', 'x'), leadOrDeliveryOwnerOnly(roster, 'alpha', 'x')], ['lead', 'alpha']);
  });

  it('refuses anyone else, naming both roles’ holders, or the lead alone with no delivery owner', () => {
    const refused = (by: Roster, message: string) => assert.throws(() => leadOrDeliveryOwnerOnly(by, 'bravo', 'freezes the pipeline'), (error: unknown) => error instanceof RefusedError && error.message === message);
    refused(roster, 'only the lead or the delivery owner (captain, app-alpha) freezes the pipeline');
    refused(new Roster({ sessions: ['lead', 'bravo'], names: {}, roles: { lead: 'lead' } }, 'app'), 'only the lead or the delivery owner (app-lead) freezes the pipeline');
  });
});
