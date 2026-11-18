import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { TEST_CARD, TEST_OWNER_CARD_FLAGS } from '../testing/card.ts';
import { APP, CliHarness, EVENTS_PATH, TEAM, TEAM_HOME, type CliResult } from '../testing/cli-harness.ts';
import { FakePathProbe } from '../testing/fake-processes.ts';
import { teamEventsOf, teamHomeOf, treeHarness } from '../testing/team-tree.ts';
import { EXIT } from './runtime.ts';

const LEAD_TAB = '0123abcd-0000-4000-8000-0000000000c1';
const ALPHA_TAB = '0123abcd-0000-4000-8000-0000000000a1';
const MEETING_PATH = join(TEAM_HOME, 'state', 'meeting.json');
const MEETINGS_PATH = join(TEAM_HOME, 'state', 'meetings.jsonl');
const WEB_MEETING_PATH = join(teamHomeOf('web'), 'state', 'meeting.json');
const WEB_MEETINGS_PATH = join(teamHomeOf('web'), 'state', 'meetings.jsonl');
const AS_WEB_LEAD = { env: { TEAMRIG_TEAM: 'web', TEAMRIG_SESSION: 'lead' } };
const STARTED = '2030-01-08T10:00:00.000Z';
const AS_WEB = { env: { TEAMRIG_TEAM: 'web' } };
/** `meeting start M<n>` opens the met session's tab when none runs, in the project folder, which must exist. */
const OPENS = { probe: new FakePathProbe({ folders: [APP] }) };

function ok(result: CliResult): void {
  assert.equal(result.code, EXIT.ok, `${result.stdout.join('\n')}\n${result.stderr.join('\n')}`);
}

/** Binds each tab to its session: a session that read its inbox from a tab is that tab's. */
async function bindTabs(kit: CliHarness): Promise<void> {
  ok(await kit.run(['inbox', 'read', '--session', 'lead'], { env: { CLAUDE_CODE_SESSION_ID: LEAD_TAB } }));
  ok(await kit.run(['inbox', 'read', '--session', 'alpha'], { env: { CLAUDE_CODE_SESSION_ID: ALPHA_TAB } }));
}

/** alpha's T1 and bravo's T2 wait on the owner's decision, each with its card. */
async function twoCards(config = TEAM): Promise<CliHarness> {
  const kit = new CliHarness(config);
  await bindTabs(kit);
  ok(await kit.run(['add', '--title', 'Pick the pricing tier', '--description', 'which tier ships first', '--priority', 'p1', '--session', 'alpha']));
  ok(await kit.run(['set', 'T1', '--status', 'waiting', '--waits', 'decision:owner', '--note', 'two options', ...TEST_OWNER_CARD_FLAGS, '--session', 'alpha']));
  ok(await kit.run(['add', '--title', 'Pick the launch day', '--description', 'which day ships', '--priority', 'p2', '--session', 'bravo']));
  ok(await kit.run(['set', 'T2', '--status', 'waiting', '--waits', 'decision:owner', '--note', 'two days', ...TEST_OWNER_CARD_FLAGS, '--session', 'bravo']));
  return kit;
}

function panel(kit: CliHarness, tab = LEAD_TAB): Promise<CliResult> {
  return kit.run(['hook', 'meeting-panel'], { stdin: JSON.stringify({ session_id: tab, cwd: APP }) });
}

function answerOf(result: CliResult): unknown {
  ok(result);
  assert.equal(result.stdout.length, 1);
  return JSON.parse(result.stdout[0] ?? '');
}

/** Each card's summary: the test card's question. */
const SUMMARY = TEST_CARD.question;
const T1 = { id: 'T1', title: 'Pick the pricing tier', summary: SUMMARY, settled: false, decision: null };
const T2 = { id: 'T2', title: 'Pick the launch day', summary: SUMMARY, settled: false, decision: null };

