import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatConfig } from '../config/load.ts';
import { CliHarness } from '../testing/cli-harness.ts';
import { SUB_TEAMS, teamConfigOf, treeHarness } from '../testing/team-tree.ts';
import { EXIT } from './runtime.ts';

const WHOLE_TREE = [
  'TREE app, 4 team(s)',
  'app (this team): lead lead (app-lead); members alpha (app-alpha), bravo (app-bravo)',
  '  ops: lead lead (ops-lead); members run (ops-run)',
  '  web: lead lead (web-lead); members front (web-front), back (web-back)',
  '    ui: lead lead (ui-lead); members pixel (ui-pixel)',
];

describe('teamrig team tree', () => {
  it('prints the whole tree from its root, marking the team the command runs for', async () => {
    const kit = await treeHarness();
    assert.deepEqual(await kit.run(['team', 'tree']), { code: EXIT.ok, stdout: WHOLE_TREE, stderr: [] });
    const fromUi = await kit.run(['team', 'tree'], { env: { TEAMRIG_TEAM: 'ui' } });
    assert.equal(fromUi.stdout[1], 'app: lead lead (app-lead); members alpha (app-alpha), bravo (app-bravo)');
    assert.equal(fromUi.stdout[4], '    ui (this team): lead lead (ui-lead); members pixel (ui-pixel)');
  });

  it('prints a team with no tree as a tree of one, and leaves other trees out', async () => {
    const kit = new CliHarness();
    await kit.files.write(teamConfigOf('blog'), formatConfig({ configVersion: 1, sessions: ['lead', 'pen'], roles: { lead: 'lead' } }));
    const result = await kit.run(['team', 'tree']);
    assert.deepEqual(result.stdout, ['TREE app, 1 team(s)', 'app (this team): lead lead (app-lead); members alpha (app-alpha), bravo (app-bravo)']);
  });

  it('warns about a broken tree and still prints what it reads', async () => {
    const kit = await treeHarness();
    await kit.files.write(teamConfigOf('deep'), formatConfig({ configVersion: 1, team: { id: 'deep', parent: 'ui' }, sessions: ['lead', 'x'], roles: { lead: 'lead' } }));
    await kit.files.write(teamConfigOf('loop'), formatConfig({ configVersion: 1, team: { id: 'loop', parent: 'loop2' }, sessions: ['lead', 'x'], roles: { lead: 'lead' } }));
    await kit.files.write(teamConfigOf('loop2'), formatConfig({ configVersion: 1, team: { id: 'loop2', parent: 'loop' }, sessions: ['lead', 'x'], roles: { lead: 'lead' } }));
    const result = await kit.run(['team', 'tree']);
    assert.equal(result.code, EXIT.ok);
    assert.equal(result.stdout.at(-1), '      deep: lead lead (deep-lead); members x (deep-x)');
    assert.deepEqual(result.stderr, ['WARN the tree has 1 problem(s); run: teamrig doctor']);
    const looped = await kit.run(['team', 'tree'], { env: { TEAMRIG_TEAM: 'loop' } });
    assert.deepEqual(looped.stdout, ['TREE loop, 2 team(s)', 'loop (this team): lead lead (loop-lead); members x (loop-x)', '  loop2: lead lead (loop2-lead); members x (loop2-x)']);
    assert.deepEqual(looped.stderr, ['WARN the tree has 1 problem(s); run: teamrig doctor']);
  });

  it('refuses a team with no config, and an extra word', async () => {
    const none = await new CliHarness(null).run(['team', 'tree']);
    assert.deepEqual([none.code, none.stdout], [EXIT.refused, ['REFUSED no team config for team app; create it with: teamrig team create app --sessions <id,id>']]);
    const extra = await new CliHarness().run(['team', 'tree', 'web']);
    assert.equal(extra.code, EXIT.usage);
  });
});

describe('teamrig who <role> in a team tree (T1143)', () => {
  it("names a role's holder on a team above by that team's name for it, else its address", async () => {
    const kit = await treeHarness({ roles: { lead: 'lead', securityReviewer: 'alpha' } });
    const web = SUB_TEAMS['web'] ?? {};
    await kit.files.write(teamConfigOf('web'), formatConfig({ ...web, roles: { lead: 'lead', securityReviewer: 'app/alpha', deliveryOwner: 'gone/po' } }));
    const fromWeb = { env: { TEAMRIG_TEAM: 'web' } };
    assert.deepEqual((await kit.run(['who', 'securityReviewer'], fromWeb)).stdout, ['app-alpha']);
    assert.deepEqual((await kit.run(['who', 'deliveryOwner'], fromWeb)).stdout, ['gone/po'], 'a team with no config to read');
    assert.deepEqual((await kit.run(['who', 'securityReviewer'])).stdout, ['app-alpha'], "the holder's own team");
    const none = await kit.run(['who', 'securityReviewer'], { env: { TEAMRIG_TEAM: 'ops' } });
    assert.deepEqual([none.code, none.stdout], [EXIT.refused, ['REFUSED no session holds the securityReviewer role']]);
  });
});

describe('teamrig who <team>/<id> in a team tree (T1276)', () => {
  const fromWeb = { env: { TEAMRIG_TEAM: 'web' } };

  it('names a session of any team of the tree, up, down, sideways or its own, by id or name', async () => {
    const kit = await treeHarness();
    const names = async (text: string): Promise<readonly string[]> => (await kit.run(['who', text], fromWeb)).stdout;
    assert.deepEqual(await names('app/lead'), ['app-lead'], 'the parent team');
    assert.deepEqual(await names('app/app-alpha'), ['app-alpha'], 'by its name there');
    assert.deepEqual(await names('ui/pixel'), ['ui-pixel'], 'a child team');
    assert.deepEqual(await names('ops/run'), ['ops-run'], 'a sibling team');
    assert.deepEqual(await names('web/front'), ['web-front'], 'its own team, written out');
  });

  it('refuses a team of a separate tree, one with no config, and a session its team does not have', async () => {
    const kit = await treeHarness();
    await kit.files.write(teamConfigOf('blog'), formatConfig({ configVersion: 1, sessions: ['lead', 'pen'], roles: { lead: 'lead' } }));
    const separate = await kit.run(['who', 'blog/pen'], fromWeb);
    assert.deepEqual([separate.code, separate.stdout], [EXIT.refused, ['REFUSED team blog is not in the tree of team web; who names the sessions of its own tree']]);
    const missing = await kit.run(['who', 'gone/po'], fromWeb);
    assert.deepEqual([missing.code, missing.stdout], [EXIT.refused, ['REFUSED team gone is not in the tree of team web; who names the sessions of its own tree']]);
    const unknown = await kit.run(['who', 'app/zed'], fromWeb);
    assert.deepEqual([unknown.code, unknown.stdout], [EXIT.refused, ['REFUSED team app: zed is not a session on this team (sessions: lead (app-lead), alpha (app-alpha), bravo (app-bravo))']]);
  });
});
