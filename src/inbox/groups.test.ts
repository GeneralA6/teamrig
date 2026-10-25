import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TeamTree, type TeamNode } from '../config/tree.ts';
import { groupIds, parseTo, treeLeadsOf, type Group, type GroupIds } from './groups.ts';

/** `lead` leads `alpha` and the sub-lead `bravo`; `bravo` leads the sub-lead `charlie`, which leads `delta`. */
const TEAM = {
  sessions: ['lead', 'alpha', 'bravo', 'charlie', 'delta'],
  roles: { lead: 'lead' },
  leads: { bravo: ['charlie'], charlie: ['delta'] },
};

function idsOf(group: Group, sender: string): string[] {
  const result: GroupIds = groupIds(TEAM, group, sender);
  assert.ok(result.ok, 'expected the group to resolve');
  return result.ids;
}

describe('parseTo', () => {
  it('reads a bare session, a team address, each group word and a list, in the order given', () => {
    assert.deepEqual(parseTo('bravo'), [{ kind: 'session', address: { team: undefined, session: 'bravo' } }]);
    assert.deepEqual(parseTo('web/lead'), [{ kind: 'session', address: { team: 'web', session: 'lead' } }]);
    assert.deepEqual(parseTo('leads,group:bravo,all'), [{ kind: 'leads' }, { kind: 'group', leader: 'bravo' }, { kind: 'all' }]);
  });

  it('reads team:<team> and tree:leads as groups of the tree', () => {
    assert.deepEqual(parseTo('team:web,tree:leads'), [{ kind: 'team', team: 'web' }, { kind: 'tree-leads' }]);
  });

  it('keeps all and leads after a team as session names, so a session called all stays reachable', () => {
    assert.deepEqual(parseTo('app/all'), [{ kind: 'session', address: { team: 'app', session: 'all' } }]);
  });

  it('refuses an empty item, a group with no leader or a bad one, and any other form', () => {
    for (const text of ['', 'alpha,', ',alpha', 'alpha,,bravo', 'group:', 'group:a/b', 'a/b/c', 'web/group:lead', 'all bravo', 'team:', 'team:Web', 'team:web/lead', 'tree:all', 'tree:']) {
      assert.equal(parseTo(text), undefined, text);
    }
  });
});

describe('groupIds', () => {
  it('names every session for all and every leader for leads, in config order, the sender left out', () => {
    assert.deepEqual(idsOf({ kind: 'all' }, 'alpha'), ['lead', 'bravo', 'charlie', 'delta']);
    assert.deepEqual(idsOf({ kind: 'leads' }, 'alpha'), ['lead', 'bravo', 'charlie']);
    assert.deepEqual(idsOf({ kind: 'leads' }, 'bravo'), ['lead', 'charlie']);
  });

  it('names the leader and every session under it at any depth for group:<leader>', () => {
    assert.deepEqual(idsOf({ kind: 'group', leader: 'bravo' }, 'lead'), ['bravo', 'charlie', 'delta']);
    assert.deepEqual(idsOf({ kind: 'group', leader: 'bravo' }, 'bravo'), ['charlie', 'delta']);
    assert.deepEqual(idsOf({ kind: 'group', leader: 'charlie' }, 'alpha'), ['charlie', 'delta']);
    assert.deepEqual(idsOf({ kind: 'group', leader: 'lead' }, 'delta'), ['lead', 'alpha', 'bravo', 'charlie']);
  });

  it('refuses a group led by a session that leads no one', () => {
    assert.deepEqual(groupIds(TEAM, { kind: 'group', leader: 'delta' }, 'lead'), {
      ok: false,
      problem: 'delta leads no session: group:<leader> takes the lead or a sub-lead',
    });
  });
});

function team(id: string, parent?: string, lead = 'lead'): TeamNode {
  return { team: id, statedId: id, parent, lead, sessions: [lead, 'dev'], names: new Map() };
}

describe('treeLeadsOf', () => {
  it("names every team's lead of the tree, the root first, then depth first with children by id", () => {
    const tree = new TeamTree([team('app', undefined, 'boss'), team('web', 'app'), team('ops', 'app'), team('ui', 'web'), team('shop')]);
    const leads = [{ team: 'app', id: 'boss' }, { team: 'ops', id: 'lead' }, { team: 'web', id: 'lead' }, { team: 'ui', id: 'lead' }];
    assert.deepEqual(treeLeadsOf(tree, 'ui'), leads, 'from a leaf');
    assert.deepEqual(treeLeadsOf(tree, 'app'), leads, 'from the root');
    assert.deepEqual(treeLeadsOf(tree, 'shop'), [{ team: 'shop', id: 'lead' }], 'a separate tree has its own leads');
  });

  it('gives none when the parents above the team go round a loop', () => {
    assert.equal(treeLeadsOf(new TeamTree([team('a', 'b'), team('b', 'a')]), 'a'), undefined);
  });
});
