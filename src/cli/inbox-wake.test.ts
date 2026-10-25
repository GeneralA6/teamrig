import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { formatConfig } from '../config/load.ts';
import { CliHarness, USER_HOME } from '../testing/cli-harness.ts';
import { MemoryTranscripts } from '../testing/memory-transcripts.ts';
import { SUB_TEAMS, teamConfigOf, teamHomeOf, teamInboxOf, treeHarness } from '../testing/team-tree.ts';
import { formatWakeAsk } from '../wake/asks.ts';
import { EXIT } from './runtime.ts';

const NOW = Date.parse('2030-01-08T10:00:00Z');
const MINUTE = 60_000;
const BRAVO_TAB = '0123abcd-0000-4000-8000-0000000000b1';
/** `lead` leads `alpha` and the sub-lead `bravo`, which leads `charlie`. */
const LED = { sessions: ['lead', 'alpha', 'bravo', 'charlie'], leads: { bravo: ['charlie'] } };

function askOf(kit: CliHarness, team: string, id: string): string | undefined {
  return kit.files.get(join(teamHomeOf(team), 'state', 'wake-asks', id, `${NOW}-0.json`));
}

function transcriptOf(tab: string): string {
  return join(USER_HOME, '.claude', 'projects', 'work-app', `${tab}.jsonl`);
}

