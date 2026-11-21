import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { MS_PER_MINUTE } from '../core/time.ts';
import { readMeetings, type ScheduledMeeting } from '../meeting/schedule.ts';
import { SPOTLIGHT_VARS } from '../meeting/spotlight.ts';
import { SpotlitStore, type SpotlitMeeting } from '../meeting/spotlit.ts';
import { FOCUS_EXIT, FOCUS_TITLE_VAR } from '../open/focus.ts';
import { decodePrompt, reopenPrompt } from '../open/prompt.ts';
import { PromptMarks, promptMarksDir } from '../restore/prompt-marks.ts';
import { SessionRecordStore } from '../sessions/record.ts';
import { APP, CLAUDE_SESSION, CliHarness, KIT, TEAM, TEAM_HOME, type CliResult, type RunOptions } from '../testing/cli-harness.ts';
import { FakeHostMemory } from '../testing/fake-host-memory.ts';
import { FakePathProbe, FakeProcesses } from '../testing/fake-processes.ts';
import { FakeSessionProcesses } from '../testing/fake-session-processes.ts';
import { WakeAsks } from '../wake/asks.ts';
import { openingPrompt } from './commands/meetings.ts';
import { EXIT } from './runtime.ts';

const MEETINGS_PATH = join(TEAM_HOME, 'state', 'meetings.jsonl');
const SPOTLIT_PATH = join(TEAM_HOME, 'state', 'meeting-spotlit.json');
const ASKS_PATH = join(TEAM_HOME, 'state', 'wake-asks');
const BOOK = ['meeting', 'schedule', '--meets', 'alpha', '--at', '2030-01-08 14:00', '--about', 'the release plan'];
const MB = 2 ** 20;
const CLAUDE_PID = 4242;

/** A team whose register holds T1, so a meeting can link it. */
async function team(config = TEAM): Promise<CliHarness> {
  const kit = new CliHarness(config);
  const added = await kit.run(['add', '--title', 'Plan the release', '--description', 'what ships first', '--priority', 'p1', '--session', 'alpha']);
  assert.equal(added.code, EXIT.ok, added.stderr.join('\n'));
  return kit;
}

async function booked(kit: CliHarness, ...more: string[]): Promise<void> {
  const result = await kit.run([...BOOK, ...more]);
  assert.equal(result.code, EXIT.ok, result.stderr.join('\n'));
}

/** What a run printed, on either stream: a refusal prints on stdout, a usage error on stderr. */
function said(result: CliResult): string {
  return [...result.stdout, ...result.stderr].join('\n');
}

async function inboxOf(kit: CliHarness, session: string): Promise<readonly string[]> {
  return (await kit.run(['inbox', 'read', '--session', session])).stdout;
}

async function stored(kit: CliHarness, id: string): Promise<ScheduledMeeting | undefined> {
  return readMeetings((await kit.files.read(MEETINGS_PATH)) ?? '').meetings.find((meeting) => meeting.id === id);
}

describe('runCli: meeting schedule', () => {
  it('books a meeting, prints its id and tells the session met and those joining, not the caller', async () => {
    const kit = await team();
    const result = await kit.run([...BOOK, '--minutes', '45', '--with', 'bravo', '--tasks', 'T1', '--brief', 'notes/alpha/brief.md', '--session', 'lead']);
    assert.equal(result.code, EXIT.ok, result.stderr.join('\n'));
    assert.deepEqual(result.stdout, ['SCHEDULED M1 scheduled, Tue 01-08 14:00 UTC, 45 min, alpha with bravo, tasks T1 | the release plan', 'TOLD alpha, bravo']);
    for (const session of ['alpha', 'bravo']) {
      const lines = await inboxOf(kit, session);
      assert.ok(lines.some((line) => line.endsWith("Meeting M1 with the owner booked: Tue 01-08 14:00 UTC (45 min) with alpha: the release plan; tasks T1; brief notes/alpha/brief.md. At its time the owner starts it in alpha's tab (teamrig meeting start M1)")), lines.join('\n'));
    }
    const meeting = await stored(kit, 'M1');
    assert.equal(meeting?.status, 'scheduled');
    assert.equal(meeting?.notifiedAt, null);
    assert.equal(meeting?.by, 'lead');
  });

  it('numbers each meeting after the last, and the session met may book its own', async () => {
    const kit = await team();
    await booked(kit, '--session', 'lead');
    const second = await kit.run(['meeting', 'schedule', '--meets', 'alpha', '--at', '2030-01-09 09:00', '--about', 'the pane', '--session', 'alpha']);
    assert.equal(second.code, EXIT.ok, second.stderr.join('\n'));
    assert.equal(second.stdout[0], 'SCHEDULED M2 scheduled, Wed 01-09 09:00 UTC, 30 min, alpha | the pane');
    assert.equal(second.stdout.length, 1, 'the caller is the only session it meets, so no line goes');
  });

  it('refuses a session that is neither the lead nor the session met', async () => {
    const kit = await team();
    const result = await kit.run([...BOOK, '--session', 'bravo']);
    assert.equal(result.code, EXIT.refused);
    assert.match(said(result), /only the lead \(app-lead\) or alpha, the session met, may book a meeting with alpha/);
    assert.equal(await kit.files.read(MEETINGS_PATH), undefined);
  });

  it('refuses a time past, a task not in the register, and bad lengths and lines', async () => {
    const kit = await team();
    const past = await kit.run(['meeting', 'schedule', '--meets', 'alpha', '--at', '2030-01-08 09:00', '--about', 'late', '--session', 'lead']);
    assert.equal(past.code, EXIT.refused);
    assert.match(said(past), /--at Tue 01-08 09:00 UTC is past: a meeting is booked ahead/);
    const task = await kit.run([...BOOK, '--tasks', 'T9', '--session', 'lead']);
    assert.equal(task.code, EXIT.refused);
    assert.match(said(task), /T9 is not a task of the team/);
    const long = await kit.run(['meeting', 'schedule', '--meets', 'alpha', '--at', '2030-01-08 14:00', '--about', 'x'.repeat(201), '--session', 'lead']);
    assert.equal(long.code, EXIT.usage);
    assert.match(said(long), /--about holds 201 characters: at most 200/);
    for (const about of ['plan \u001b[2J', 'plan ‮evil']) {
      const marked = await kit.run(['meeting', 'schedule', '--meets', 'alpha', '--at', '2030-01-08 14:00', '--about', about, '--session', 'lead']);
      assert.equal(marked.code, EXIT.usage, about);
      assert.match(said(marked), /--about holds a control character or bidi mark: type it as plain text/);
    }
    for (const minutes of ['0', '481', '1.5']) {
      const result = await kit.run([...BOOK, '--minutes', minutes, '--session', 'lead']);
      assert.equal(result.code, EXIT.usage, minutes);
    }
    assert.equal(await kit.files.read(MEETINGS_PATH), undefined);
  });
});

