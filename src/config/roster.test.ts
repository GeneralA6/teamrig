import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isRole, Roster } from './roster.ts';

const CONFIG = {
  sessions: ['lead', 'alpha', 'bravo'],
  names: { lead: 'team-lead' },
  roles: { lead: 'lead', coordinatorOwner: 'alpha' },
};

describe('Roster', () => {
  const roster = new Roster(CONFIG, 'app');

  it('names a session from the config, else <team>-<id>', () => {
    assert.deepEqual(
      ['lead', 'alpha', 'zulu'].map((id) => roster.nameOf(id)),
      ['team-lead', 'app-alpha', undefined],
    );
  });

  it('finds a session by id, by its configured name or by its default name', () => {
    assert.deepEqual(
      ['alpha', 'team-lead', 'app-bravo'].map((text) => roster.lookup(text)),
      [
        { ok: true, id: 'alpha' },
        { ok: true, id: 'lead' },
        { ok: true, id: 'bravo' },
      ],
    );
  });

  it('refuses an unknown name and lists every session with its name', () => {
    assert.deepEqual(roster.lookup('app-lead'), {
      ok: false,
      error: 'app-lead is not a session on this team (sessions: lead (team-lead), alpha (app-alpha), bravo (app-bravo))',
    });
  });

  it('refuses a name two sessions share', () => {
    const clash = new Roster({ ...CONFIG, names: { lead: 'app-bravo' } }, 'app');
    assert.deepEqual(clash.lookup('app-bravo'), {
      ok: false,
      error: 'app-bravo is the name of 2 sessions (lead, bravo); use the id',
    });
  });

  it('prefers an id over a name that equals it', () => {
    const odd = new Roster({ sessions: ['b', 'x-b'], names: {}, roles: { lead: 'b' } }, 'x');
    assert.deepEqual(odd.lookup('x-b'), { ok: true, id: 'x-b' });
  });

  it('knows who holds each role', () => {
    assert.deepEqual([roster.holderOf('lead'), roster.holderOf('coordinatorOwner')], ['lead', 'alpha']);
    assert.deepEqual([roster.rolesOf('alpha'), roster.rolesOf('bravo')], [['coordinatorOwner'], []]);
    assert.equal(new Roster({ ...CONFIG, roles: { lead: 'lead' } }, 'app').holderOf('coordinatorOwner'), undefined);
  });

  it('ignores inherited keys of the names object', () => {
    const roster = new Roster({ sessions: ['constructor'], names: {}, roles: { lead: 'constructor' } }, 'app');
    assert.equal(roster.nameOf('constructor'), 'app-constructor');
  });
});

describe('isRole', () => {
  it('accepts only the role keys', () => {
    assert.deepEqual(['lead', 'coordinatorOwner', 'owner', 'toString'].map(isRole), [true, true, false, false]);
  });
});
