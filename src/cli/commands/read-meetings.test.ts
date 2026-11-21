import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { JsonRecord } from '../../core/guards.ts';
import { SecretScanner } from '../../core/secrets.ts';
import { cutText } from '../../interface/index.ts';
import { CliHarness, TEAM_HOME, USER_HOME, type RunOptions } from '../../testing/cli-harness.ts';
import { problemsOf, rowsOf, served } from '../../testing/read-answers.ts';
import { teamHomeOf, treeHarness } from '../../testing/team-tree.ts';
import { EXIT } from '../runtime.ts';
import { servedBriefOf } from './read-meetings.ts';

const READ_MEETINGS = ['read', 'meetings', '--json'] as const;
const MEETINGS_PATH = join(TEAM_HOME, 'state', 'meetings.jsonl');
const MINUTE_MS = 60_000;
const APP_FOLDER = { team: 'app', home: TEAM_HOME };
/** A text one of teamrig's own secret shapes matches, built from parts so this file holds none. */
const SECRET = ['pass', 'word', '=', 'hunter2'].join('');

/** Books a meeting of the owner with `meets`, as the lead, at `at` on the harness's day. */
async function book(kit: CliHarness, meets: string, at: string, about: string, more: readonly string[] = [], options: RunOptions = {}): Promise<void> {
  const result = await kit.run(['meeting', 'schedule', '--meets', meets, '--at', `2030-01-08 ${at}`, '--about', about, ...more, '--session', 'lead'], options);
  assert.equal(result.code, EXIT.ok, [...result.stdout, ...result.stderr].join('\n'));
}

function meetingsOf(answer: JsonRecord): JsonRecord[] {
  return rowsOf(answer, 'meetings');
}

describe('teamrig read meetings', () => {
  it('answers one JSON line with the envelope and the meetings by time', async () => {
    const kit = new CliHarness();
    await book(kit, 'alpha', '14:00', 'the release plan', ['--with', 'bravo', '--minutes', '45']);
    await book(kit, 'bravo', '11:00', 'the docs');
    const answer = served(await kit.run(READ_MEETINGS));
    assert.deepEqual([answer['interface'], answer['document'], answer['problems'], answer['cuts']], ['1.2', 'meetings', [], []]);
    assert.match(String(answer['revision']), /^[0-9a-f]{16}$/);
    assert.deepEqual(meetingsOf(answer), [
      { id: 'M2', at: '2030-01-08T11:00:00.000Z', atText: 'Tue 01-08 11:00 UTC', minutes: 30, session: 'bravo', with: [], tasks: [], about: 'the docs', brief: null, status: 'scheduled', missed: false },
      { id: 'M1', at: '2030-01-08T14:00:00.000Z', atText: 'Tue 01-08 14:00 UTC', minutes: 45, session: 'alpha', with: ['bravo'], tasks: [], about: 'the release plan', brief: null, status: 'scheduled', missed: false },
    ]);
  });

  it('serves the rows meeting list --json prints, less the meetings dropped', async () => {
    const kit = new CliHarness();
    await book(kit, 'alpha', '14:00', 'the release plan');
    await book(kit, 'bravo', '11:00', 'the docs');
    await book(kit, 'bravo', '16:00', 'the old plan');
    const dropped = await kit.run(['meeting', 'drop', 'M3', '--note', 'settled by mail', '--session', 'lead']);
    assert.equal(dropped.code, EXIT.ok, dropped.stdout.join('\n'));
    const listed: unknown = JSON.parse((await kit.run(['meeting', 'list', '--json', '--session', 'alpha'])).stdout.join(''));
    const answer = served(await kit.run(READ_MEETINGS));
    assert.deepEqual({ meetings: meetingsOf(answer) }, listed);
    assert.deepEqual(meetingsOf(answer).map((meeting) => meeting['id']), ['M2', 'M1']);
  });

  it('serves a team that booked none as no meeting', async () => {
    const answer = served(await new CliHarness().run(READ_MEETINGS));
    assert.deepEqual([meetingsOf(answer), problemsOf(answer)], [[], []]);
  });

  it('turns a scheduled meeting missed when its slot ends, its revision not moving with the clock', async () => {
    const kit = new CliHarness();
    await book(kit, 'bravo', '11:00', 'the docs');
    const before = served(await kit.run(READ_MEETINGS));
    kit.clock.advance(90 * MINUTE_MS);
    const after = served(await kit.run(READ_MEETINGS));
    assert.deepEqual([meetingsOf(before)[0]?.['missed'], meetingsOf(after)[0]?.['missed']], [false, true]);
    assert.equal(after['revision'], before['revision']);
  });

  it('holds its revision until the meetings change', async () => {
    const kit = new CliHarness();
    await book(kit, 'alpha', '14:00', 'the release plan');
    const first = served(await kit.run(READ_MEETINGS));
    const again = served(await kit.run(READ_MEETINGS));
    await book(kit, 'bravo', '15:00', 'the docs');
    const changed = served(await kit.run(READ_MEETINGS));
    assert.equal(again['revision'], first['revision']);
    assert.notEqual(changed['revision'], first['revision']);
  });

  it('words a start in the zone the run reads times in, which is part of the revision', async () => {
    const kit = new CliHarness();
    await book(kit, 'alpha', '14:00', 'the release plan');
    const utc = served(await kit.run(READ_MEETINGS));
    const tokyo = served(await kit.run(READ_MEETINGS, { timeZone: 'Asia/Tokyo' }));
    const [inUtc] = meetingsOf(utc);
    const [inTokyo] = meetingsOf(tokyo);
    assert.equal(inTokyo?.['at'], inUtc?.['at']);
    assert.notEqual(inTokyo?.['atText'], inUtc?.['atText']);
    assert.notEqual(tokyo['revision'], utc['revision']);
  });

  it('cuts a text matching a secret shape and lists the cut, never serving the text', async () => {
    const kit = new CliHarness();
    await book(kit, 'alpha', '14:00', 'the release plan');
    // A booking refuses a secret, so only a file changed by hand holds one.
    await kit.files.write(MEETINGS_PATH, (kit.files.get(MEETINGS_PATH) ?? '').replace('the release plan', `rotate ${SECRET}`));
    const shape = new SecretScanner().find(SECRET)?.description ?? '';
    const result = await kit.run(READ_MEETINGS);
    const answer = served(result);
    assert.equal(meetingsOf(answer)[0]?.['about'], cutText(shape));
    assert.deepEqual(answer['cuts'], [{ id: 'M1', field: 'about', shape }]);
    assert.equal(result.stdout.join('\n').includes(SECRET), false);
  });

  it('serves the meetings it can read and counts a damaged line in problems, never quoting it', async () => {
    const kit = new CliHarness();
    await book(kit, 'alpha', '14:00', 'the release plan');
    await kit.files.append(MEETINGS_PATH, `{"about": "${SECRET}", torn\n`);
    const result = await kit.run(READ_MEETINGS);
    const answer = served(result);
    assert.deepEqual(meetingsOf(answer).map((meeting) => meeting['id']), ['M1']);
    assert.deepEqual(problemsOf(answer), ['app/state/meetings.jsonl: 1 damaged or newer line(s) left out']);
    assert.equal(result.stdout.join('\n').includes(SECRET), false);
  });

  it('names a brief by no place on the disk', async () => {
    const kit = new CliHarness();
    await book(kit, 'alpha', '14:00', 'typed from the team folder', ['--brief', 'notes/alpha/brief.md']);
    await book(kit, 'alpha', '15:00', 'inside the team folder', ['--brief', join(TEAM_HOME, 'notes', 'alpha', 'plan.md')]);
    await book(kit, 'alpha', '16:00', 'in the home', ['--brief', join(USER_HOME, 'private', 'draft.md')]);
    const result = await kit.run(READ_MEETINGS);
    assert.deepEqual(meetingsOf(served(result)).map((meeting) => meeting['brief']), ['notes/alpha/brief.md', 'app/notes/alpha/plan.md', 'draft.md']);
    assert.equal(result.stdout.join('\n').includes('private'), false);
  });

  it('serves a team above the caller\'s with --team, and its own without', async () => {
    const kit = await treeHarness();
    await book(kit, 'front', '14:00', 'of web', [], { env: { TEAMRIG_TEAM: 'web' } });
    await book(kit, 'pixel', '15:00', 'of ui', [], { env: { TEAMRIG_TEAM: 'ui' } });
    const own = served(await kit.run(READ_MEETINGS, { env: { TEAMRIG_TEAM: 'ui' } }));
    const above = served(await kit.run([...READ_MEETINGS, '--team', 'web'], { env: { TEAMRIG_TEAM: 'ui' } }));
    assert.deepEqual([meetingsOf(own).map((meeting) => meeting['about']), meetingsOf(above).map((meeting) => meeting['about'])], [['of ui'], ['of web']]);
    assert.notEqual(above['revision'], own['revision']);
  });
});

