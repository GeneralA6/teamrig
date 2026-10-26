import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatConfig } from '../config/load.ts';
import { teamConfigOf, teamInboxOf, treeHarness } from '../testing/team-tree.ts';
import { EXIT } from './runtime.ts';

describe('teamrig inbox add across a tree of teams', () => {
  it('lets the root lead write to a child lead, the line naming it <team>/<id>', async () => {
    const kit = await treeHarness();
    const result = await kit.run(['inbox', 'add', '--to', 'web/lead', '--text', 'ship the login page', '--session', 'lead']);
    assert.deepEqual(result, { code: EXIT.ok, stdout: ['POSTED to web/lead; web/lead is reminded at its next prompt'], stderr: [] });
    assert.equal(kit.files.get(teamInboxOf('web', 'lead')), '- 2030-01-08 10:00 app/lead: ship the login page\n');
    const read = await kit.run(['inbox', 'read', '--session', 'lead'], { env: { TEAMRIG_TEAM: 'web' } });
    assert.equal(read.stdout[0], '- 2030-01-08 10:00 UTC app/lead: ship the login page');
  });

  it('lets a sub-team lead write up to its parent lead and down to its child lead, by id or name', async () => {
    const kit = await treeHarness();
    const env = { TEAMRIG_TEAM: 'web' };
    const up = await kit.run(['inbox', 'add', '--to', 'app/app-lead', '--text', 'login page done', '--session', 'web-lead'], { env });
    assert.deepEqual(up.stdout, ['POSTED to app/lead; app/lead is reminded at its next prompt']);
    assert.equal(kit.files.get(teamInboxOf('app', 'lead')), '- 2030-01-08 10:00 web/lead: login page done\n');
    const down = await kit.run(['inbox', 'add', '--to', 'ui/lead', '--text', 'new icons', '--session', 'lead'], { env });
    assert.equal(down.code, EXIT.ok);
  });

  it('keeps a bare id and its own team name on the sender team, with a bare sender as before', async () => {
    const kit = await treeHarness();
    await kit.run(['inbox', 'add', '--to', 'bravo', '--text', 'one', '--session', 'alpha']);
    const qualified = await kit.run(['inbox', 'add', '--to', 'app/bravo', '--text', 'two', '--session', 'alpha']);
    assert.deepEqual(qualified.stdout, ['POSTED to bravo; bravo is reminded at its next prompt']);
    assert.equal(kit.files.get(teamInboxOf('app', 'bravo')), '- 2030-01-08 10:00 alpha: one\n- 2030-01-08 10:00 alpha: two\n');
  });

  it("lets a member write to another team's lead and members, and a lead past a level, with no relay", async () => {
    const kit = await treeHarness();
    const member = await kit.run(['inbox', 'add', '--to', 'web/lead', '--text', 'the api is ready', '--session', 'alpha']);
    assert.deepEqual([member.code, member.stdout], [EXIT.ok, ['POSTED to web/lead; web/lead is reminded at its next prompt']]);
    assert.equal(kit.files.get(teamInboxOf('web', 'lead')), '- 2030-01-08 10:00 app/alpha: the api is ready\n');
    const sibling = await kit.run(['inbox', 'add', '--to', 'ops/run', '--text', 'deploy after 18:00', '--session', 'front'], { env: { TEAMRIG_TEAM: 'web' } });
    assert.equal(sibling.code, EXIT.ok);
    assert.equal(kit.files.get(teamInboxOf('ops', 'run')), '- 2030-01-08 10:00 web/front: deploy after 18:00\n');
    const skip = await kit.run(['inbox', 'add', '--to', 'ui/pixel', '--text', 'new icons', '--session', 'lead']);
    assert.equal(skip.code, EXIT.ok);
    assert.equal(kit.files.get(teamInboxOf('ui', 'pixel')), '- 2030-01-08 10:00 app/lead: new icons\n');
  });

  it('refuses a session of a separate tree of teams, writing nothing', async () => {
    const kit = await treeHarness();
    await kit.files.write(teamConfigOf('shop'), formatConfig({ configVersion: 1, team: { id: 'shop' }, sessions: ['lead', 'till'], roles: { lead: 'lead' } }));
    const other = await kit.run(['inbox', 'add', '--to', 'shop/till', '--text', 'hi', '--session', 'lead']);
    assert.deepEqual([other.code, other.stdout], [
      EXIT.refused,
      ['REFUSED app/lead and shop/till are in separate trees of teams: an inbox line reaches only a session of its own tree'],
    ]);
    assert.equal(kit.files.get(teamInboxOf('shop', 'till')), undefined);
  });

  it('posts team:<team> to every session of that team, and of its own team with the sender left out', async () => {
    const kit = await treeHarness();
    const web = await kit.run(['inbox', 'add', '--to', 'team:web', '--text', 'freeze at 20:00', '--session', 'alpha']);
    assert.deepEqual(web.stdout, ['POSTED to 3 sessions (web/lead, web/front, web/back); each is reminded at its next prompt']);
    assert.equal(kit.files.get(teamInboxOf('web', 'back')), '- 2030-01-08 10:00 app/alpha: freeze at 20:00\n');
    const own = await kit.run(['inbox', 'add', '--to', 'team:app', '--text', 'standup', '--session', 'alpha']);
    assert.deepEqual(own.stdout, ['POSTED to 2 sessions (lead, bravo); each is reminded at its next prompt']);
    assert.equal(kit.files.get(teamInboxOf('app', 'bravo')), '- 2030-01-08 10:00 alpha: standup\n');
  });

  it("posts tree:leads to every team's lead of the tree, the root first, the sender left out", async () => {
    const kit = await treeHarness();
    const root = await kit.run(['inbox', 'add', '--to', 'tree:leads', '--text', 'the week resets at 03:00', '--session', 'lead']);
    assert.deepEqual(root.stdout, ['POSTED to 3 sessions (ops/lead, web/lead, ui/lead); each is reminded at its next prompt']);
    assert.equal(kit.files.get(teamInboxOf('ui', 'lead')), '- 2030-01-08 10:00 app/lead: the week resets at 03:00\n');
    const member = await kit.run(['inbox', 'add', '--to', 'tree:leads,web/front', '--text', 'docs moved', '--session', 'pixel'], { env: { TEAMRIG_TEAM: 'ui' } });
    assert.deepEqual(member.stdout, ['POSTED to 5 sessions (app/lead, ops/lead, web/lead, lead, web/front); each is reminded at its next prompt']);
  });

  it('refuses team:<team> for an unknown team or one of a separate tree, writing nothing', async () => {
    const kit = await treeHarness();
    await kit.files.write(teamConfigOf('shop'), formatConfig({ configVersion: 1, team: { id: 'shop' }, sessions: ['lead', 'till'], roles: { lead: 'lead' } }));
    const unknown = await kit.run(['inbox', 'add', '--to', 'alpha,team:blog', '--text', 'hi', '--session', 'lead']);
    assert.deepEqual([unknown.code, unknown.stdout], [EXIT.refused, ['REFUSED no team blog with a config in this kit home']]);
    const apart = await kit.run(['inbox', 'add', '--to', 'team:shop', '--text', 'hi', '--session', 'lead']);
    assert.equal(apart.code, EXIT.refused);
    assert.match(apart.stdout[0] ?? '', /^REFUSED app\/lead and shop\/lead are in separate trees of teams/);
    assert.deepEqual([kit.files.get(teamInboxOf('app', 'alpha')), kit.files.get(teamInboxOf('shop', 'lead'))], [undefined, undefined]);
  });

  it('posts task:T<n> to the owner of the task and of each active task of the tree whose ref is T<n>, the sender left out', async () => {
    const kit = await treeHarness();
    const task = ['--description', 'what and why', '--priority', 'p2', '--session', 'lead'];
    await kit.run(['add', '--owner', 'bravo', '--title', 'Login', ...task]);
    await kit.run(['add', '--team', 'web', '--owner', 'web-front', '--title', 'Login form', '--ref', 'T1', ...task]);
    await kit.run(['add', '--team', 'ui', '--title', 'Login icons', '--ref', 'T1', ...task]);
    await kit.run(['add', '--team', 'ops', '--title', 'Login logs', '--ref', 'see T1', ...task]);
    const result = await kit.run(['inbox', 'add', '--to', 'task:T1', '--text', 'the design is in docs/login.md', '--session', 'front'], { env: { TEAMRIG_TEAM: 'web' } });
    assert.deepEqual([result.code, result.stdout], [EXIT.ok, ['POSTED to 2 sessions (app/bravo, ui/lead); each is reminded at its next prompt']]);
    assert.match(kit.files.get(teamInboxOf('app', 'bravo')) ?? '', /\n- 2030-01-08 10:00 web\/front: the design is in docs\/login\.md\n$/);
    assert.match(kit.files.get(teamInboxOf('ui', 'lead')) ?? '', /\n- 2030-01-08 10:00 web\/front: the design is in docs\/login\.md\n$/);
    await kit.files.write(teamConfigOf('web'), formatConfig({ configVersion: 1, team: { id: 'web', parent: 'app' }, sessions: ['lead', 'back'], roles: { lead: 'lead' } }));
    const owners = await kit.run(['inbox', 'add', '--to', 'task:T1', '--text', 'review on friday', '--session', 'alpha']);
    assert.deepEqual(owners.stdout, ['POSTED to 2 sessions (bravo, ui/lead); each is reminded at its next prompt'], 'an owner no longer a session of its team is left out');
  });

  it('refuses task:T<n> for a task no register of the tree holds, and its wake from a session that leads no one', async () => {
    const kit = await treeHarness();
    await kit.run(['add', '--owner', 'bravo', '--title', 'Login', '--description', 'what and why', '--priority', 'p2', '--session', 'lead']);
    const unknown = await kit.run(['inbox', 'add', '--to', 'alpha,task:T9', '--text', 'hi', '--session', 'lead']);
    assert.deepEqual([unknown.code, unknown.stdout], [EXIT.refused, ['REFUSED no task T9 in a register of the tree of teams app is in']]);
    assert.equal(kit.files.get(teamInboxOf('app', 'alpha')), undefined);
    const woken = await kit.run(['inbox', 'add', '--to', 'task:T1', '--text', 'hi', '--wake', 'now', '--session', 'alpha']);
    assert.equal(woken.code, EXIT.refused);
  });

  it('refuses tree:leads from the lead of a one-team tree, which names no one but the sender', async () => {
    const kit = await treeHarness();
    await kit.files.write(teamConfigOf('shop'), formatConfig({ configVersion: 1, team: { id: 'shop' }, sessions: ['lead', 'till'], roles: { lead: 'lead' } }));
    const alone = await kit.run(['inbox', 'add', '--to', 'tree:leads', '--text', 'hi', '--session', 'lead'], { env: { TEAMRIG_TEAM: 'shop' } });
    assert.deepEqual([alone.code, alone.stdout], [EXIT.refused, ['REFUSED --to tree:leads names no session but the sender lead']]);
  });

  it('refuses an unknown team or session, a broken target config, a secret and a bad address', async () => {
    const kit = await treeHarness();
    const noTeam = await kit.run(['inbox', 'add', '--to', 'blog/lead', '--text', 'hi', '--session', 'lead']);
    assert.deepEqual(noTeam.stdout, ['REFUSED no team blog with a config in this kit home']);
    const noSession = await kit.run(['inbox', 'add', '--to', 'web/zulu', '--text', 'hi', '--session', 'lead']);
    assert.equal(noSession.code, EXIT.refused);
    const secret = await kit.run(['inbox', 'add', '--to', 'web/lead', '--text', 'the password=hunter2', '--session', 'lead']);
    assert.deepEqual(secret.stdout, ['REFUSED the line looks like it holds a secret (password or key assignment); refer to where it is kept instead']);
    await kit.files.write(
      teamConfigOf('web'),
      formatConfig({ configVersion: 1, team: { id: 'web', parent: 'app' }, sessions: ['lead', 'front'], roles: { lead: 'lead' }, register: { secretPatterns: ['acme-[0-9]+'] } }),
    );
    const theirs = await kit.run(['inbox', 'add', '--to', 'web/lead', '--text', 'key acme-123', '--session', 'lead']);
    assert.deepEqual(
      theirs.stdout,
      ['REFUSED the line looks like it holds a secret (secret pattern from the team config); refer to where it is kept instead'],
      'the receiving team secret patterns apply too',
    );
    await kit.files.write(teamConfigOf('ops'), formatConfig({ configVersion: 1, team: { id: 'ops', parent: 'app' }, sessions: ['lead', 'run'], roles: { lead: 'lead' }, messages: { maxLines: 1 } }));
    const broken = await kit.run(['inbox', 'add', '--to', 'ops/lead', '--text', 'hi', '--session', 'lead']);
    assert.match(broken.stdout[0] ?? '', /^REFUSED the team config has 1 problem\(s\)/);
    const bad = await kit.run(['inbox', 'add', '--to', 'web/lead/x', '--text', 'hi', '--session', 'lead']);
    assert.equal(bad.code, EXIT.usage);
    assert.match(bad.stderr[0] ?? '', /^--to "web\/lead\/x" is not a session id or name, <team>\/<id>, all, leads, group:<leader>, team:<team>, tree:leads, task:T<n>, or a comma-separated list/);
  });
});