describe('runCli: meeting list', () => {
  it('lists the open meetings by time, a scheduled one past its slot as missed, and the finished ones with --all', async () => {
    const kit = await team();
    await booked(kit, '--session', 'lead');
    await kit.run(['meeting', 'schedule', '--meets', 'bravo', '--at', '2030-01-08 11:00', '--about', 'the docs', '--minutes', '20', '--session', 'lead']);
    await kit.run(['meeting', 'schedule', '--meets', 'bravo', '--at', '2030-01-09 11:00', '--about', 'the old plan', '--session', 'lead']);
    await kit.run(['meeting', 'drop', 'M3', '--note', 'settled by mail', '--session', 'lead']);
    kit.clock.advance(90 * MS_PER_MINUTE);

    const open = await kit.run(['meeting', 'list', '--session', 'alpha']);
    assert.equal(open.code, EXIT.ok, open.stderr.join('\n'));
    assert.deepEqual(open.stdout, [
      'MEETINGS 2 scheduled or started',
      '  M2 missed, Tue 01-08 11:00 UTC, 20 min, bravo | the docs',
      '  M1 scheduled, Tue 01-08 14:00 UTC, 30 min, alpha | the release plan',
    ]);
    const all = await kit.run(['meeting', 'list', '--all', '--session', 'alpha']);
    assert.equal(all.stdout[0], 'MEETINGS 3 of the last week and ahead');
    assert.ok(all.stdout.includes('  M3 dropped, Wed 01-09 11:00 UTC, 30 min, bravo | the old plan'), all.stdout.join('\n'));
    assert.ok(all.stdout.includes('    note: settled by mail'), all.stdout.join('\n'));
  });

  it('prints them as JSON for the task pane', async () => {
    const kit = await team();
    await booked(kit, '--with', 'bravo', '--tasks', 'T1', '--session', 'lead');
    const result = await kit.run(['meeting', 'list', '--json', '--session', 'alpha']);
    assert.equal(result.code, EXIT.ok, result.stderr.join('\n'));
    assert.deepEqual(JSON.parse(result.stdout.join('')), {
      meetings: [{ id: 'M1', at: '2030-01-08T14:00:00.000Z', atText: 'Tue 01-08 14:00 UTC', minutes: 30, session: 'alpha', with: ['bravo'], tasks: ['T1'], about: 'the release plan', brief: null, status: 'scheduled', missed: false }],
    });
  });
});

