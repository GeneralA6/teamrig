import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { MS_PER_MINUTE } from '../core/time.ts';
import { MISSED_STAY_MS } from '../meeting/notify.ts';
import { readMeetings, type ScheduledMeeting } from '../meeting/schedule.ts';
import { APP, CliHarness, TEAM, TEAM_HOME, type CliResult } from '../testing/cli-harness.ts';
import { holdFileLock } from '../testing/held-file-lock.ts';
import { FakeProcesses } from '../testing/fake-processes.ts';
import type { JsonRecord } from '../core/guards.ts';
import { EXIT } from './runtime.ts';

const ALPHA_TAB = '0123abcd-0000-4000-8000-0000000000a1';
const OTHER_TAB = '0123abcd-0000-4000-8000-0000000000b9';
const MEETINGS_PATH = join(TEAM_HOME, 'state', 'meetings.jsonl');
const MEETINGS_LOCK = join(TEAM_HOME, 'state', 'meetings.lock');
const LEAD_INBOX = join(TEAM_HOME, 'state', 'inbox', 'lead.md');
const AT = Date.parse('2030-01-08T14:00:00Z');
const HOUR = 60 * MS_PER_MINUTE;
/** From the harness clock's 10:00 UTC to M1's slot at 14:00 UTC. */
const TO_SLOT = 4 * HOUR;
const LINE = 'alpha: the release plan (30 min)';
const START = 'teamrig meeting start M1';
const NOTICE = { id: 'M1', stage: 'start', title: 'teamrig meeting M1 now', text: `${LINE}. Start: ${START}`, stayMs: null };
const BEFORE = { id: 'M1', stage: 'before', title: 'teamrig meeting M1 in 10 min', text: `${LINE}. Start: ${START}`, stayMs: null };
const MISSED = {
  id: 'M1',
  stage: 'missed',
  title: 'teamrig meeting M1 missed',
  text: `${LINE} has not started. Start: ${START}, or move or drop it`,
  stayMs: MISSED_STAY_MS,
};

/** A team whose `alpha` read its inbox from ALPHA_TAB, so that tab is alpha, with M1 booked at 14:00 UTC. */
async function booked(meetingNotices: JsonRecord = {}): Promise<CliHarness> {
  const kit = new CliHarness({ ...TEAM, meetingNotices });
  await kit.run(['inbox', 'read', '--session', 'alpha'], { env: { CLAUDE_CODE_SESSION_ID: ALPHA_TAB } });
  const result = await kit.run(['meeting', 'schedule', '--meets', 'alpha', '--at', '2030-01-08 14:00', '--about', 'the release plan', '--session', 'lead']);
  assert.equal(result.code, EXIT.ok, result.stdout.join('\n'));
  return kit;
}

function due(kit: CliHarness, processes: FakeProcesses, tab = ALPHA_TAB): Promise<CliResult> {
  return kit.run(['hook', 'meeting-due'], { stdin: JSON.stringify({ session_id: tab, cwd: APP }), processes, platform: 'win32' });
}

function answerOf(result: CliResult): unknown {
  assert.equal(result.code, EXIT.ok, result.stderr.join('\n'));
  assert.equal(result.stdout.length, 1);
  return JSON.parse(result.stdout[0] ?? '');
}

function fired(notices: readonly unknown[], recheckAt: number | null): unknown {
  return { kind: 'due', notices, watch: [MEETINGS_PATH], recheckAt };
}

async function stored(kit: CliHarness): Promise<ScheduledMeeting | undefined> {
  return readMeetings((await kit.files.read(MEETINGS_PATH)) ?? '').meetings.find((meeting) => meeting.id === 'M1');
}

