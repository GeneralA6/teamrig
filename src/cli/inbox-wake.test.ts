import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { formatConfig } from '../config/load.ts';
import { lineHash } from '../inbox/line-hash.ts';
import { meterDearDay } from '../testing/budget-hold.ts';
import { CliHarness, USER_HOME } from '../testing/cli-harness.ts';
import { MemoryTranscripts } from '../testing/memory-transcripts.ts';
import { SUB_TEAMS, teamConfigOf, teamHomeOf, teamInboxOf, treeHarness } from '../testing/team-tree.ts';
import { formatWakeAsk } from '../wake/asks.ts';
import { EXIT } from './runtime.ts';

const NOW = Date.parse('2030-01-08T10:00:00Z');
const MINUTE = 60_000;
const ALPHA_TAB = '0123abcd-0000-4000-8000-0000000000a1';
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
        "WAKES bravo if its tab is idle, within about 3 minutes: at least about 210k W for the first call, cold; whole turns usually cost more, on app's budget line",
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
    assert.equal(result.stdout[1], "WAKES bravo if its tab is idle, within about 3 minutes: at least about 27k W for the first call, warm cache; whole turns usually cost more, on app's budget line");
  });

  it("prices the wake at today's W per percent, as the wake check does, on a day dearer than its week (T1138)", async () => {
    const kit = await treeHarness({ ...LED, budget: { weeklyLimitW: 1_000_000_000 } });
    await meterDearDay(kit, 'alpha', ALPHA_TAB);
    const result = await kit.run(['inbox', 'add', '--to', 'bravo', '--text', 'hi', '--wake', 'now', '--session', 'alpha']);
    assert.equal(result.stdout[1], "WAKES bravo if its tab is idle, within about 3 minutes: at least about 210k W for the first call, cold, 0.04% of the week; whole turns usually cost more, on app's budget line", 'the week rate would say 0.02%');
  });

  it('lets a leader wake its group, and refuses a group to a session that leads no one, posting nothing', async () => {
    const kit = await treeHarness(LED);
    const group = await kit.run(['inbox', 'add', '--to', 'group:bravo', '--text', 'merge slot is yours', '--wake', 'now', '--session', 'bravo']);
    assert.deepEqual(group.stdout, [
      'POSTED to charlie; charlie is reminded at its next prompt',
      "WAKES charlie if its tab is idle, within about 3 minutes: at least about 210k W for the first call, cold; whole turns usually cost more, on app's budget line",
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

  it("lets a child team's lead wake its parent lead, a sibling team's lead and the role holder above its config names (T2685)", async () => {
    const kit = await treeHarness(LED);
    await kit.files.write(teamConfigOf('web'), formatConfig({ ...SUB_TEAMS['web'], roles: { lead: 'lead', securityReviewer: 'app/alpha' } }));
    const result = await kit.run(['inbox', 'add', '--to', 'app/lead,ops/lead,app/alpha', '--text', 'p0 waits on a review', '--wake', 'now', '--session', 'lead'], {
      env: { TEAMRIG_TEAM: 'web' },
    });
    assert.equal(result.code, EXIT.ok);
    for (const [team, id] of [['app', 'lead'], ['ops', 'lead'], ['app', 'alpha']] as const) {
      assert.equal(askOf(kit, team, id), formatWakeAsk({ from: 'web/lead', text: 'p0 waits on a review', at: NOW }));
    }
  });

  it("refuses another team to a sub-lead, and a team above's other sessions to a child team's lead, posting nothing", async () => {
    const kit = await treeHarness(LED);
    const subLead = await kit.run(['inbox', 'add', '--to', 'web/front', '--text', 'hi', '--wake', 'now', '--session', 'bravo']);
    assert.deepEqual(
      [subLead.code, subLead.stdout],
      [
        EXIT.refused,
        [
          "REFUSED --wake now reaches another team only from a team lead, since a wake spends that team's budget line: a session of a team below its own, any team's lead, or a session its config names in roles; app/bravo may not wake web/front; post the line without --wake, or ask your lead to wake it",
        ],
      ],
    );
    const up = await kit.run(['inbox', 'add', '--to', 'app/alpha', '--text', 'login page done', '--wake', 'now', '--session', 'lead'], { env: { TEAMRIG_TEAM: 'web' } });
    assert.equal(up.code, EXIT.refused);
    assert.match(up.stdout.join('\n'), /web\/lead may not wake app\/alpha/);
    assert.equal(kit.files.get(teamInboxOf('web', 'front')), undefined);
    assert.equal(kit.files.get(teamInboxOf('app', 'alpha')), undefined);
    assert.equal(askOf(kit, 'app', 'alpha'), undefined);
  });

  it('posts the line with no ask to a receiver whose team turned wakes off, and says so', async () => {
    const kit = await treeHarness(LED);
    await kit.files.write(teamConfigOf('web'), formatConfig({ ...SUB_TEAMS['web'], wake: { enabled: false } }));
    const result = await kit.run(['inbox', 'add', '--to', 'web/front,ops/run', '--text', 'deploy at 18:00', '--wake', 'now', '--session', 'lead']);
    assert.deepEqual(result.stdout, [
      'POSTED to 2 sessions (web/front, ops/run); each is reminded at its next prompt',
      "WAKES ops/run if its tab is idle, within about 3 minutes: at least about 210k W for the first call, cold; whole turns usually cost more, on ops's budget line; wake.enabled is false on the team of web/front, so its line wakes no one",
    ]);
    assert.equal(kit.files.get(teamInboxOf('web', 'front')), '- 2030-01-08 10:00 app/lead: deploy at 18:00\n');
    assert.equal(askOf(kit, 'web', 'front'), undefined);
  });

  it("says when the wake comes from the receiver's team's wake.batchSeconds", async () => {
    const kit = await treeHarness(LED);
    await kit.files.write(teamConfigOf('web'), formatConfig({ ...SUB_TEAMS['web'], wake: { batchSeconds: 600 } }));
    const result = await kit.run(['inbox', 'add', '--to', 'web/front', '--text', 'deploy at 18:00', '--wake', 'now', '--session', 'lead']);
    assert.equal(result.stdout[1], "WAKES web/front if its tab is idle, within about 11 minutes: at least about 210k W for the first call, cold; whole turns usually cost more, on web's budget line");
  });

  it('takes only now, refusing any other value before posting', async () => {
    const kit = new CliHarness();
    const result = await kit.run(['inbox', 'add', '--to', 'bravo', '--text', 'hi', '--wake', 'later', '--session', 'alpha']);
    assert.equal(result.code, EXIT.usage);
    assert.match(result.stderr.join('\n'), /--wake takes now, to wake each receiver as soon as its tab's wake check may, not "later"/);
    assert.equal(kit.files.get(teamInboxOf('app', 'bravo')), undefined);
  });
});

describe('teamrig inbox add --wake-by', () => {
  const DUE = Date.parse('2030-01-08T16:30:00Z');

  it("posts the line and a timed ask beside it, carrying the time and the line's hash, and says when it wakes", async () => {
    const kit = await treeHarness(LED);
    const result = await kit.run(['inbox', 'add', '--to', 'bravo', '--text', ' the api is ready ', '--wake-by', '16:30', '--session', 'alpha']);
    assert.deepEqual(result.stdout, [
      'POSTED to bravo; bravo is reminded at its next prompt',
      "WAKES bravo at 16:30 UTC if it has not seen the line by then and its tab is idle: at least about 210k W for the first call, cold; whole turns usually cost more, on app's budget line",
    ]);
    const line = '- 2030-01-08 10:00 alpha: the api is ready';
    assert.equal(kit.files.get(teamInboxOf('app', 'bravo')), `${line}\n`);
    assert.equal(askOf(kit, 'app', 'bravo'), formatWakeAsk({ from: 'alpha', text: 'the api is ready', at: NOW, by: { at: DUE, line: lineHash(line) } }));
  });

  it("dates a time that is not today on the team's clock, and hashes the line another team's receiver gets", async () => {
    const kit = await treeHarness(LED);
    const result = await kit.run(['inbox', 'add', '--to', 'web/front', '--text', 'new icons', '--wake-by', '2030-01-09T07:00:00Z', '--session', 'lead']);
    assert.equal(result.stdout[1], "WAKES web/front at 01-09 07:00 UTC if it has not seen the line by then and its tab is idle: at least about 210k W for the first call, cold; whole turns usually cost more, on web's budget line");
    const by = { at: Date.parse('2030-01-09T07:00:00Z'), line: lineHash('- 2030-01-08 10:00 app/lead: new icons') };
    assert.equal(askOf(kit, 'web', 'front'), formatWakeAsk({ from: 'app/lead', text: 'new icons', at: NOW, by }));
  });

  it('costs the wake at its time: a tab warm now is cold by then', async () => {
    const kit = await treeHarness(LED);
    await kit.run(['inbox', 'read', '--session', 'bravo'], { env: { CLAUDE_CODE_SESSION_ID: BRAVO_TAB } });
    const transcripts = new MemoryTranscripts();
    transcripts.set(transcriptOf(BRAVO_TAB), '{}\n', NOW - 5 * MINUTE);
    const soon = await kit.run(['inbox', 'add', '--to', 'bravo', '--text', 'hi', '--wake-by', '10:30', '--session', 'alpha'], { transcripts });
    const later = await kit.run(['inbox', 'add', '--to', 'bravo', '--text', 'hi again', '--wake-by', '16:30', '--session', 'alpha'], { transcripts });
    assert.match(soon.stdout[1] ?? '', /at 10:30 UTC .*: at least about 27k W for the first call, warm cache; whole turns usually cost more,/);
    assert.match(later.stdout[1] ?? '', /at 16:30 UTC .*: at least about 210k W for the first call, cold; whole turns usually cost more,/);
  });

  it('refuses it beside --wake now, a time already past and one it cannot read, before posting', async () => {
    const kit = await treeHarness(LED);
    const add = (...wake: string[]) => kit.run(['inbox', 'add', '--to', 'bravo', '--text', 'hi', ...wake, '--session', 'alpha']);
    const both = await add('--wake', 'now', '--wake-by', '16:30');
    assert.equal(both.code, EXIT.usage);
    assert.match(both.stderr.join('\n'), /--wake now and --wake-by are one or the other: --wake now wakes each receiver at once, --wake-by at a time/);
    const past = await add('--wake-by', '09:00');
    assert.equal(past.code, EXIT.usage);
    assert.match(past.stderr.join('\n'), /--wake-by "09:00" is past \(01-08 09:00 UTC\); --wake now wakes each receiver at once/);
    const unread = await add('--wake-by', 'soon');
    assert.equal(unread.code, EXIT.usage);
    assert.match(unread.stderr.join('\n'), /--wake-by "soon" is not a time/);
    assert.equal(kit.files.get(teamInboxOf('app', 'bravo')), undefined, 'no line posted');
    assert.equal(askOf(kit, 'app', 'bravo'), undefined, 'no ask posted');
  });

  it('holds the --wake now gate, naming --wake-by', async () => {
    const kit = await treeHarness(LED);
    const member = await kit.run(['inbox', 'add', '--to', 'all', '--text', 'main is frozen', '--wake-by', '16:30', '--session', 'alpha']);
    assert.deepEqual(
      [member.code, member.stdout],
      [EXIT.refused, ["REFUSED --wake-by on a group is a leader's: alpha leads no one on app; post the line without --wake-by, and each receiver reads it at its next prompt"]],
    );
  });
});