describe('runCli: hook meeting-panel', () => {
  it("shows nothing in the lead's tab before the meeting starts, and watches the meeting files", async () => {
    const kit = await twoCards();
    assert.deepEqual(answerOf(await panel(kit)), { kind: 'off', why: 'no meeting is open', watch: [MEETING_PATH, MEETINGS_PATH] });
  });

  it("lists the owner's cards in the agenda's order while the meeting is open, the first on the table", async () => {
    const kit = await twoCards();
    ok(await kit.run(['meeting', 'start', '--session', 'lead']));
    assert.deepEqual(answerOf(await panel(kit)), {
      kind: 'open',
      startedAt: STARTED,
      items: [T1, T2],
      current: 'T1',
      left: 2,
      watch: [MEETING_PATH, MEETINGS_PATH, EVENTS_PATH],
    });
  });

  it('checks a decided card off with its decision, and puts the next one on the table', async () => {
    const kit = await twoCards();
    ok(await kit.run(['meeting', 'start', '--session', 'lead']));
    kit.clock.advance(60_000);
    ok(await kit.run(['update', 'T1', '--decided', '--note', 'owner decided: the middle tier', '--session', 'lead']));
    assert.deepEqual(answerOf(await panel(kit)), {
      kind: 'open',
      startedAt: STARTED,
      items: [{ ...T1, settled: true, decision: 'the middle tier' }, T2],
      current: 'T2',
      left: 1,
      watch: [MEETING_PATH, MEETINGS_PATH, EVENTS_PATH],
    });
  });

  it('shows nothing once the meeting ended', async () => {
    const kit = await twoCards();
    ok(await kit.run(['meeting', 'start', '--session', 'lead']));
    ok(await kit.run(['meeting', 'end', '--session', 'lead']));
    assert.deepEqual(answerOf(await panel(kit)), { kind: 'off', why: 'no meeting is open', watch: [MEETING_PATH, MEETINGS_PATH] });
  });

  it("shows nothing in another session's tab while the lead's meeting is open, and watches the booked meetings", async () => {
    const kit = await twoCards();
    ok(await kit.run(['meeting', 'start', '--session', 'lead']));
    assert.deepEqual(answerOf(await panel(kit, ALPHA_TAB)), { kind: 'off', why: 'no meeting of yours is started', watch: [MEETINGS_PATH] });
  });

  it('shows nothing in a tab that is no team session', async () => {
    const kit = await twoCards();
    ok(await kit.run(['meeting', 'start', '--session', 'lead']));
    const other = '0123abcd-0000-4000-8000-0000000000b9';
    assert.deepEqual(answerOf(await panel(kit, other)), { kind: 'off', why: 'this tab is not a team session', watch: [] });
  });

  it('shows nothing with meeting.panel.enabled off', async () => {
    const kit = await twoCards({ ...TEAM, meeting: { panel: { enabled: false } } });
    ok(await kit.run(['meeting', 'start', '--session', 'lead']));
    assert.deepEqual(answerOf(await panel(kit)), { kind: 'off', why: 'meeting.panel.enabled is false', watch: [] });
  });

  it('names a card of a team under the lead\'s by <team>/<id>, checked off once the lead records its decision', async () => {
    const kit = await treeHarness();
    await bindTabs(kit);
    ok(await kit.run(['add', '--title', 'Pick the login provider', '--description', 'which provider ships', '--priority', 'p1', '--session', 'front'], AS_WEB));
    ok(await kit.run(['set', 'T1', '--status', 'waiting', '--waits', 'decision:owner', '--note', 'two providers', ...TEST_OWNER_CARD_FLAGS, '--session', 'front'], AS_WEB));
    ok(await kit.run(['meeting', 'start', '--session', 'lead']));
    const watch = [MEETING_PATH, MEETINGS_PATH, EVENTS_PATH, teamEventsOf('ops'), teamEventsOf('web'), teamEventsOf('ui')];
    const card = { id: 'web/T1', title: 'Pick the login provider', summary: SUMMARY, settled: false, decision: null };
    assert.deepEqual(answerOf(await panel(kit)), { kind: 'open', startedAt: STARTED, items: [card], current: 'web/T1', left: 1, watch });
    kit.clock.advance(60_000);
    ok(await kit.run(['update', 'web/T1', '--decided', '--note', 'owner decided: the first one', '--session', 'lead']));
    const settled = { ...card, settled: true, decision: 'the first one' };
    assert.deepEqual(answerOf(await panel(kit)), { kind: 'open', startedAt: STARTED, items: [settled], current: null, left: 0, watch });
  });

  it("shows a sub-team's lead the panel of its own meeting with the owner, over its subtree's cards (T2985)", async () => {
    const kit = await treeHarness();
    const asUi = { env: { TEAMRIG_TEAM: 'ui' } };
    ok(await kit.run(['add', '--title', 'Pick the icon set', '--description', 'which icons ship', '--priority', 'p1', '--session', 'pixel'], asUi));
    ok(await kit.run(['set', 'T1', '--status', 'waiting', '--waits', 'decision:owner', '--note', 'two sets', ...TEST_OWNER_CARD_FLAGS, '--session', 'pixel'], asUi));
    assert.deepEqual(answerOf(await webLeadPanel(kit)), { kind: 'off', why: 'no meeting is open', watch: [WEB_MEETING_PATH, WEB_MEETINGS_PATH] });

    ok(await kit.run(['meeting', 'start', '--session', 'lead'], AS_WEB));
    const card = { id: 'ui/T1', title: 'Pick the icon set', summary: SUMMARY, settled: false, decision: null };
    const watch = [WEB_MEETING_PATH, WEB_MEETINGS_PATH, teamEventsOf('web'), teamEventsOf('ui')];
    assert.deepEqual(answerOf(await webLeadPanel(kit)), { kind: 'open', startedAt: STARTED, items: [card], current: 'ui/T1', left: 1, watch });
  });
});

