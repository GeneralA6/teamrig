import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { renameOf } from '../testing/rename.ts';
import { isRole, roleHolderOf, Roster } from './roster.ts';

const CONFIG = {
  sessions: ['lead', 'alpha', 'bravo'],
  names: { lead: 'captain' },
  roles: { lead: 'lead', deliveryOwner: 'alpha' },
};

describe('Roster', () => {
  const roster = new Roster(CONFIG, 'app');

  it('names a session from the config, else <team>-<id>', () => {
    assert.deepEqual(
      ['lead', 'alpha', 'zulu'].map((id) => roster.nameOf(id)),
      ['captain', 'app-alpha', undefined],
    );
  });

  it('finds a session by id, by its configured name or by its default name', () => {
    assert.deepEqual(
      ['alpha', 'captain', 'app-bravo'].map((text) => roster.lookup(text)),
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
      error: 'app-lead is not a session on this team (sessions: lead (captain), alpha (app-alpha), bravo (app-bravo))',
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
    assert.deepEqual([roster.holderOf('lead'), roster.holderOf('deliveryOwner')], ['lead', 'alpha']);
    assert.deepEqual([roster.rolesOf('alpha'), roster.rolesOf('bravo')], [['deliveryOwner'], []]);
    assert.equal(new Roster({ ...CONFIG, roles: { lead: 'lead' } }, 'app').holderOf('deliveryOwner'), undefined);
    const reviewed = new Roster({ ...CONFIG, roles: { ...CONFIG.roles, securityReviewer: 'bravo' } }, 'app');
    assert.deepEqual([reviewed.holderOf('securityReviewer'), reviewed.rolesOf('bravo')], ['bravo', ['securityReviewer']]);
  });

  it('ignores inherited keys of the names object', () => {
    const roster = new Roster({ sessions: ['constructor'], names: {}, roles: { lead: 'constructor' } }, 'app');
    assert.equal(roster.nameOf('constructor'), 'app-constructor');
  });
});

describe('Roster with renames', () => {
  const renames = [renameOf('alpha', 'app-alpha', 'scout'), renameOf('alpha', 'scout', 'ranger'), renameOf('zulu', 'app-zulu', 'ghost')];
  const roster = new Roster(CONFIG, 'app', renames);

  it('names a session by its newest rename, and keeps every former name', () => {
    assert.equal(roster.nameOf('alpha'), 'ranger');
    assert.deepEqual(roster.formerNamesOf('alpha'), ['app-alpha', 'scout']);
    assert.deepEqual(roster.formerNamesOf('bravo'), []);
    assert.equal(roster.describe(), 'lead (captain), alpha (ranger), bravo (app-bravo)');
  });

  it('finds a session by any name it has had', () => {
    assert.deepEqual(
      ['ranger', 'scout', 'app-alpha'].map((text) => roster.lookup(text)),
      [
        { ok: true, id: 'alpha' },
        { ok: true, id: 'alpha' },
        { ok: true, id: 'alpha' },
      ],
    );
  });

  it('gives a name taken over by another session to the session that took it last', () => {
    const moved = new Roster(CONFIG, 'app', [...renames, renameOf('bravo', 'app-bravo', 'scout')]);
    assert.deepEqual([moved.lookup('scout'), moved.lookup('app-bravo')], [{ ok: true, id: 'bravo' }, { ok: true, id: 'bravo' }]);
    assert.deepEqual(moved.formerNamesOf('alpha'), ['app-alpha']);
  });

  it("prefers a session's current name over another session's former name", () => {
    const odd = new Roster(CONFIG, 'app', [renameOf('bravo', 'captain', 'app-bravo-2')]);
    assert.deepEqual(odd.lookup('captain'), { ok: true, id: 'lead' });
    assert.equal(odd.allNames().get('captain'), 'bravo');
    assert.deepEqual(odd.idsCalled('captain'), ['lead']);
  });

  it('refuses a name of a session no longer on the team, naming its id', () => {
    assert.deepEqual(roster.lookup('ghost'), {
      ok: false,
      error: 'ghost was the name of zulu, which is no longer on this team (sessions: lead (captain), alpha (ranger), bravo (app-bravo))',
      pastId: 'zulu',
    });
    assert.equal(roster.nameOf('zulu'), undefined);
  });
});

describe('roleHolderOf (T1143)', () => {
  it('reads a bare holder as a session of the team, and <team>/<id> as one of a team above', () => {
    const roles = { lead: 'lead', deliveryOwner: 'alpha', securityReviewer: 'root/security' };
    assert.deepEqual(roleHolderOf(roles, 'deliveryOwner', 'web'), { team: 'web', id: 'alpha' });
    assert.deepEqual(roleHolderOf(roles, 'securityReviewer', 'web'), { team: 'root', id: 'security' });
    assert.equal(roleHolderOf({ lead: 'lead' }, 'securityReviewer', 'web'), undefined);
  });
});

describe('isRole', () => {
  it('accepts only the role keys', () => {
    assert.deepEqual(['lead', 'deliveryOwner', 'securityReviewer', 'owner', 'toString'].map(isRole), [true, true, true, false, false]);
  });
});
