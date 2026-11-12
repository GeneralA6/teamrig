import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { TEST_OWNER_CARD_FLAGS } from '../testing/card.ts';
import { APP, CliHarness, EVENTS_PATH, TEAM, TEAM_HOME, type CliResult } from '../testing/cli-harness.ts';
import { teamEventsOf, treeHarness } from '../testing/team-tree.ts';
import { EXIT } from './runtime.ts';

const LEAD_TAB = '0123abcd-0000-4000-8000-0000000000c1';
const ALPHA_TAB = '0123abcd-0000-4000-8000-0000000000a1';
const MEETING_PATH = join(TEAM_HOME, 'state', 'meeting.json');
const STARTED = '2030-01-08T10:00:00.000Z';
const AS_WEB = { env: { TEAMRIG_TEAM: 'web' } };

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

const T1 = { id: 'T1', title: 'Pick the pricing tier', settled: false, decision: null };
const T2 = { id: 'T2', title: 'Pick the launch day', settled: false, decision: null };

describe('runCli: hook meeting-panel', () => {
  it("shows nothing in the lead's tab before the meeting starts, and watches the meeting file", async () => {
    const kit = await twoCards();
    assert.deepEqual(answerOf(await panel(kit)), { kind: 'off', why: 'no meeting is open', watch: [MEETING_PATH] });
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
      watch: [MEETING_PATH, EVENTS_PATH],
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
      watch: [MEETING_PATH, EVENTS_PATH],
    });
  });

  it('shows nothing once the meeting ended', async () => {
    const kit = await twoCards();
    ok(await kit.run(['meeting', 'start', '--session', 'lead']));
    ok(await kit.run(['meeting', 'end', '--session', 'lead']));
    assert.deepEqual(answerOf(await panel(kit)), { kind: 'off', why: 'no meeting is open', watch: [MEETING_PATH] });
  });

  it("shows nothing in another session's tab, even while the lead's meeting is open", async () => {
    const kit = await twoCards();
    ok(await kit.run(['meeting', 'start', '--session', 'lead']));
    assert.deepEqual(answerOf(await panel(kit, ALPHA_TAB)), { kind: 'off', why: 'only the lead meets the owner', watch: [] });
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
    const watch = [MEETING_PATH, EVENTS_PATH, teamEventsOf('ops'), teamEventsOf('web'), teamEventsOf('ui')];
    const card = { id: 'web/T1', title: 'Pick the login provider', settled: false, decision: null };
    assert.deepEqual(answerOf(await panel(kit)), { kind: 'open', startedAt: STARTED, items: [card], current: 'web/T1', left: 1, watch });
    kit.clock.advance(60_000);
    ok(await kit.run(['update', 'web/T1', '--decided', '--note', 'owner decided: the first one', '--session', 'lead']));
    const settled = { ...card, settled: true, decision: 'the first one' };
    assert.deepEqual(answerOf(await panel(kit)), { kind: 'open', startedAt: STARTED, items: [settled], current: null, left: 0, watch });
  });

  it("shows nothing in the tab of a sub-team's lead: its waits on the owner are on the root lead's panel", async () => {
    const kit = await treeHarness();
    const webLead = await kit.run(['hook', 'meeting-panel'], { stdin: JSON.stringify({ session_id: LEAD_TAB, cwd: APP }), env: { TEAMRIG_TEAM: 'web', TEAMRIG_SESSION: 'lead' } });
    assert.deepEqual(answerOf(webLead), { kind: 'off', why: 'a team under another meets no owner', watch: [] });
  });
});