describe('runCli: meeting move, end and drop', () => {
  it('moves a scheduled meeting, so its notification fires again at the new time, and tells those it meets', async () => {
    const kit = await team();
    await booked(kit, '--with', 'bravo', '--session', 'lead');
    const meeting = await stored(kit, 'M1');
    assert.ok(meeting !== undefined);
    await kit.files.write(MEETINGS_PATH, (await kit.files.read(MEETINGS_PATH) ?? '').replace('"notifiedAt":null', `"notifiedAt":"${new Date(meeting.at).toISOString()}"`));
    assert.notEqual((await stored(kit, 'M1'))?.notifiedAt, null);

    const moved = await kit.run(['meeting', 'move', 'M1', '--at', '2030-01-08 16:00', '--note', 'the owner is out at two', '--session', 'alpha']);
    assert.equal(moved.code, EXIT.ok, moved.stderr.join('\n'));
    assert.deepEqual(moved.stdout, ['MOVED M1 scheduled, Tue 01-08 16:00 UTC, 30 min, alpha with bravo | the release plan', 'TOLD bravo']);
    const after = await stored(kit, 'M1');
    assert.equal(after?.notifiedAt, null);
    assert.equal(after?.note, 'the owner is out at two');
    assert.equal(after?.by, 'alpha');
    const lines = await inboxOf(kit, 'bravo');
    assert.ok(lines.some((line) => line.endsWith('Meeting M1 with the owner moved: Tue 01-08 16:00 UTC (30 min) with alpha: the release plan (the owner is out at two)')), lines.join('\n'));
  });

  it('ends a meeting with what came of it, tells those it met (T2775), and refuses to move or end it again', async () => {
    const kit = await team();
    await booked(kit, '--session', 'lead');
    const ended = await kit.run(['meeting', 'end', 'M1', '--note', 'ship on Friday', '--session', 'lead']);
    assert.equal(ended.code, EXIT.ok, ended.stderr.join('\n'));
    assert.deepEqual(ended.stdout, ['ENDED M1 done, Tue 01-08 14:00 UTC, 30 min, alpha | the release plan', 'TOLD alpha']);
    assert.equal((await stored(kit, 'M1'))?.note, 'ship on Friday');
    const lines = await inboxOf(kit, 'alpha');
    assert.ok(lines.some((line) => line.endsWith('Meeting M1 with the owner (Tue 01-08 14:00 UTC) ended: ship on Friday')), lines.join('\n'));

    const again = await kit.run(['meeting', 'end', 'M1', '--session', 'lead']);
    assert.equal(again.code, EXIT.refused);
    assert.match(said(again), /M1 is done: meeting end takes a scheduled or started meeting/);
    const move = await kit.run(['meeting', 'move', 'M1', '--at', '2030-01-09 10:00', '--session', 'lead']);
    assert.equal(move.code, EXIT.refused);
    assert.match(said(move), /M1 is done: meeting move takes a scheduled meeting/);
  });

  it('tells no one when the session met ends its own meeting with no one joining (T2775)', async () => {
    const kit = await team();
    await booked(kit, '--session', 'lead');
    const ended = await kit.run(['meeting', 'end', 'M1', '--session', 'alpha']);
    assert.equal(ended.code, EXIT.ok, ended.stderr.join('\n'));
    assert.deepEqual(ended.stdout, ['ENDED M1 done, Tue 01-08 14:00 UTC, 30 min, alpha | the release plan']);
  });

  it('drops a meeting only with a note, tells those it meets why, and refuses another session', async () => {
    const kit = await team();
    await booked(kit, '--session', 'lead');
    const bare = await kit.run(['meeting', 'drop', 'M1', '--session', 'lead']);
    assert.equal(bare.code, EXIT.usage);
    const other = await kit.run(['meeting', 'drop', 'M1', '--note', 'no need', '--session', 'bravo']);
    assert.equal(other.code, EXIT.refused);
    assert.match(said(other), /only the lead \(app-lead\) or alpha, the session met, may drop M1/);

    const dropped = await kit.run(['meeting', 'drop', 'M1', '--note', 'settled by mail', '--session', 'lead']);
    assert.equal(dropped.code, EXIT.ok, dropped.stderr.join('\n'));
    assert.deepEqual(dropped.stdout, ['DROPPED M1 dropped, Tue 01-08 14:00 UTC, 30 min, alpha | the release plan', 'TOLD alpha']);
    const lines = await inboxOf(kit, 'alpha');
    assert.ok(lines.some((line) => line.endsWith('Meeting M1 with the owner (Tue 01-08 14:00 UTC) is dropped: settled by mail')), lines.join('\n'));
  });

  it('refuses an id that is no meeting, and a daily meeting end with a note', async () => {
    const kit = await team();
    const unknown = await kit.run(['meeting', 'end', 'M4', '--session', 'lead']);
    assert.equal(unknown.code, EXIT.refused);
    assert.match(said(unknown), /M4 is not a meeting of the team: teamrig meeting list --all lists them/);
    const task = await kit.run(['meeting', 'move', 'T1', '--at', '2030-01-09 10:00', '--session', 'lead']);
    assert.equal(task.code, EXIT.usage);
    assert.match(said(task), /"T1" is not a meeting id like M3/);
    const daily = await kit.run(['meeting', 'end', '--note', 'done', '--session', 'lead']);
    assert.equal(daily.code, EXIT.usage);
    assert.match(said(daily), /--note goes with meeting end <id>, a booked or on-the-spot meeting/);
  });
});

/** Alpha's tab runs: its record names Claude Code CLAUDE_PID, which the host lists as started a minute before it. */
async function alphaRuns(kit: CliHarness): Promise<Pick<RunOptions, 'sessionProcesses' | 'memory'>> {
  await new SessionRecordStore(kit.files, { sessions: join(TEAM_HOME, 'state', 'sessions') }).write('alpha', { claudePid: CLAUDE_PID, claudeSession: 'c0', at: '2030-01-08T09:00:00.000Z' });
  return {
    sessionProcesses: new FakeSessionProcesses().add({ pid: CLAUDE_PID, parentPid: 1, name: 'claude.exe', commandLine: 'claude' }),
    memory: new FakeHostMemory().lists([{ pid: CLAUDE_PID, parent: 1, bytes: 400 * MB, startedMs: Date.parse('2030-01-08T08:59:00Z') }]),
  };
}

async function spotlitOf(kit: CliHarness): Promise<SpotlitMeeting | undefined> {
  return new SpotlitStore(kit.files, SPOTLIT_PATH).read();
}

async function asksOf(kit: CliHarness, session: string): Promise<readonly string[]> {
  return (await new WakeAsks(kit.files, ASKS_PATH).read(session)).flatMap((stored) => (stored.ask === undefined ? [] : [stored.ask.text]));
}

const OPENING = 'The owner starts meeting M1 now (30 min): the release plan. Tasks: T1. Joining: bravo. Brief: notes/alpha/brief.md. Read the brief, then meet the owner here. When it is over: teamrig meeting end M1 --note "<what came of it>".';

