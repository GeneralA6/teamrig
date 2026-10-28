import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { MS_PER_MINUTE } from '../core/time.ts';
import { readMeetings, type ScheduledMeeting } from '../meeting/schedule.ts';
import { CliHarness, TEAM_HOME, type CliResult } from '../testing/cli-harness.ts';
import { EXIT } from './runtime.ts';

const MEETINGS_PATH = join(TEAM_HOME, 'state', 'meetings.jsonl');
const BOOK = ['meeting', 'schedule', '--meets', 'alpha', '--at', '2030-01-08 14:00', '--about', 'the release plan'];

/** A team whose register holds T1, so a meeting can link it. */
async function team(): Promise<CliHarness> {
  const kit = new CliHarness();
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
      assert.ok(lines.some((line) => line.endsWith('Meeting M1 with the owner booked: Tue 01-08 14:00 UTC (45 min) with alpha: the release plan; tasks T1; brief notes/alpha/brief.md. At its time: teamrig meeting start M1')), lines.join('\n'));
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

  it('ends a meeting with what came of it, and refuses to move or end it again', async () => {
    const kit = await team();
    await booked(kit, '--session', 'lead');
    const ended = await kit.run(['meeting', 'end', 'M1', '--note', 'ship on Friday', '--session', 'lead']);
    assert.equal(ended.code, EXIT.ok, ended.stderr.join('\n'));
    assert.deepEqual(ended.stdout, ['ENDED M1 done, Tue 01-08 14:00 UTC, 30 min, alpha | the release plan']);
    assert.equal((await stored(kit, 'M1'))?.note, 'ship on Friday');

    const again = await kit.run(['meeting', 'end', 'M1', '--session', 'lead']);
    assert.equal(again.code, EXIT.refused);
    assert.match(said(again), /M1 is done: meeting end takes a scheduled or started meeting/);
    const move = await kit.run(['meeting', 'move', 'M1', '--at', '2030-01-09 10:00', '--session', 'lead']);
    assert.equal(move.code, EXIT.refused);
    assert.match(said(move), /M1 is done: meeting move takes a scheduled meeting/);
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
    assert.match(said(daily), /--note goes with meeting end <id>, a scheduled meeting/);
  });
});