describe('servedBriefOf', () => {
  it('serves a path that is full on no OS as it was typed', () => {
    for (const typed of ['brief.md', 'notes/alpha/brief.md', 'notes\\alpha\\brief.md', '~/notes/brief.md', 'C:brief.md']) {
      assert.equal(servedBriefOf(APP_FOLDER, typed), typed);
    }
  });

  it('names a full path inside the team\'s folder from that folder down', () => {
    assert.equal(servedBriefOf(APP_FOLDER, join(TEAM_HOME, 'notes', 'alpha', 'brief.md')), 'app/notes/alpha/brief.md');
    assert.equal(servedBriefOf({ team: 'web', home: teamHomeOf('web') }, join(teamHomeOf('web'), 'brief.md')), 'web/brief.md');
  });

  it('names a full path outside it by its last part alone, another team\'s folder too', () => {
    assert.equal(servedBriefOf(APP_FOLDER, join(USER_HOME, 'private', 'draft.md')), 'draft.md');
    assert.equal(servedBriefOf(APP_FOLDER, join(teamHomeOf('web'), 'notes', 'brief.md')), 'brief.md');
  });

  it('names a path that is full on the other OS by its last part alone, whichever OS reads it', () => {
    assert.equal(servedBriefOf(APP_FOLDER, 'C:\\Users\\someone\\docs\\brief.md'), 'brief.md');
    assert.equal(servedBriefOf(APP_FOLDER, '\\\\host\\share\\docs\\brief.md'), 'brief.md');
    assert.equal(servedBriefOf(APP_FOLDER, '/home/someone/docs/brief.md'), 'brief.md');
    assert.equal(servedBriefOf(APP_FOLDER, 'C:\\Users\\someone\\docs\\'), 'docs');
  });
});