describe('runCli: meeting start <id>', () => {
  it("wakes the session met's running tab with the opening prompt, and tells those joining where it is held", async () => {
    const kit = await team();
    await booked(kit, '--with', 'bravo', '--tasks', 'T1', '--brief', 'notes/alpha/brief.md', '--session', 'lead');
    const result = await kit.run(['meeting', 'start', 'M1', '--session', 'lead'], await alphaRuns(kit));
    assert.equal(result.code, EXIT.ok, said(result));
    assert.deepEqual(result.stdout, [
      'STARTED M1 started, Tue 01-08 14:00 UTC, 30 min, alpha with bravo, tasks T1 | the release plan',
      'TOLD alpha',
      'TOLD bravo',
      "NOT FOCUSED app-alpha's tab, [app] alpha: gnome-terminal, konsole, x-terminal-emulator cannot select a tab by its title",
      'WAKES app-alpha with the meeting\'s opening prompt once its tab is idle, within about 15 s (a running turn ends first)',
    ]);
    assert.deepEqual(await asksOf(kit, 'alpha'), [OPENING]);
    const [timed] = await new WakeAsks(kit.files, ASKS_PATH).read('alpha');
    assert.equal(timed?.ask?.by?.at, Date.parse('2030-01-08T10:00:00.000Z'), 'a timed ask, due now, so the tab wakes at its next check');
    assert.equal((await stored(kit, 'M1'))?.status, 'started');
    assert.ok((await inboxOf(kit, 'alpha')).some((line) => line.endsWith(`lead: ${OPENING}`)));
    assert.ok((await inboxOf(kit, 'bravo')).some((line) => line.endsWith("lead: Meeting M1 with the owner started in alpha's tab: the release plan")));
  });

  it("brings the session met's running tab to the front in Windows Terminal, by its title", async () => {
    const kit = await team();
    await booked(kit, '--session', 'lead');
    const processes = new FakeProcesses().onRun('powershell.exe', { kind: 'exited', code: FOCUS_EXIT.behind });
    const behind = await kit.run(['meeting', 'start', 'M1', '--session', 'lead'], { ...(await alphaRuns(kit)), platform: 'win32', processes });
    assert.equal(behind.code, EXIT.ok, said(behind));
    assert.equal(behind.stdout[2], "SELECTED app-alpha's Windows Terminal tab, [app] alpha, in its window; Windows kept another app's window in front");
    assert.equal(processes.ran[0]?.env[FOCUS_TITLE_VAR], '[app] alpha');
    await booked(kit, '--session', 'lead');
    processes.onRun('powershell.exe', { kind: 'exited', code: 0 });
    const focused = await kit.run(['meeting', 'start', 'M2', '--session', 'lead'], { ...(await alphaRuns(kit)), platform: 'win32', processes });
    assert.deepEqual(focused.stdout.slice(2), [
      "FOCUSED app-alpha's Windows Terminal tab, [app] alpha",
      "WAKES app-alpha with the meeting's opening prompt once its tab is idle, within about 15 s (a running turn ends first)",
      `SPOTLIGHT every screen dimmed (0.6) but the window of [app] alpha, until the meeting ends; its errors go to ${join(TEAM_HOME, 'state', 'logs', 'meeting-spotlight.log')}`,
    ]);
  });

  // T2662: a scheduled meeting dims the screens as the daily one does, over the session met's window.
  it("dims every screen but the session met's window from its start, its spotlight lifted by its end", async () => {
    const kit = await team();
    await booked(kit, '--with', 'bravo', '--session', 'lead');
    const processes = new FakeProcesses().onRun('powershell.exe', { kind: 'exited', code: 0 });
    const started = await kit.run(['meeting', 'start', 'M1', '--session', 'bravo'], { ...(await alphaRuns(kit)), platform: 'win32', processes });
    assert.equal(started.code, EXIT.ok, said(started));
    assert.match(started.stdout.at(-1) ?? '', /^SPOTLIGHT every screen dimmed \(0\.6\) but the window of \[app\] alpha, until the meeting ends/);
    assert.equal(processes.hidden.length, 1);
    const env = processes.hidden[0]?.env ?? {};
    // The title deliver() brings to the front, the file the script watches, the start it watches for there.
    assert.equal(env[SPOTLIGHT_VARS.title], '[app] alpha');
    assert.equal(env[SPOTLIGHT_VARS.meeting], SPOTLIT_PATH);
    assert.equal(env[SPOTLIGHT_VARS.startedAt], '2030-01-08T10:00:00.000Z');
    // Its 30 minutes and the 15 minutes' grace from the start, not the daily meeting's 4 h.
    assert.equal(env[SPOTLIGHT_VARS.until], String(Date.parse('2030-01-08T10:45:00.000Z')));
    assert.deepEqual(await spotlitOf(kit), { id: 'M1', startedAt: '2030-01-08T10:00:00.000Z', endedAt: null });
    // It names itself the host's one spotlight, which lifts the daily meeting's if that one is on (T4294).
    const holderFile = join(KIT, 'meeting-spotlight.json');
    assert.equal(env[SPOTLIGHT_VARS.holder], holderFile);
    assert.deepEqual(JSON.parse(kit.files.get(holderFile) ?? ''), { meetingFile: SPOTLIT_PATH, startedAt: '2030-01-08T10:00:00.000Z' });

    kit.clock.advance(20 * MS_PER_MINUTE);
    assert.equal((await kit.run(['meeting', 'end', 'M1', '--session', 'lead'])).code, EXIT.ok);
    assert.deepEqual(await spotlitOf(kit), { id: 'M1', startedAt: '2030-01-08T10:00:00.000Z', endedAt: '2030-01-08T10:20:00.000Z' });
  });

  it("lifts the spotlight at a drop, and an end or drop of another meeting leaves the one on lit", async () => {
    const kit = await team();
    await booked(kit, '--session', 'lead');
    await booked(kit, '--session', 'lead');
    const options = { ...(await alphaRuns(kit)), platform: 'win32' as const, processes: new FakeProcesses().onRun('powershell.exe', { kind: 'exited', code: 0 }) };
    assert.equal((await kit.run(['meeting', 'start', 'M1', '--session', 'lead'], options)).code, EXIT.ok);
    kit.clock.advance(MS_PER_MINUTE);
    assert.equal((await kit.run(['meeting', 'start', 'M2', '--session', 'lead'], options)).code, EXIT.ok);
    assert.equal((await kit.run(['meeting', 'end', 'M1', '--session', 'lead'])).code, EXIT.ok);
    assert.deepEqual(await spotlitOf(kit), { id: 'M2', startedAt: '2030-01-08T10:01:00.000Z', endedAt: null });

    kit.clock.advance(MS_PER_MINUTE);
    assert.equal((await kit.run(['meeting', 'drop', 'M2', '--note', 'settled by mail', '--session', 'lead'])).code, EXIT.ok);
    assert.deepEqual(await spotlitOf(kit), { id: 'M2', startedAt: '2030-01-08T10:01:00.000Z', endedAt: '2030-01-08T10:02:00.000Z' });
  });

  it("opens a closed child team's lead for its meeting, as it opens any session's tab (T3387)", async () => {
    const kit = await team({ ...TEAM, team: { id: 'app', parent: 'org' }, roles: { lead: 'alpha' } });
    await booked(kit, '--session', 'alpha');
    const processes = new FakeProcesses().onStart('wt.exe', { kind: 'started', end: 'exited' });
    const result = await kit.run(['meeting', 'start', 'M1', '--session', 'bravo'], { platform: 'win32', processes, probe: new FakePathProbe({ folders: [APP] }) });
    assert.equal(result.code, EXIT.ok, said(result));
    // The lead's tab opens on the lead's model and effort.
    assert.ok(result.stdout.some((line) => line.startsWith(`OPENED app-alpha (session alpha) in a new Windows Terminal tab in ${APP}, on model`) && line.endsWith('; its first prompt opens the meeting')), said(result));
  });

  it('opens the tab of a session that runs none, the opening prompt ahead of its own first prompt, and leaves no ask behind', async () => {
    const kit = await team();
    await booked(kit, '--with', 'bravo', '--tasks', 'T1', '--brief', 'notes/alpha/brief.md', '--session', 'lead');
    const processes = new FakeProcesses().onStart('wt.exe', { kind: 'started', end: 'exited' });
    const result = await kit.run(['meeting', 'start', 'M1', '--session', 'bravo'], { platform: 'win32', processes, probe: new FakePathProbe({ folders: [APP] }) });
    assert.equal(result.code, EXIT.ok, said(result));
    assert.equal(result.stdout.length, 4, 'bravo starts it, so only alpha is told');
    assert.equal(result.stdout[2], `OPENED app-alpha (session alpha) in a new Windows Terminal tab in ${APP}, on the default model and effort; its first prompt opens the meeting`);
    // The spotlight frames the new tab's window once it shows.
    assert.match(result.stdout[3] ?? '', /^SPOTLIGHT every screen dimmed \(0\.6\) but the window of \[app\] alpha/);
    const args = processes.started[0]?.args ?? [];
    const prompt = decodePrompt(args[args.indexOf('--encoded-prompt') + 1] ?? '');
    assert.match(prompt ?? '', /^Urgent lines were posted for you while you were closed; act on each first:\n- 10:00 UTC bravo: The owner starts meeting M1 now/);
    assert.deepEqual(await asksOf(kit, 'alpha'), []);
  });

  it('keeps the opening prompt as an urgent line when no terminal opens, and prints the command to run', async () => {
    const kit = await team();
    await booked(kit, '--session', 'lead');
    const result = await kit.run(['meeting', 'start', 'M1', '--session', 'lead'], { probe: new FakePathProbe({ folders: [APP] }) });
    assert.equal(result.code, EXIT.ok, said(result));
    assert.match(result.stdout[2] ?? '', /^MANUAL no terminal opened \(.+\); the meeting waits as an urgent line: open a new terminal and run this:$/);
    assert.equal(result.stdout.length, 4);
    assert.equal((await asksOf(kit, 'alpha')).length, 1);
  });

  it('posts no ask while wake.enabled is false, and says the meeting waits in its inbox', async () => {
    const kit = await team({ ...TEAM, wake: { enabled: false } });
    await booked(kit, '--session', 'lead');
    const result = await kit.run(['meeting', 'start', 'M1', '--session', 'lead'], await alphaRuns(kit));
    assert.equal(result.code, EXIT.ok, said(result));
    assert.equal(result.stdout.at(-1), 'NOT WOKEN app-alpha: wake.enabled is false on the team, so the meeting waits in its inbox for its next prompt');
    assert.deepEqual(await asksOf(kit, 'alpha'), []);
  });

  it('starts a missed meeting, but not one started or finished, and the daily start stays the lead\'s', async () => {
    const kit = await team();
    await booked(kit, '--session', 'lead');
    kit.clock.advance(5 * 60 * MS_PER_MINUTE);
    const options = await alphaRuns(kit);
    assert.equal((await kit.run(['meeting', 'start', 'M1', '--session', 'alpha'], options)).code, EXIT.ok);
    const again = await kit.run(['meeting', 'start', 'M1', '--session', 'alpha'], options);
    assert.equal(again.code, EXIT.refused);
    assert.match(said(again), /^REFUSED M1 is started: meeting start takes a scheduled meeting/);
    const daily = await kit.run(['meeting', 'start', '--session', 'alpha']);
    assert.equal(daily.code, EXIT.refused);
    assert.match(said(daily), /only the lead \(app-lead\) runs the owner's daily meeting; a meeting of your own with the owner: teamrig meeting start --about "<what>"/);
  });
});

describe('runCli: meeting start --about, a meeting on the spot (T2985)', () => {
  it("starts a worker's own meeting in its tab, refuses a second, and meeting end with no id ends it", async () => {
    const kit = await team();
    const started = await kit.run(['meeting', 'start', '--about', 'the cache design.', '--with', 'bravo', '--tasks', 'T1', '--session', 'alpha']);
    assert.equal(started.code, EXIT.ok, said(started));
    assert.equal(started.stdout[0], 'STARTED M1 started, Tue 01-08 10:00 UTC, 30 min, alpha with bravo, tasks T1 | the cache design.');
    assert.match(said(started), /MEETING in this tab: messages to app-alpha are held but CRITICAL ones\. The owner starts meeting M1 now \(30 min\): the cache design\./);
    assert.doesNotMatch(said(started), /TOLD alpha/);
    const meeting = await stored(kit, 'M1');
    assert.deepEqual(
      { status: meeting?.status, session: meeting?.session, with: meeting?.with, tasks: meeting?.tasks, by: meeting?.by, at: meeting?.at },
      { status: 'started', session: 'alpha', with: ['bravo'], tasks: ['T1'], by: 'alpha', at: kit.clock.now() },
    );
    assert.doesNotMatch((await inboxOf(kit, 'alpha')).join('\n'), /meeting M1/, 'the opening prompt printed in its own tab');
    assert.ok((await inboxOf(kit, 'bravo')).some((line) => line.endsWith("Meeting M1 with the owner started in alpha's tab: the cache design.")));

    const again = await kit.run(['meeting', 'start', '--about', 'another', '--session', 'alpha']);
    assert.equal(again.code, EXIT.refused);
    assert.match(said(again), /alpha is in meeting M1 already: teamrig meeting end M1 ends it first/);

    const ended = await kit.run(['meeting', 'end', '--note', 'the cache stays', '--session', 'alpha']);
    assert.equal(ended.code, EXIT.ok, said(ended));
    assert.match(ended.stdout[0] ?? '', /^ENDED M1 done, /);
    assert.equal((await stored(kit, 'M1'))?.note, 'the cache stays');
    const none = await kit.run(['meeting', 'end', '--session', 'alpha']);
    assert.equal(none.code, EXIT.refused, 'no meeting left in its tab: the daily end is the lead\'s');
    assert.match(said(none), /only the lead \(app-lead\) runs the owner's daily meeting/);
  });

  it('starts one with another session for the lead or that session only, its opening prompt sent to its tab', async () => {
    const kit = await team();
    const other = await kit.run(['meeting', 'start', '--about', 'the API', '--meets', 'alpha', '--session', 'bravo']);
    assert.equal(other.code, EXIT.refused);
    assert.match(said(other), /only the lead \(app-lead\) or alpha, the session met, may start a meeting with alpha/);
    const options = await alphaRuns(kit);
    const started = await kit.run(['meeting', 'start', '--about', 'the API', '--meets', 'alpha', '--session', 'lead'], options);
    assert.equal(started.code, EXIT.ok, said(started));
    assert.match(said(started), /^TOLD alpha$/m);
    assert.equal((await stored(kit, 'M1'))?.status, 'started');
  });

  it("ends the lead's daily meeting first, then the lead's own one", async () => {
    const kit = await team();
    assert.equal((await kit.run(['meeting', 'start', '--session', 'lead'])).code, EXIT.ok);
    assert.equal((await kit.run(['meeting', 'start', '--about', 'the hiring plan', '--session', 'lead'])).code, EXIT.ok);
    assert.equal((await kit.run(['meeting', 'end', '--session', 'lead'])).code, EXIT.ok);
    assert.equal((await stored(kit, 'M1'))?.status, 'started', 'the daily meeting ended first');
    assert.equal((await kit.run(['meeting', 'end', '--session', 'lead'])).code, EXIT.ok);
    assert.equal((await stored(kit, 'M1'))?.status, 'done');
  });
});

describe('openingPrompt', () => {
  it('names the meeting, and its tasks, those joining and its brief only when it has them', () => {
    const meeting: ScheduledMeeting = { id: 'M2', at: 0, minutes: 20, session: 'alpha', with: [], tasks: [], about: 'the pane.', brief: null, status: 'scheduled', notifiedAt: null, by: 'lead', changedAt: 0, note: null };
    assert.equal(openingPrompt(meeting), 'The owner starts meeting M2 now (20 min): the pane. Meet the owner here now. When it is over: teamrig meeting end M2 --note "<what came of it>".');
  });
});

describe("runCli: today's meetings in start and the daily agenda", () => {
  it('shows each session the meetings of today it is met in or joins, the lead every one, and a missed one until it is moved', async () => {
    const kit = await team();
    await booked(kit, '--with', 'bravo', '--tasks', 'T1', '--session', 'lead');
    const later = await kit.run(['meeting', 'schedule', '--meets', 'bravo', '--at', '2030-01-09 15:00', '--about', 'the pane', '--session', 'lead']);
    assert.equal(later.code, EXIT.ok, said(later));
    for (const session of ['alpha', 'bravo', 'lead']) {
      const started = await kit.run(['start', '--session', session]);
      assert.equal(started.stdout[1], 'MEETINGS today: M1 14:00 UTC alpha with bravo on T1', session);
    }
    kit.clock.advance(24 * 60 * MS_PER_MINUTE);
    assert.equal((await kit.run(['start', '--session', 'lead'])).stdout[1], 'MEETINGS today: M1 missed (Tue 01-08 14:00 UTC) alpha with bravo on T1; M2 15:00 UTC bravo');
    assert.equal((await kit.run(['start', '--session', 'alpha'])).stdout[1], 'MEETINGS today: M1 missed (Tue 01-08 14:00 UTC) alpha with bravo on T1');
    const startM2 = await kit.run(['meeting', 'start', 'M2', '--session', 'lead'], { probe: new FakePathProbe({ folders: [APP] }) });
    assert.equal(startM2.code, EXIT.ok, said(startM2));
    const dropM1 = await kit.run(['meeting', 'drop', 'M1', '--note', 'held in the daily', '--session', 'lead']);
    assert.equal(dropM1.code, EXIT.ok, said(dropM1));
    assert.equal((await kit.run(['start', '--session', 'bravo'])).stdout[1], 'MEETINGS today: M2 started 15:00 UTC bravo');
    assert.equal((await kit.run(['start', '--session', 'alpha'])).stdout.some((line) => line.startsWith('MEETINGS')), false, 'none of its own: no line');
  });

  it("lists today's and the missed meetings in the daily agenda, as meeting list shows them", async () => {
    const kit = await team();
    const none = await kit.run(['meeting', 'agenda', '--session', 'lead']);
    assert.ok(none.stdout.includes('MEETINGS 0 today'), said(none));
    await booked(kit, '--with', 'bravo', '--tasks', 'T1', '--session', 'lead');
    kit.clock.advance(5 * 60 * MS_PER_MINUTE);
    const agenda = (await kit.run(['meeting', 'agenda', '--session', 'lead'])).stdout;
    const at = agenda.indexOf('MEETINGS 1 today or missed');
    assert.ok(at >= 0, agenda.join('\n'));
    assert.deepEqual(agenda.slice(at + 1, at + 3), [
      '  M1 missed, Tue 01-08 14:00 UTC, 30 min, alpha with bravo, tasks T1 | the release plan',
      '  The owner starts one with teamrig meeting start <id>; a missed one is moved (teamrig meeting move <id> --at <time>) or dropped.',
    ]);
  });
});

const ALPHA_TAB = CLAUDE_SESSION;
const LEAD_TAB = '0123abcd-0000-4000-8000-0000000000ef';
const TAB_ENV = { CLAUDE_PROJECT_DIR: APP, CLAUDE_CODE_ENTRYPOINT: 'cli', TEAMRIG_TEAM: 'app' };

/** A prompt submitted in `session`'s tab, as Claude Code's prompt hook reports it to `hook restore-track`. */
async function promptIn(kit: CliHarness, session: string, tab: string, text: string): Promise<void> {
  const stdin = JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: tab, cwd: APP, prompt: text });
  const result = await kit.run(['hook', 'restore-track'], { stdin, env: { ...TAB_ENV, TEAMRIG_SESSION: session }, sessionProcesses: new FakeSessionProcesses(7000) });
  assert.equal(result.code, EXIT.ok);
}

