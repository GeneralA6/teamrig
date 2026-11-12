import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { MS_PER_MINUTE } from '../core/time.ts';
import { readMeetings, type ScheduledMeeting } from '../meeting/schedule.ts';
import { APP, CliHarness, TEAM, TEAM_HOME, type CliResult } from '../testing/cli-harness.ts';
import { holdFileLock } from '../testing/held-file-lock.ts';
import { FakeProcesses } from '../testing/fake-processes.ts';
import { EXIT } from './runtime.ts';

const ALPHA_TAB = '0123abcd-0000-4000-8000-0000000000a1';
const OTHER_TAB = '0123abcd-0000-4000-8000-0000000000b9';
const MEETINGS_PATH = join(TEAM_HOME, 'state', 'meetings.jsonl');
const MEETINGS_LOCK = join(TEAM_HOME, 'state', 'meetings.lock');
const AT = Date.parse('2030-01-08T14:00:00Z');
const HOUR = 60 * MS_PER_MINUTE;
const NOTICE = {
  id: 'M1',
  stage: 'start',
  title: 'teamrig meeting M1 now',
  text: 'alpha: the release plan (30 min). Start: teamrig meeting start M1',
  stayMs: null,
};

/** A team whose `alpha` read its inbox from ALPHA_TAB, so that tab is alpha, with M1 booked at 14:00 UTC. */
async function booked(): Promise<CliHarness> {
  const kit = new CliHarness(TEAM);
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

async function stored(kit: CliHarness): Promise<ScheduledMeeting | undefined> {
  return readMeetings((await kit.files.read(MEETINGS_PATH)) ?? '').meetings.find((meeting) => meeting.id === 'M1');
}

describe('runCli: hook meeting-due', () => {
  it('fires nothing before its time, and names the file to watch and when to ask again', async () => {
    const kit = await booked();
    const processes = new FakeProcesses();
    assert.deepEqual(answerOf(await due(kit, processes)), { kind: 'due', notices: [], watch: [MEETINGS_PATH], recheckAt: AT });
    assert.equal(processes.hidden.length, 0);
  });

  it('at its time marks it notified and starts its OS notification, once for every tab of the team', async () => {
    const kit = await booked();
    kit.clock.advance(4 * HOUR + MS_PER_MINUTE);
    const processes = new FakeProcesses();
    assert.deepEqual(answerOf(await due(kit, processes)), { kind: 'due', notices: [NOTICE], watch: [MEETINGS_PATH], recheckAt: null });
    assert.equal(processes.hidden.length, 1);
    assert.equal(processes.hidden[0]?.command, 'powershell.exe');
    assert.equal(processes.hidden[0]?.env['TEAMRIG_NOTICE_TEXT'], NOTICE.text);
    const meeting = await stored(kit);
    assert.equal(meeting?.notifiedAt, AT + MS_PER_MINUTE);
    assert.equal(meeting?.status, 'scheduled', 'a notification starts nothing: the owner does');
    kit.clock.advance(MS_PER_MINUTE);
    assert.deepEqual(answerOf(await due(kit, processes)), { kind: 'due', notices: [], watch: [MEETINGS_PATH], recheckAt: null });
    assert.equal(processes.hidden.length, 1, 'the next tab fires nothing');
  });

  it('fires nothing for a meeting past its slot: it is missed', async () => {
    const kit = await booked();
    kit.clock.advance(4 * HOUR + 30 * MS_PER_MINUTE);
    const processes = new FakeProcesses();
    assert.deepEqual(answerOf(await due(kit, processes)), { kind: 'due', notices: [], watch: [MEETINGS_PATH], recheckAt: null });
    assert.equal(processes.hidden.length, 0);
    assert.equal((await stored(kit))?.notifiedAt, null);
  });

  it('fires a moved meeting again at its new time', async () => {
    const kit = await booked();
    kit.clock.advance(4 * HOUR);
    const processes = new FakeProcesses();
    answerOf(await due(kit, processes));
    const moved = await kit.run(['meeting', 'move', 'M1', '--at', '2030-01-08 16:00', '--session', 'lead']);
    assert.equal(moved.code, EXIT.ok, moved.stdout.join('\n'));
    assert.deepEqual(answerOf(await due(kit, processes)), { kind: 'due', notices: [], watch: [MEETINGS_PATH], recheckAt: AT + 2 * HOUR });
    kit.clock.advance(2 * HOUR);
    assert.deepEqual(answerOf(await due(kit, processes)), { kind: 'due', notices: [NOTICE], watch: [MEETINGS_PATH], recheckAt: null });
    assert.equal(processes.hidden.length, 2);
  });

  it('asks again at once while another tab holds the meetings lock', async () => {
    const kit = await booked();
    kit.clock.advance(4 * HOUR);
    const held = kit.clock.now();
    await holdFileLock(kit, MEETINGS_LOCK, held);
    const processes = new FakeProcesses();
    assert.deepEqual(answerOf(await due(kit, processes)), { kind: 'due', notices: [], watch: [MEETINGS_PATH], recheckAt: held });
    assert.equal(processes.hidden.length, 0);
    assert.equal((await stored(kit))?.notifiedAt, null);
  });

  it('does nothing in a tab that is no team session', async () => {
    const kit = await booked();
    kit.clock.advance(4 * HOUR);
    const processes = new FakeProcesses();
    assert.deepEqual(answerOf(await due(kit, processes, OTHER_TAB)), { kind: 'off', why: 'this tab is not a team session' });
    assert.equal(processes.hidden.length, 0);
  });
});