describe('runCli: hook meeting-due', () => {
  it('fires nothing before its first notice, and names the file to watch and when to ask again', async () => {
    const kit = await booked();
    const processes = new FakeProcesses();
    assert.deepEqual(answerOf(await due(kit, processes)), fired([], AT - 10 * MS_PER_MINUTE));
    assert.equal(processes.hidden.length, 0);
  });

  it('tells of the meeting ten minutes before its slot, then asks again at the slot', async () => {
    const kit = await booked();
    kit.clock.advance(TO_SLOT - 10 * MS_PER_MINUTE);
    const processes = new FakeProcesses();
    assert.deepEqual(answerOf(await due(kit, processes)), fired([BEFORE], AT));
    assert.equal(processes.hidden[0]?.env['TEAMRIG_NOTICE_TITLE'], BEFORE.title);
    assert.equal((await stored(kit))?.notifiedAt, AT - 10 * MS_PER_MINUTE);
  });

  it('at its time marks it notified and starts its OS notification, once for every tab of the team', async () => {
    const kit = await booked();
    kit.clock.advance(TO_SLOT + MS_PER_MINUTE);
    const processes = new FakeProcesses();
    assert.deepEqual(answerOf(await due(kit, processes)), fired([NOTICE], AT + 5 * MS_PER_MINUTE));
    assert.equal(processes.hidden.length, 1);
    assert.equal(processes.hidden[0]?.command, 'powershell.exe');
    assert.equal(processes.hidden[0]?.env['TEAMRIG_NOTICE_TEXT'], NOTICE.text);
    const meeting = await stored(kit);
    assert.equal(meeting?.notifiedAt, AT + MS_PER_MINUTE);
    assert.equal(meeting?.status, 'scheduled', 'a notification starts nothing: the owner does');
    kit.clock.advance(MS_PER_MINUTE);
    assert.deepEqual(answerOf(await due(kit, processes)), fired([], AT + 5 * MS_PER_MINUTE));
    assert.equal(processes.hidden.length, 1, 'the next tab fires nothing');
  });

  it('raises a missed alert once past its grace with no start, and posts the lead an inbox line', async () => {
    const kit = await booked();
    kit.clock.advance(TO_SLOT + 30 * MS_PER_MINUTE);
    const processes = new FakeProcesses();
    assert.deepEqual(answerOf(await due(kit, processes)), fired([MISSED], null), 'only the latest stage: a late tab skips the ones it slept through');
    assert.equal(processes.hidden.length, 1);
    assert.equal((await stored(kit))?.notifiedAt, AT + 30 * MS_PER_MINUTE);
    const inbox = (await kit.files.read(LEAD_INBOX)) ?? '';
    assert.ok(inbox.includes(`alpha: ${MISSED.title}: ${MISSED.text}`), inbox);
    kit.clock.advance(MS_PER_MINUTE);
    assert.deepEqual(answerOf(await due(kit, processes)), fired([], null));
    assert.equal(processes.hidden.length, 1, 'the alert goes out once');
  });

  it('raises no missed alert for a meeting left scheduled from an earlier day', async () => {
    const kit = await booked();
    kit.clock.advance(TO_SLOT + 13 * HOUR);
    const processes = new FakeProcesses();
    assert.deepEqual(answerOf(await due(kit, processes)), fired([], null));
    assert.equal(await kit.files.read(LEAD_INBOX), undefined);
  });

  it('fires a moved meeting again at its new time', async () => {
    const kit = await booked();
    kit.clock.advance(TO_SLOT);
    const processes = new FakeProcesses();
    answerOf(await due(kit, processes));
    const moved = await kit.run(['meeting', 'move', 'M1', '--at', '2030-01-08 16:00', '--session', 'lead']);
    assert.equal(moved.code, EXIT.ok, moved.stdout.join('\n'));
    assert.deepEqual(answerOf(await due(kit, processes)), fired([], AT + 2 * HOUR - 10 * MS_PER_MINUTE));
    kit.clock.advance(2 * HOUR);
    assert.deepEqual(answerOf(await due(kit, processes)), fired([NOTICE], AT + 2 * HOUR + 5 * MS_PER_MINUTE));
    assert.equal(processes.hidden.length, 2);
  });

  it('sends nothing when the team turned meeting notices off', async () => {
    const kit = await booked({ enabled: false });
    kit.clock.advance(TO_SLOT);
    const processes = new FakeProcesses();
    assert.deepEqual(answerOf(await due(kit, processes)), fired([], null));
    assert.equal(processes.hidden.length, 0);
    assert.equal((await stored(kit))?.notifiedAt, null);
  });

  it('keeps the OS toast off when osToast is off, the tab still showing the notice', async () => {
    const kit = await booked({ osToast: false });
    kit.clock.advance(TO_SLOT);
    const processes = new FakeProcesses();
    assert.deepEqual(answerOf(await due(kit, processes)), fired([NOTICE], AT + 5 * MS_PER_MINUTE));
    assert.equal(processes.hidden.length, 0);
  });

  it('answers the tab no notice when tabToast is off, yet marks it sent and shows the OS toast', async () => {
    const kit = await booked({ tabToast: false });
    kit.clock.advance(TO_SLOT);
    const processes = new FakeProcesses();
    assert.deepEqual(answerOf(await due(kit, processes)), fired([], AT + 5 * MS_PER_MINUTE));
    assert.equal(processes.hidden.length, 1);
    assert.equal((await stored(kit))?.notifiedAt, AT);
  });

  it('posts the lead nothing of a missed meeting when leadInbox is off', async () => {
    const kit = await booked({ leadInbox: false });
    kit.clock.advance(TO_SLOT + 10 * MS_PER_MINUTE);
    const processes = new FakeProcesses();
    assert.deepEqual(answerOf(await due(kit, processes)), fired([MISSED], null));
    assert.equal(await kit.files.read(LEAD_INBOX), undefined);
  });

  it('asks again at once while another tab holds the meetings lock', async () => {
    const kit = await booked();
    kit.clock.advance(TO_SLOT);
    const held = kit.clock.now();
    await holdFileLock(kit, MEETINGS_LOCK, held);
    const processes = new FakeProcesses();
    assert.deepEqual(answerOf(await due(kit, processes)), fired([], held));
    assert.equal(processes.hidden.length, 0);
    assert.equal((await stored(kit))?.notifiedAt, null);
  });

  it('does nothing in a tab that is no team session', async () => {
    const kit = await booked();
    kit.clock.advance(TO_SLOT);
    const processes = new FakeProcesses();
    assert.deepEqual(answerOf(await due(kit, processes, OTHER_TAB)), { kind: 'off', why: 'this tab is not a team session' });
    assert.equal(processes.hidden.length, 0);
  });
});