/** A prompt teamrig submits in that tab: marked where it is submitted (src/restore/prompt-marks.ts), then prompted. */
async function teamrigPromptIn(kit: CliHarness, session: string, tab: string, text: string): Promise<void> {
  await new PromptMarks(kit.files, promptMarksDir(KIT)).mark({ tab }, text, kit.clock.now());
  await promptIn(kit, session, tab, text);
}

/** A command run in the Claude Code session `tab`, as its Bash tool runs it. */
function inTab(tab: string): RunOptions {
  return { env: { CLAUDE_CODE_SESSION_ID: tab } };
}

describe('runCli: meeting end while the owner is still in the meeting (#921)', () => {
  it('refuses a turn teamrig started while the owner prompted in the meeting tab under meeting.ownerLeftMinutes ago, and --owner-left ends it', async () => {
    const kit = await team();
    assert.equal((await kit.run(['meeting', 'start', '--about', 'the cache design', '--session', 'alpha'])).code, EXIT.ok);
    await promptIn(kit, 'alpha', ALPHA_TAB, 'walk me through the cache design');
    kit.clock.advance(5 * MS_PER_MINUTE);
    // The idle pass closed and reopened alpha's tab: its reopen note starts the turn.
    await teamrigPromptIn(kit, 'alpha', ALPHA_TAB, reopenPrompt('app', 'alpha'));
    const refused = await kit.run(['meeting', 'end', '--note', 'done', '--session', 'alpha'], inTab(ALPHA_TAB));
    assert.equal(refused.code, EXIT.refused);
    assert.equal(
      said(refused),
      'REFUSED meeting M1 is still on: the owner prompted in this tab 5 min ago and this turn was started by teamrig; the owner ends it, or it ends itself Tue 01-08 14:00 UTC; teamrig meeting end M1 --owner-left ends it anyway',
    );
    assert.equal((await stored(kit, 'M1'))?.status, 'started');
    const byId = await kit.run(['meeting', 'end', 'M1', '--session', 'alpha'], inTab(ALPHA_TAB));
    assert.equal(byId.code, EXIT.refused, 'by its id too');

    const forced = await kit.run(['meeting', 'end', '--owner-left', '--session', 'alpha'], inTab(ALPHA_TAB));
    assert.equal(forced.code, EXIT.ok, said(forced));
    assert.equal((await stored(kit, 'M1'))?.status, 'done');
  });

  it('ends it as before when the owner started the turn, when the owner was quiet meeting.ownerLeftMinutes, or outside a tab', async () => {
    const kit = await team({ ...TEAM, meeting: { ownerLeftMinutes: 10 } });
    assert.equal((await kit.run(['meeting', 'start', '--about', 'the cache design', '--session', 'alpha'])).code, EXIT.ok);
    await promptIn(kit, 'alpha', ALPHA_TAB, 'thanks, end the meeting');
    const asked = await kit.run(['meeting', 'end', '--session', 'alpha'], inTab(ALPHA_TAB));
    assert.equal(asked.code, EXIT.ok, said(asked));

    assert.equal((await kit.run(['meeting', 'start', '--about', 'the API', '--session', 'alpha'])).code, EXIT.ok);
    await promptIn(kit, 'alpha', ALPHA_TAB, 'walk me through the API');
    kit.clock.advance(10 * MS_PER_MINUTE);
    await teamrigPromptIn(kit, 'alpha', ALPHA_TAB, reopenPrompt('app', 'alpha'));
    const quiet = await kit.run(['meeting', 'end', '--session', 'alpha'], inTab(ALPHA_TAB));
    assert.equal(quiet.code, EXIT.ok, said(quiet));

    assert.equal((await kit.run(['meeting', 'start', '--about', 'the docs', '--session', 'alpha'])).code, EXIT.ok);
    await promptIn(kit, 'alpha', ALPHA_TAB, 'walk me through the docs');
    await teamrigPromptIn(kit, 'alpha', ALPHA_TAB, reopenPrompt('app', 'alpha'));
    const shell = await kit.run(['meeting', 'end', '--session', 'alpha']);
    assert.equal(shell.code, EXIT.ok, 'run from a terminal of its own, no turn of any tab started it');
  });

  it("refuses the lead a turn teamrig started while the owner is in the session met's tab", async () => {
    const kit = await team();
    assert.equal((await kit.run(['meeting', 'start', '--about', 'the cache design', '--session', 'alpha'])).code, EXIT.ok);
    await promptIn(kit, 'alpha', ALPHA_TAB, 'walk me through the cache design');
    kit.clock.advance(2 * MS_PER_MINUTE);
    await teamrigPromptIn(kit, 'lead', LEAD_TAB, 'New work was handed to you while this tab was idle.');
    const refused = await kit.run(['meeting', 'end', 'M1', '--session', 'lead'], inTab(LEAD_TAB));
    assert.equal(refused.code, EXIT.refused);
    assert.match(said(refused), /^REFUSED meeting M1 is still on: the owner prompted in app-alpha's tab 2 min ago and this turn was started by teamrig;/);
  });

  it("refuses the lead's daily meeting end the same way", async () => {
    const kit = await team();
    assert.equal((await kit.run(['meeting', 'start', '--session', 'lead'])).code, EXIT.ok);
    await promptIn(kit, 'lead', LEAD_TAB, 'next card');
    kit.clock.advance(3 * MS_PER_MINUTE);
    await teamrigPromptIn(kit, 'lead', LEAD_TAB, 'New work was handed to you while this tab was idle.');
    const refused = await kit.run(['meeting', 'end', '--session', 'lead'], inTab(LEAD_TAB));
    assert.equal(refused.code, EXIT.refused);
    assert.equal(
      said(refused),
      'REFUSED the daily meeting is still on: the owner prompted in this tab 3 min ago and this turn was started by teamrig; the owner ends it, or it ends itself Tue 01-08 14:00 UTC; teamrig meeting end --owner-left ends it anyway',
    );
    const forced = await kit.run(['meeting', 'end', '--owner-left', '--session', 'lead'], inTab(LEAD_TAB));
    assert.equal(forced.code, EXIT.ok, said(forced));
  });

  it('says in the first prompt of a session reopened while its meeting is on that only the owner ends it', async () => {
    const kit = await team();
    assert.equal((await kit.run(['meeting', 'start', '--about', 'the cache design', '--session', 'alpha'])).code, EXIT.ok);
    // No terminal opens here, so open prints the tab's command line, the first prompt in it.
    const opened = await kit.run(['open', 'alpha', '--session', 'lead'], { probe: new FakePathProbe({ folders: [APP] }) });
    const encoded = /'--encoded-prompt' '([A-Za-z0-9_-]+)'/.exec(said(opened))?.[1] ?? '';
    const prompt = decodePrompt(encoded) ?? '';
    assert.ok(prompt.endsWith(' A meeting with the owner is on in this tab (M1, until Tue 01-08 14:00 UTC): it stays on; only the owner ends it.'), said(opened));
  });
});
