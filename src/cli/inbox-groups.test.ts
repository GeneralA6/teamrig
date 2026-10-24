import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatConfig } from '../config/load.ts';
import { CliHarness, TEAM } from '../testing/cli-harness.ts';
import { teamConfigOf, teamInboxOf, treeHarness } from '../testing/team-tree.ts';
import { EXIT } from './runtime.ts';

/** `lead` leads `alpha` and the sub-lead `bravo`, which leads `charlie`. */
const LED = { ...TEAM, sessions: ['lead', 'alpha', 'bravo', 'charlie'], leads: { bravo: ['charlie'] } };

function inboxOf(kit: CliHarness, id: string): string | undefined {
  return kit.files.get(teamInboxOf('app', id));
}

describe('teamrig inbox add to a group', () => {
  it('posts the same line to every session for all, leaving the sender out', async () => {
    const kit = new CliHarness(LED);
    const result = await kit.run(['inbox', 'add', '--to', 'all', '--text', 'main is frozen until 14:00', '--session', 'alpha']);
    assert.deepEqual(result, {
      code: EXIT.ok,
      stdout: ['POSTED to 3 sessions (lead, bravo, charlie); each is reminded at its next prompt'],
      stderr: [],
    });
    for (const id of ['lead', 'bravo', 'charlie']) {
      assert.equal(inboxOf(kit, id), '- 2030-01-08 10:00 alpha: main is frozen until 14:00\n', id);
    }
    assert.equal(inboxOf(kit, 'alpha'), undefined, 'the sender gets no copy');
  });

  it('posts to the lead and the sub-leads for leads, and to a leader and its sessions for group:<leader>', async () => {
    const kit = new CliHarness(LED);
    const leads = await kit.run(['inbox', 'add', '--to', 'leads', '--text', 'plan the week', '--session', 'charlie']);
    assert.deepEqual(leads.stdout, ['POSTED to 2 sessions (lead, bravo); each is reminded at its next prompt']);
    const group = await kit.run(['inbox', 'add', '--to', 'group:app-bravo', '--text', 'merge slot is yours', '--session', 'lead']);
    assert.deepEqual(group.stdout, ['POSTED to 2 sessions (bravo, charlie); each is reminded at its next prompt'], 'the leader by its name');
    assert.equal(inboxOf(kit, 'bravo'), '- 2030-01-08 10:00 charlie: plan the week\n- 2030-01-08 10:00 lead: merge slot is yours\n');
    assert.equal(inboxOf(kit, 'alpha'), undefined);
  });

  it('posts a list once to each receiver named, in the order first named, keeping a sender named on its own', async () => {
    const kit = new CliHarness(LED);
    const result = await kit.run(['inbox', 'add', '--to', 'bravo,app-bravo,alpha,leads', '--text', 'hi', '--session', 'alpha']);
    assert.deepEqual(result.stdout, ['POSTED to 3 sessions (bravo, alpha, lead); each is reminded at its next prompt']);
    assert.equal(inboxOf(kit, 'bravo'), '- 2030-01-08 10:00 alpha: hi\n');
    assert.equal(inboxOf(kit, 'alpha'), '- 2030-01-08 10:00 alpha: hi\n');
  });

  it('refuses a group of only the sender, a group led by no leader, and a bad list, writing nothing', async () => {
    const kit = new CliHarness();
    const alone = await kit.run(['inbox', 'add', '--to', 'leads', '--text', 'hi', '--session', 'lead']);
    assert.deepEqual([alone.code, alone.stdout], [EXIT.refused, ['REFUSED --to leads names no session but the sender lead']]);
    const notLeader = await kit.run(['inbox', 'add', '--to', 'group:alpha', '--text', 'hi', '--session', 'lead']);
    assert.deepEqual(notLeader.stdout, ['REFUSED alpha leads no session: group:<leader> takes the lead or a sub-lead']);
    const stranger = await kit.run(['inbox', 'add', '--to', 'bravo,zulu', '--text', 'hi', '--session', 'lead']);
    assert.equal(stranger.code, EXIT.refused);
    const secret = await kit.run(['inbox', 'add', '--to', 'all', '--text', 'the password=hunter2', '--session', 'lead']);
    assert.equal(secret.code, EXIT.refused);
    const usage = await kit.run(['inbox', 'add', '--to', 'bravo,', '--text', 'hi', '--session', 'lead']);
    assert.equal(usage.code, EXIT.usage);
    assert.match(usage.stderr.join('\n'), /--to "bravo," is not a session id or name, <team>\/<id>, all, leads, group:<leader>, or a comma-separated list of them/);
    assert.deepEqual([inboxOf(kit, 'alpha'), inboxOf(kit, 'bravo')], [undefined, undefined]);
  });

  it('reaches a session called all through its team address', async () => {
    const kit = new CliHarness({ ...TEAM, sessions: ['lead', 'all', 'bravo'] });
    const one = await kit.run(['inbox', 'add', '--to', 'app/all', '--text', 'hi', '--session', 'lead']);
    assert.deepEqual(one.stdout, ['POSTED to all; all is reminded at its next prompt']);
    const group = await kit.run(['inbox', 'add', '--to', 'all', '--text', 'hi', '--session', 'lead']);
    assert.deepEqual(group.stdout, ['POSTED to 2 sessions (all, bravo); each is reminded at its next prompt']);
  });
});

describe('teamrig inbox add to a list across a tree of teams', () => {
  it('checks reach per receiver and names the sender as each receiver team knows it', async () => {
    const kit = await treeHarness();
    const result = await kit.run(['inbox', 'add', '--to', 'web/lead,ops/lead,alpha', '--text', 'release at 18:00', '--session', 'lead']);
    assert.deepEqual(result.stdout, ['POSTED to 3 sessions (web/lead, ops/lead, alpha); each is reminded at its next prompt']);
    assert.equal(kit.files.get(teamInboxOf('web', 'lead')), '- 2030-01-08 10:00 app/lead: release at 18:00\n');
    assert.equal(kit.files.get(teamInboxOf('ops', 'lead')), '- 2030-01-08 10:00 app/lead: release at 18:00\n');
    assert.equal(kit.files.get(teamInboxOf('app', 'alpha')), '- 2030-01-08 10:00 lead: release at 18:00\n');
  });

  it('refuses the whole list when one receiver is out of reach or its team refuses the line', async () => {
    const kit = await treeHarness();
    const skip = await kit.run(['inbox', 'add', '--to', 'alpha,web/lead,ui/lead', '--text', 'hi', '--session', 'lead']);
    assert.equal(skip.code, EXIT.refused);
    assert.match(skip.stdout[0] ?? '', /ui\/lead is none of them/);
    await kit.files.write(
      teamConfigOf('web'),
      formatConfig({ configVersion: 1, team: { id: 'web', parent: 'app' }, sessions: ['lead', 'front'], roles: { lead: 'lead' }, register: { secretPatterns: ['acme-[0-9]+'] } }),
    );
    const theirs = await kit.run(['inbox', 'add', '--to', 'alpha,web/lead', '--text', 'key acme-123', '--session', 'lead']);
    assert.equal(theirs.code, EXIT.refused, 'a receiving team secret pattern refuses the line for every receiver');
    assert.deepEqual([kit.files.get(teamInboxOf('app', 'alpha')), kit.files.get(teamInboxOf('web', 'lead'))], [undefined, undefined]);
  });
});
