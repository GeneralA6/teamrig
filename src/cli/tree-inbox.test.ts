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

  it("points a sub-lead's member at its own leader, not the team's lead", async () => {
    const kit = await treeHarness({ leads: { bravo: ['alpha'] } });
    const member = await kit.run(['inbox', 'add', '--to', 'web/lead', '--text', 'hi', '--session', 'alpha']);
    assert.deepEqual([member.code, member.stdout], [
      EXIT.refused,
      ['REFUSED app/alpha may write to its own team only, and web/lead is not on it: escalate through your lead (app/bravo)'],
    ]);
  });

  it('refuses a member writing outside its team, and a lead skipping a level, writing nothing', async () => {
    const kit = await treeHarness();
    const member = await kit.run(['inbox', 'add', '--to', 'web/lead', '--text', 'hi', '--session', 'alpha']);
    assert.deepEqual([member.code, member.stdout], [
      EXIT.refused,
      ['REFUSED app/alpha may write to its own team only, and web/lead is not on it: escalate through your lead (app/lead)'],
    ]);
    const skip = await kit.run(['inbox', 'add', '--to', 'ui/lead', '--text', 'hi', '--session', 'lead']);
    assert.equal(skip.code, EXIT.refused);
    assert.match(skip.stdout[0] ?? '', /ui\/lead is none of them: escalate through your lead/);
    const toMember = await kit.run(['inbox', 'add', '--to', 'web/front', '--text', 'hi', '--session', 'lead']);
    assert.equal(toMember.code, EXIT.refused);
    assert.equal(kit.files.get(teamInboxOf('web', 'lead')), undefined);
    assert.equal(kit.files.get(teamInboxOf('ui', 'lead')), undefined);
    assert.equal(kit.files.get(teamInboxOf('web', 'front')), undefined);
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
    assert.match(bad.stderr[0] ?? '', /^--to "web\/lead\/x" is not a session id or name, or <team>\/<id>/);
  });
});
