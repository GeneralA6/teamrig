import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ServiceRoleConfig } from '../config/types.ts';
import { roleHolding } from './service-roles.ts';

const ROLES: Readonly<Record<string, ServiceRoleConfig>> = {
  github: { holders: ['alpha'], commands: ['issue close'] },
  bot: { holders: ['alpha', 'delta'], commands: ['issue close'] },
  open: { holders: 'team', commands: ['issue close'] },
  ship: { holders: 'team', commands: ['queue ship', 'queue merge'] },
};

describe('service roles: who holds what', () => {
  it('finds the role naming the holder for the command, the first by name when two do', () => {
    assert.equal(roleHolding(ROLES, 'issue close', 'alpha'), 'bot');
    assert.equal(roleHolding({ github: { holders: ['alpha'], commands: ['issue close'] } }, 'issue close', 'alpha'), 'github');
    assert.equal(roleHolding(ROLES, 'issue close', 'delta'), 'bot');
  });

  it('gives no role to a session it does not name, nor through "team" for a command that acts as whoever runs it', () => {
    assert.equal(roleHolding(ROLES, 'issue close', 'bravo'), undefined);
    assert.equal(roleHolding(ROLES, 'issue close', 'charlie'), undefined);
    assert.equal(roleHolding({}, 'issue close', 'alpha'), undefined);
  });

  it('gives a ship and merge to every session through "team", since the allow holds each to its own task branch (C4)', () => {
    assert.equal(roleHolding(ROLES, 'queue ship', 'charlie'), 'ship');
    assert.equal(roleHolding(ROLES, 'queue merge', 'alpha'), 'ship');
    assert.equal(roleHolding({ github: { holders: ['alpha'], commands: ['issue close'] } }, 'queue ship', 'alpha'), undefined);
  });
});
