import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { LeadTree } from './lead-tree.ts';

/** lead over bravo and echo; bravo over charlie; charlie over delta. */
const TREE = new LeadTree({
  sessions: ['lead', 'bravo', 'charlie', 'delta', 'echo'],
  roles: { lead: 'lead' },
  leads: { bravo: ['charlie'], charlie: ['delta'] },
});

describe('LeadTree', () => {
  it('gives each session its listing sub-lead, else the lead, and the lead none', () => {
    assert.deepEqual(
      ['lead', 'bravo', 'charlie', 'delta', 'echo', 'zulu'].map((id) => TREE.leaderOf(id)),
      [undefined, 'lead', 'bravo', 'charlie', 'lead', undefined],
    );
  });

  it('walks the chain up to the lead, nearest leader first', () => {
    assert.deepEqual(TREE.chainOf('delta'), ['charlie', 'bravo', 'lead']);
    assert.deepEqual(TREE.chainOf('echo'), ['lead']);
    assert.deepEqual(TREE.chainOf('lead'), []);
  });

  it('lists direct members, and the whole group at any depth', () => {
    assert.deepEqual(TREE.membersOf('lead'), ['bravo', 'echo']);
    assert.deepEqual(TREE.membersOf('bravo'), ['charlie']);
    assert.deepEqual(TREE.membersOf('delta'), []);
    assert.deepEqual(TREE.groupOf('bravo'), ['charlie', 'delta']);
    assert.deepEqual(TREE.groupOf('lead'), ['bravo', 'charlie', 'delta', 'echo']);
  });

  it('knows the leaders and who is above whom', () => {
    assert.deepEqual(
      ['lead', 'bravo', 'charlie', 'delta', 'echo'].map((id) => TREE.isLeader(id)),
      [true, true, true, false, false],
    );
    assert.equal(TREE.leads('bravo', 'delta'), true);
    assert.equal(TREE.leads('delta', 'bravo'), false);
    assert.equal(TREE.leads('echo', 'delta'), false);
  });

  it('names the sub-lead right below the sender that a message down the tree skips', () => {
    assert.equal(TREE.routeVia('lead', 'charlie'), 'bravo');
    assert.equal(TREE.routeVia('lead', 'delta'), 'bravo');
    assert.equal(TREE.routeVia('bravo', 'delta'), 'charlie');
  });

  it('names none for a direct leader, a message up or across, or an id off the team', () => {
    assert.equal(TREE.routeVia('charlie', 'delta'), undefined);
    assert.equal(TREE.routeVia('lead', 'echo'), undefined);
    assert.equal(TREE.routeVia('delta', 'lead'), undefined);
    assert.equal(TREE.routeVia('echo', 'delta'), undefined);
    assert.equal(TREE.routeVia('lead', 'zulu'), undefined);
  });

  it('stops a hand-built cycle instead of looping', () => {
    const cycle = new LeadTree({ sessions: ['lead', 'a', 'b'], roles: { lead: 'lead' }, leads: { a: ['b'], b: ['a'] } });
    assert.deepEqual(cycle.chainOf('a'), ['b']);
  });
});
