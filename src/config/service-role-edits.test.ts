import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { describeRole, granted, revoked, type ServiceRoles } from './service-role-edits.ts';

const GITHUB: ServiceRoles = { github: { holders: ['bravo'], commands: ['issue close'] } };

describe('granted', () => {
  it('creates a role with its commands, and refuses a new role without them', () => {
    assert.deepEqual(granted({}, 'github', { kind: 'session', id: 'bravo' }, ['issue close']), { ok: true, value: GITHUB });
    assert.deepEqual(granted({}, 'github', { kind: 'session', id: 'bravo' }, []), {
      ok: false,
      problem: 'there is no role github; name its commands with --commands to create it',
    });
  });

  it('adds a holder and new commands to a role, each once, and keeps the other roles', () => {
    const roles: ServiceRoles = { ...GITHUB, ship: { holders: 'team', commands: ['issue comment'] } };
    const next = granted(roles, 'github', { kind: 'session', id: 'charlie' }, ['issue close', 'issue comment']);
    assert.deepEqual(next, {
      ok: true,
      value: { github: { holders: ['bravo', 'charlie'], commands: ['issue close', 'issue comment'] }, ship: { holders: 'team', commands: ['issue comment'] } },
    });
  });

  it('gives a role to every session with team, and refuses a grant that changes nothing', () => {
    assert.deepEqual(granted(GITHUB, 'github', { kind: 'team' }, []), { ok: true, value: { github: { holders: 'team', commands: ['issue close'] } } });
    assert.deepEqual(granted(GITHUB, 'github', { kind: 'session', id: 'bravo' }, ['issue close']), { ok: false, problem: 'github is held so already; nothing to change' });
    const team: ServiceRoles = { github: { holders: 'team', commands: ['issue close'] } };
    assert.deepEqual(granted(team, 'github', { kind: 'session', id: 'bravo' }, []), { ok: false, problem: 'every session of the team holds github already' });
  });
});

describe('revoked', () => {
  it('takes one holder off, and the whole role once the last one leaves or none is named', () => {
    const two: ServiceRoles = { github: { holders: ['bravo', 'charlie'], commands: ['issue close'] } };
    assert.deepEqual(revoked(two, 'github', 'bravo'), { ok: true, value: { github: { holders: ['charlie'], commands: ['issue close'] } } });
    assert.deepEqual(revoked(GITHUB, 'github', 'bravo'), { ok: true, value: {} });
    assert.deepEqual(revoked(two, 'github', undefined), { ok: true, value: {} });
  });

  it('refuses a role that is not there, a session that does not hold it, and one session off a team role', () => {
    assert.deepEqual(revoked(GITHUB, 'ship', undefined), { ok: false, problem: 'there is no role ship' });
    assert.deepEqual(revoked(GITHUB, 'github', 'charlie'), { ok: false, problem: 'charlie does not hold github' });
    const team: ServiceRoles = { github: { holders: 'team', commands: ['issue close'] } };
    assert.deepEqual(revoked(team, 'github', 'bravo'), { ok: false, problem: 'every session of the team holds github; revoke the whole role, without --holder' });
  });
});

describe('describeRole', () => {
  it('names the holders and commands, every session for team', () => {
    assert.equal(describeRole('github', GITHUB['github']), 'github: held by bravo; runs issue close');
    assert.equal(describeRole('ship', { holders: 'team', commands: ['issue comment'] }), 'ship: held by every session of the team; runs issue comment');
    assert.equal(describeRole('gone', undefined), 'gone: no role');
  });
});