describe('teamrig inbox add --wake now', () => {
  it("posts the line and a wake ask beside it, the cost cold for a receiver with no tab's transcript", async () => {
    const kit = await treeHarness(LED);
    const result = await kit.run(['inbox', 'add', '--to', 'bravo', '--text', ' the api is ready ', '--wake', 'now', '--session', 'alpha']);
    assert.deepEqual(result, {
      code: EXIT.ok,
      stdout: [
        'POSTED to bravo; bravo is reminded at its next prompt',
        "WAKES bravo if its tab is idle, within about 3 minutes: about 210k W, cold, on app's budget line",
      ],
      stderr: [],
    });
    assert.equal(kit.files.get(teamInboxOf('app', 'bravo')), '- 2030-01-08 10:00 alpha: the api is ready\n');
    assert.equal(askOf(kit, 'app', 'bravo'), formatWakeAsk({ from: 'alpha', text: 'the api is ready', at: NOW }));
  });

  it("costs a warm wake for a receiver whose latest tab wrote its transcript within messages.coldAfterMinutes", async () => {
    const kit = await treeHarness(LED);
    await kit.run(['inbox', 'read', '--session', 'bravo'], { env: { CLAUDE_CODE_SESSION_ID: BRAVO_TAB } });
    const transcripts = new MemoryTranscripts();
    transcripts.set(transcriptOf(BRAVO_TAB), '{}\n', NOW - 5 * MINUTE);
    const result = await kit.run(['inbox', 'add', '--to', 'bravo', '--text', 'hi', '--wake', 'now', '--session', 'alpha'], { transcripts });
    assert.equal(result.stdout[1], "WAKES bravo if its tab is idle, within about 3 minutes: about 27k W, warm cache, on app's budget line");
  });

  it('lets a leader wake its group, and refuses a group to a session that leads no one, posting nothing', async () => {
    const kit = await treeHarness(LED);
    const group = await kit.run(['inbox', 'add', '--to', 'group:bravo', '--text', 'merge slot is yours', '--wake', 'now', '--session', 'bravo']);
    assert.deepEqual(group.stdout, [
      'POSTED to charlie; charlie is reminded at its next prompt',
      "WAKES charlie if its tab is idle, within about 3 minutes: about 210k W, cold, on app's budget line",
    ]);
    const member = await kit.run(['inbox', 'add', '--to', 'all', '--text', 'main is frozen', '--wake', 'now', '--session', 'alpha']);
    assert.deepEqual(
      [member.code, member.stdout],
      [EXIT.refused, ["REFUSED --wake now on a group is a leader's: alpha leads no one on app; post the line without --wake, and each receiver reads it at its next prompt"]],
    );
    assert.equal(kit.files.get(teamInboxOf('app', 'lead')), undefined, 'no line posted');
    assert.equal(askOf(kit, 'app', 'lead'), undefined, 'no ask posted');
  });

  it("lets the root lead wake sessions of the teams below it, each ask in the receiver's team, on their budget lines", async () => {
    const kit = await treeHarness(LED);
    const result = await kit.run(['inbox', 'add', '--to', 'web/front,ui/pixel', '--text', 'new icons', '--wake', 'now', '--session', 'lead']);
    assert.deepEqual(result.stdout, [
      'POSTED to 2 sessions (web/front, ui/pixel); each is reminded at its next prompt',
      'WAKES at most 2 sessions, those whose tab is idle, within about 3 minutes: about 420k W (2 cold), on the budget lines of web, ui',
    ]);
    assert.equal(askOf(kit, 'web', 'front'), formatWakeAsk({ from: 'app/lead', text: 'new icons', at: NOW }));
    assert.equal(askOf(kit, 'ui', 'pixel'), formatWakeAsk({ from: 'app/lead', text: 'new icons', at: NOW }));
  });

  it("refuses another team to a sub-lead and a team above to a child team's lead, posting nothing", async () => {
    const kit = await treeHarness(LED);
    const subLead = await kit.run(['inbox', 'add', '--to', 'web/front', '--text', 'hi', '--wake', 'now', '--session', 'bravo']);
    assert.deepEqual(
      [subLead.code, subLead.stdout],
      [
        EXIT.refused,
        [
          "REFUSED --wake now reaches another team only from the lead of a team above it, since a wake spends that team's budget line: app/bravo may not wake web/front; post the line without --wake",
        ],
      ],
    );
    const up = await kit.run(['inbox', 'add', '--to', 'app/lead', '--text', 'login page done', '--wake', 'now', '--session', 'lead'], { env: { TEAMRIG_TEAM: 'web' } });
    assert.equal(up.code, EXIT.refused);
    assert.match(up.stdout.join('\n'), /web\/lead may not wake app\/lead/);
    assert.equal(kit.files.get(teamInboxOf('web', 'front')), undefined);
    assert.equal(kit.files.get(teamInboxOf('app', 'lead')), undefined);
    assert.equal(askOf(kit, 'app', 'lead'), undefined);
  });

  it('posts the line with no ask to a receiver whose team turned wakes off, and says so', async () => {
    const kit = await treeHarness(LED);
    await kit.files.write(teamConfigOf('web'), formatConfig({ ...SUB_TEAMS['web'], wake: { enabled: false } }));
    const result = await kit.run(['inbox', 'add', '--to', 'web/front,ops/run', '--text', 'deploy at 18:00', '--wake', 'now', '--session', 'lead']);
    assert.deepEqual(result.stdout, [
      'POSTED to 2 sessions (web/front, ops/run); each is reminded at its next prompt',
      "WAKES ops/run if its tab is idle, within about 3 minutes: about 210k W, cold, on ops's budget line; wake.enabled is false on the team of web/front, so its line wakes no one",
    ]);
    assert.equal(kit.files.get(teamInboxOf('web', 'front')), '- 2030-01-08 10:00 app/lead: deploy at 18:00\n');
    assert.equal(askOf(kit, 'web', 'front'), undefined);
  });

  it("says when the wake comes from the receiver's team's wake.batchSeconds", async () => {
    const kit = await treeHarness(LED);
    await kit.files.write(teamConfigOf('web'), formatConfig({ ...SUB_TEAMS['web'], wake: { batchSeconds: 600 } }));
    const result = await kit.run(['inbox', 'add', '--to', 'web/front', '--text', 'deploy at 18:00', '--wake', 'now', '--session', 'lead']);
    assert.equal(result.stdout[1], "WAKES web/front if its tab is idle, within about 11 minutes: about 210k W, cold, on web's budget line");
  });

  it('takes only now, refusing any other value before posting', async () => {
    const kit = new CliHarness();
    const result = await kit.run(['inbox', 'add', '--to', 'bravo', '--text', 'hi', '--wake', 'later', '--session', 'alpha']);
    assert.equal(result.code, EXIT.usage);
    assert.match(result.stderr.join('\n'), /--wake takes now, to wake each receiver as soon as its tab's wake check may, not "later"/);
    assert.equal(kit.files.get(teamInboxOf('app', 'bravo')), undefined);
  });
});