function webLeadPanel(kit: CliHarness): Promise<CliResult> {
  return kit.run(['hook', 'meeting-panel'], { stdin: JSON.stringify({ session_id: LEAD_TAB, cwd: APP }), ...AS_WEB_LEAD });
}

/**
 * Team web, under app: front's T1 waits on the owner, back's T2 needs T1 first, and front's T3 waits on the owner too
 * but no booked meeting links it; M1 meets web's lead on T2.
 */
async function webBooked(): Promise<CliHarness> {
  const kit = await treeHarness();
  ok(await kit.run(['add', '--title', 'Pick the login provider', '--description', 'which provider ships', '--priority', 'p1', '--session', 'front'], AS_WEB));
  ok(await kit.run(['set', 'T1', '--status', 'waiting', '--waits', 'decision:owner', '--note', 'two providers', ...TEST_OWNER_CARD_FLAGS, '--session', 'front'], AS_WEB));
  ok(await kit.run(['add', '--title', 'Ship the login page', '--description', 'the page itself', '--priority', 'p1', '--after', 'T1', '--session', 'back'], AS_WEB));
  ok(await kit.run(['add', '--title', 'Pick the font', '--description', 'which font ships', '--priority', 'p1', '--session', 'front'], AS_WEB));
  ok(await kit.run(['set', 'T3', '--status', 'waiting', '--waits', 'decision:owner', '--note', 'two fonts', ...TEST_OWNER_CARD_FLAGS, '--session', 'front'], AS_WEB));
  ok(await kit.run(['meeting', 'schedule', '--meets', 'lead', '--at', '2030-01-08 14:00', '--about', 'the login', '--tasks', 'T2', '--session', 'lead'], AS_WEB));
  return kit;
}

describe('runCli: hook meeting-panel, booked meetings (T2808)', () => {
  const card = { id: 'T1', title: 'Pick the login provider', summary: SUMMARY, settled: false, decision: null };
  const watch = [WEB_MEETINGS_PATH, teamEventsOf('web')];

  it("shows nothing in the session's tab while its booked meeting is only scheduled", async () => {
    const kit = await webBooked();
    const why = 'no meeting is open';
    assert.deepEqual(answerOf(await webLeadPanel(kit)), { kind: 'off', why, watch: [WEB_MEETING_PATH, WEB_MEETINGS_PATH] });
  });

  it("opens in a sub-team lead's tab once its booked meeting starts: the owner's cards of the meeting's tasks and those they need", async () => {
    const kit = await webBooked();
    ok(await kit.run(['meeting', 'start', 'M1', '--session', 'lead'], { ...AS_WEB, ...OPENS }));
    assert.deepEqual(answerOf(await webLeadPanel(kit)), { kind: 'open', startedAt: STARTED, items: [card], current: 'T1', left: 1, watch });
  });

  it('checks a card off once the session met records the decision, and shows nothing once the meeting ends', async () => {
    const kit = await webBooked();
    ok(await kit.run(['meeting', 'start', 'M1', '--session', 'lead'], { ...AS_WEB, ...OPENS }));
    kit.clock.advance(60_000);
    ok(await kit.run(['update', 'T1', '--decided', '--note', 'owner decided: the first one', '--session', 'lead'], AS_WEB));
    const settled = { ...card, settled: true, decision: 'the first one' };
    assert.deepEqual(answerOf(await webLeadPanel(kit)), { kind: 'open', startedAt: STARTED, items: [settled], current: null, left: 0, watch });
    ok(await kit.run(['meeting', 'end', 'M1', '--session', 'lead'], AS_WEB));
    const why = 'no meeting is open';
    assert.deepEqual(answerOf(await webLeadPanel(kit)), { kind: 'off', why, watch: [WEB_MEETING_PATH, WEB_MEETINGS_PATH] });
  });

  it("opens in a team member's tab, not the lead's, when the booked meeting meets the member", async () => {
    const kit = await twoCards();
    ok(await kit.run(['meeting', 'schedule', '--meets', 'alpha', '--at', '2030-01-08 14:00', '--about', 'pricing', '--tasks', 'T1', '--session', 'lead']));
    ok(await kit.run(['meeting', 'start', 'M1', '--session', 'lead'], OPENS));
    assert.deepEqual(answerOf(await panel(kit, ALPHA_TAB)), { kind: 'open', startedAt: STARTED, items: [T1], current: 'T1', left: 1, watch: [MEETINGS_PATH, EVENTS_PATH] });
    assert.deepEqual(answerOf(await panel(kit)), { kind: 'off', why: 'no meeting is open', watch: [MEETING_PATH, MEETINGS_PATH] });
  });
});
