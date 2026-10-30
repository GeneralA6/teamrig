import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { testConfig } from '../testing/config.ts';
import { Roster } from './roster.ts';
import { describeNameClash, describeTreeProblem, ownerAsk, TeamTree, teamNodeOf } from './tree.ts';
import type { TeamNode, TreeProblem } from './tree.ts';
import type { RolesConfig } from './types.ts';

/** A team led by `lead` with one member `dev`, named `<team>-<id>`, under `parent` when given. */
function team(id: string, parent?: string, names: Readonly<Record<string, string>> = {}): TeamNode {
  const config = testConfig({ sessions: ['lead', 'dev'], roles: { lead: 'lead' }, names, team: parent === undefined ? { id } : { id, parent } });
  return teamNodeOf(id, config, new Roster(config, id));
}

/** Root `app` with children `web` and `ops`, and `ui` under `web`. */
const TREE = new TeamTree([team('app'), team('web', 'app'), team('ops', 'app'), team('ui', 'web')]);

describe('TeamTree', () => {
  it('reads a team node from its config and roster, renames applied', () => {
    const config = testConfig({ team: { id: 'web', parent: 'app' } });
    const node = teamNodeOf('web', config, new Roster(config, 'web', [{ v: 1, id: 'alpha', from: 'web-alpha', to: 'web-front', at: '2026-10-14T00:00:00.000Z', by: 'lead' }]));
    assert.deepEqual(node, {
      team: 'web',
      statedId: 'web',
      parent: 'app',
      lead: 'lead',
      roles: config.roles,
      sessions: ['lead', 'alpha', 'bravo'],
      names: new Map([
        ['lead', 'web-lead'],
        ['alpha', 'web-front'],
        ['bravo', 'web-bravo'],
      ]),
    });
    const older = teamNodeOf('app', testConfig(), new Roster(testConfig(), 'app'));
    assert.equal(older.statedId, undefined);
    assert.equal(older.parent, undefined);
  });

  it('finds parents, children, roots, levels and leads', () => {
    assert.deepEqual(TREE.teams, ['app', 'ops', 'ui', 'web']);
    assert.equal(TREE.node('web')?.parent, 'app');
    assert.equal(TREE.node('nope'), undefined);
    assert.equal(TREE.leadOf('ui'), 'lead');
    assert.equal(TREE.leadOf('nope'), undefined);
    assert.equal(TREE.parentOf('ui'), 'web');
    assert.equal(TREE.parentOf('app'), undefined);
    assert.deepEqual(TREE.parentLeadOf('ui'), { team: 'web', id: 'lead' });
    assert.equal(TREE.parentLeadOf('app'), undefined);
    assert.equal(TREE.parentLeadOf('nope'), undefined);
    assert.deepEqual(TREE.ownerLeadAbove('web'), { team: 'app', id: 'lead' });
    assert.deepEqual(TREE.ownerLeadAbove('ui'), { team: 'app', id: 'lead' }, "the root's lead, not the parent's");
    assert.equal(TREE.ownerLeadAbove('app'), undefined);
    assert.equal(TREE.ownerLeadAbove('nope'), undefined);
    assert.deepEqual(TREE.childrenOf('app'), ['ops', 'web']);
    assert.deepEqual(TREE.childrenOf('ui'), []);
    assert.equal(TREE.rootOf('ui'), 'app');
    assert.equal(TREE.rootOf('nope'), undefined);
    assert.equal(TREE.levelOf('app'), 1);
    assert.equal(TREE.levelOf('ui'), 3);
    assert.deepEqual(TREE.ancestorsOf('ui'), ['app', 'web']);
    assert.deepEqual(TREE.ancestorsOf('ops'), ['app']);
    assert.deepEqual(TREE.ancestorsOf('app'), []);
    assert.deepEqual(TREE.ancestorsOf('nope'), []);
  });

  it('walks down depth first and tells which teams share a tree', () => {
    assert.deepEqual(TREE.walk('app'), [
      { team: 'app', depth: 0 },
      { team: 'ops', depth: 1 },
      { team: 'web', depth: 1 },
      { team: 'ui', depth: 2 },
    ]);
    assert.deepEqual(TREE.descendantsOf('web'), ['ui']);
    assert.deepEqual(TREE.descendantsOf('ops'), []);
    const two = TREE.with(team('solo'));
    assert.equal(two.sameTree('ui', 'ops'), true);
    assert.equal(two.sameTree('ui', 'solo'), false);
    assert.equal(two.sameTree('solo', 'solo'), true);
  });

  it('finds nothing wrong with a sound tree', () => {
    assert.deepEqual(TREE.problems(), []);
    assert.deepEqual(TREE.nameClashes(), []);
  });

  it('flags a team id that is not the folder name and a parent with no config', () => {
    const config = testConfig({ team: { id: 'webby', parent: 'gone' } });
    const tree = TREE.with(teamNodeOf('web', config, new Roster(config, 'web')));
    assert.deepEqual(tree.problems(), [
      { kind: 'tree-id', team: 'web', stated: 'webby' },
      { kind: 'tree-parent', team: 'web', parent: 'gone' },
    ]);
    assert.equal(tree.parentOf('web'), undefined);
    assert.equal(tree.rootOf('ui'), 'web');
    assert.deepEqual(tree.ancestorsOf('ui'), ['web']);
  });

  it('flags a loop of parents once, and walks it without going round', () => {
    const tree = new TeamTree([team('a', 'c'), team('b', 'a'), team('c', 'b'), team('d', 'a')]);
    assert.deepEqual(tree.problems(), [{ kind: 'tree-loop', teams: ['a', 'b', 'c'] }]);
    assert.equal(tree.rootOf('d'), undefined);
    assert.deepEqual(tree.ownerLeadAbove('d'), { team: 'a', id: 'lead' }, 'no root: the parent lead');
    assert.equal(tree.levelOf('a'), undefined);
    assert.deepEqual(tree.ancestorsOf('d'), []);
    assert.deepEqual(
      tree.walk('a').map((step) => step.team),
      ['a', 'b', 'c', 'd'],
    );
  });

  it('flags only the top team of a branch below the deepest level', () => {
    const tree = TREE.with(team('deep', 'ui')).with(team('deeper', 'deep'));
    assert.deepEqual(tree.problems(), [{ kind: 'tree-depth', team: 'deep', level: 4 }]);
  });

  it('flags a team with more child teams than allowed', () => {
    const children = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8'].map((id) => team(id, 'app'));
    const full = new TeamTree([team('app'), ...children]);
    assert.deepEqual(full.problems(), []);
    assert.deepEqual(full.with(team('c9', 'app')).problems(), [
      { kind: 'tree-children', team: 'app', children: ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8', 'c9'] },
    ]);
  });

  it('flags a role left to a team that is not above, or to a session that does not hold it there (T1143)', () => {
    const roled = (id: string, parent: string | undefined, roles: RolesConfig): TeamNode => {
      const config = testConfig({ sessions: ['lead', 'dev'], roles, team: parent === undefined ? { id } : { id, parent } });
      return teamNodeOf(id, config, new Roster(config, id));
    };
    const tree = new TeamTree([
      roled('app', undefined, { lead: 'lead', deliveryOwner: 'dev', securityReviewer: 'dev' }),
      roled('web', 'app', { lead: 'lead', deliveryOwner: 'app/dev', securityReviewer: 'app/dev' }),
      roled('ui', 'web', { lead: 'lead', deliveryOwner: 'web/dev', securityReviewer: 'app/dev' }),
      roled('ops', 'app', { lead: 'lead', securityReviewer: 'web/dev' }),
    ]);
    assert.deepEqual(tree.ancestorsOf('ui'), ['app', 'web']);
    assert.deepEqual(tree.problems(), [
      { kind: 'tree-role', team: 'ops', role: 'securityReviewer', holder: { team: 'web', id: 'dev' }, reason: 'not-above' },
      { kind: 'tree-role', team: 'ui', role: 'deliveryOwner', holder: { team: 'web', id: 'dev' }, reason: 'not-holder' },
    ]);
  });

  it('finds a session name two teams use, but not one team using its own names', () => {
    const tree = TREE.with(team('ops', 'app', { dev: 'web-dev' }));
    assert.deepEqual(tree.nameClashes(), [
      {
        name: 'web-dev',
        holders: [
          { team: 'ops', id: 'dev' },
          { team: 'web', id: 'dev' },
        ],
      },
    ]);
  });
});

describe('ownerAsk', () => {
  it('names the owner in a root team', () => {
    assert.equal(ownerAsk(testConfig({ team: { id: 'app' } })), 'the owner');
    assert.equal(ownerAsk(testConfig()), 'the owner');
  });

  it("names the parent team's lead in a child team, never the owner directly", () => {
    assert.equal(ownerAsk(testConfig({ team: { id: 'web', parent: 'app' } })), 'the lead of team app, who takes it to the owner');
  });
});

describe('describeTreeProblem', () => {
  it('says what is wrong and how to fix it, for every kind', () => {
    const problems: TreeProblem[] = [
      { kind: 'tree-id', team: 'web', stated: 'webby' },
      { kind: 'tree-parent', team: 'web', parent: 'gone' },
      { kind: 'tree-loop', teams: ['a', 'b'] },
      { kind: 'tree-depth', team: 'deep', level: 4 },
      { kind: 'tree-children', team: 'app', children: ['a', 'b'] },
      { kind: 'tree-role', team: 'ops', role: 'securityReviewer', holder: { team: 'web', id: 'dev' }, reason: 'not-above' },
      { kind: 'tree-role', team: 'ui', role: 'deliveryOwner', holder: { team: 'web', id: 'dev' }, reason: 'not-holder' },
    ];
    const lines = problems.map((problem) => describeTreeProblem(problem, 'teamrig'));
    assert.match(lines[5] ?? '', /roles\.securityReviewer names web\/dev, but team web is not above ops: name the holder on a team above it/);
    assert.match(lines[6] ?? '', /names web\/dev, which does not hold roles\.deliveryOwner on team web: name the session that does/);
    assert.match(lines[0] ?? '', /team\.id "webby", but its folder is web: set team\.id to web/);
    assert.match(lines[1] ?? '', /`teamrig team create gone`/);
    assert.match(lines[2] ?? '', /teams a, b name each other as parents in a loop/);
    assert.match(lines[3] ?? '', /level 4 .* at most 3 levels/);
    assert.match(lines[4] ?? '', /2 child teams \(a, b\), and a team has at most 8/);
  });

  it('names every holder of a clashing session name and the rename fix', () => {
    const line = describeNameClash(
      {
        name: 'web-dev',
        holders: [
          { team: 'ops', id: 'dev' },
          { team: 'web', id: 'dev' },
        ],
      },
      'teamrig',
    );
    assert.match(line, /^web-dev is the session name of ops\/dev, web\/dev: .*`teamrig rename`$/);
  });
});

describe('TeamTree.placeOf', () => {
  it("gives a team's root, its parent lead by name and its child teams", () => {
    assert.deepEqual(TREE.placeOf('app'), { root: 'app', parentLead: undefined, children: ['ops', 'web'] });
    assert.deepEqual(TREE.placeOf('web'), { root: 'app', parentLead: { team: 'app', id: 'lead', name: 'app-lead' }, children: ['ui'] });
    assert.deepEqual(TREE.placeOf('ui'), { root: 'app', parentLead: { team: 'web', id: 'lead', name: 'web-lead' }, children: [] });
    const renamed = new TeamTree([team('app', undefined, { lead: 'boss' }), team('web', 'app')]);
    assert.equal(renamed.placeOf('web')?.parentLead?.name, 'boss');
  });

  it('has no place for a team on its own or one whose parents loop', () => {
    assert.equal(new TeamTree([team('blog')]).placeOf('blog'), undefined);
    assert.equal(new TeamTree([team('blog', 'gone')]).placeOf('blog'), undefined);
    assert.equal(new TeamTree([team('a', 'b'), team('b', 'a')]).placeOf('a'), undefined);
  });
});

describe('TeamTree.problemsOf and nameClashesOf', () => {
  it("keeps the problems of the team's own tree and the names it shares", () => {
    const tree = new TeamTree([
      team('app'),
      team('web', 'app', { dev: 'shared' }),
      team('blog', 'gone', { dev: 'shared' }),
      team('a', 'b'),
      team('b', 'a', { dev: 'b-dev' }),
      team('c', 'a'),
    ]);
    assert.deepEqual(tree.problemsOf('web'), []);
    assert.deepEqual(tree.problemsOf('blog'), [{ kind: 'tree-parent', team: 'blog', parent: 'gone' }]);
    assert.deepEqual(tree.problemsOf('c'), [{ kind: 'tree-loop', teams: ['a', 'b'] }]);
    assert.deepEqual(tree.nameClashesOf('web').map((clash) => clash.name), ['shared']);
    assert.deepEqual(tree.nameClashesOf('app'), []);
  });
});
