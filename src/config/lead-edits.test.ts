import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { JsonRecord } from '../core/guards.ts';
import { testConfig } from '../testing/config.ts';
import type { Checked } from '../setup/team-create.ts';
import { demoted, leadsAfterRetire, promoted, type Leads } from './lead-edits.ts';

const SESSIONS = ['lead', 'alpha', 'bravo', 'charlie', 'delta', 'echo'];

const team = (leads: JsonRecord = {}) => testConfig({ sessions: SESSIONS, leads });

function value(result: Checked<Leads>): Leads {
  assert.ok(result.ok, result.ok ? '' : result.problem);
  return result.value;
}

function problem(result: Checked<Leads>): string {
  assert.ok(!result.ok, 'expected a refusal');
  return result.problem;
}

describe('promoted', () => {
  it("lets the lead make one of its sessions the leader of others, merging into a sub-lead's list", () => {
    assert.deepEqual(value(promoted(team(), 'lead', 'alpha', ['bravo', 'charlie'])), { alpha: ['bravo', 'charlie'] });
    assert.deepEqual(value(promoted(team({ alpha: ['bravo'] }), 'lead', 'alpha', ['charlie'])), { alpha: ['bravo', 'charlie'] });
  });

  it("lets a sub-lead promote among its own members, which leave its list, a sub-lead bringing its group along", () => {
    const tree = team({ alpha: ['bravo', 'charlie', 'delta'], delta: ['echo'] });
    assert.deepEqual(value(promoted(tree, 'alpha', 'bravo', ['charlie', 'delta'])), { alpha: ['bravo'], delta: ['echo'], bravo: ['charlie', 'delta'] });
  });

  it('refuses a caller who leads no one, and sessions it does not lead directly', () => {
    const tree = team({ alpha: ['bravo', 'charlie'] });
    assert.equal(problem(promoted(tree, 'bravo', 'charlie', ['delta'])), 'bravo leads no one: only the lead or a sub-lead promotes');
    assert.equal(problem(promoted(tree, 'lead', 'bravo', ['delta'])), 'bravo is led by alpha: lead promotes only among the sessions it leads directly');
    assert.equal(problem(promoted(tree, 'alpha', 'bravo', ['delta'])), 'delta is led by lead: alpha promotes only among the sessions it leads directly');
    assert.equal(problem(promoted(tree, 'alpha', 'bravo', ['lead'])), 'lead is the lead: alpha promotes only among the sessions it leads directly');
    assert.equal(problem(promoted(tree, 'lead', 'zulu', ['delta'])), 'zulu is not on the team: lead promotes only among the sessions it leads directly');
  });

  it('refuses no members, a member named twice, and a sub-lead over itself', () => {
    assert.equal(problem(promoted(team(), 'lead', 'alpha', [])), '--members names no session for alpha to lead');
    assert.equal(problem(promoted(team(), 'lead', 'alpha', ['bravo', 'bravo'])), '--members names bravo twice');
    assert.equal(problem(promoted(team(), 'lead', 'alpha', ['alpha'])), 'alpha cannot lead itself');
  });
});

describe('demoted', () => {
  it("gives a sub-lead's members back to the lead (unlisted) or to the sub-lead above", () => {
    assert.deepEqual(value(demoted(team({ alpha: ['bravo'], charlie: ['delta'] }), 'lead', 'alpha')), { charlie: ['delta'] });
    assert.deepEqual(value(demoted(team({ alpha: ['bravo', 'charlie'], charlie: ['delta', 'echo'] }), 'alpha', 'charlie')), { alpha: ['bravo', 'charlie', 'delta', 'echo'] });
  });

  it('refuses a session that leads no one, and a caller that is not its own leader', () => {
    const tree = team({ alpha: ['bravo', 'charlie'], charlie: ['delta'] });
    assert.equal(problem(demoted(tree, 'lead', 'bravo')), 'bravo is not a sub-lead: it leads no one');
    assert.equal(problem(demoted(tree, 'lead', 'charlie')), 'charlie is led by alpha: only its own leader demotes it');
  });
});

describe('leadsAfterRetire', () => {
  it('leaves the tree untouched when it does not name the session', () => {
    assert.equal(leadsAfterRetire(team({ alpha: ['bravo'] }), 'charlie'), undefined);
    assert.equal(leadsAfterRetire(team({ alpha: ['bravo'] }), 'lead'), undefined);
  });

  it("takes a member out of its sub-lead's list, dropping a list left empty", () => {
    assert.deepEqual(leadsAfterRetire(team({ alpha: ['bravo', 'charlie'] }), 'bravo'), { leads: { alpha: ['charlie'] }, members: [], to: 'alpha' });
    assert.deepEqual(leadsAfterRetire(team({ alpha: ['bravo'] }), 'bravo'), { leads: {}, members: [], to: 'alpha' });
  });

  it("gives a retiring sub-lead's members to its leader: the lead (unlisted) or the sub-lead above", () => {
    assert.deepEqual(leadsAfterRetire(team({ alpha: ['bravo'], charlie: ['delta'] }), 'alpha'), { leads: { charlie: ['delta'] }, members: ['bravo'], to: 'lead' });
    assert.deepEqual(leadsAfterRetire(team({ alpha: ['bravo', 'charlie'], charlie: ['delta', 'echo'] }), 'charlie'), {
      leads: { alpha: ['bravo', 'delta', 'echo'] },
      members: ['delta', 'echo'],
      to: 'alpha',
    });
  });
});
