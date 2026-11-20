import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SecretScanner } from '../core/secrets.ts';
import { cutText, meetingsBody, type MeetingInput, type MeetingsBody } from './index.ts';

/** A text the shipped shapes take for a secret, built here so no secret-shaped line sits in the repository. */
const SECRET = ['pass', 'word', '=', 'hunter2'].join('');
const SHAPE = new SecretScanner().find(SECRET)?.description ?? '';
const CUT = cutText(SHAPE);

function row(overrides: Partial<MeetingInput> = {}): MeetingInput {
  return {
    id: 'M1',
    at: '2030-01-08T14:00:00.000Z',
    atText: 'Tue 01-08 14:00 UTC',
    minutes: 30,
    session: 'alpha',
    with: [],
    tasks: [],
    about: 'the release plan',
    brief: null,
    status: 'scheduled',
    missed: false,
    ...overrides,
  };
}

function bodyOf(...rows: MeetingInput[]): MeetingsBody {
  return meetingsBody({ rows, shapes: new SecretScanner() });
}

describe('meetingsBody', () => {
  it('serves a meeting as its row, field for field and in this order', () => {
    const full = row({ with: ['bravo'], tasks: ['T1', 'T2'], brief: 'app/notes/alpha/brief.md', status: 'started' });
    const body = bodyOf(full);
    assert.deepEqual(body, { meetings: [full], cuts: [] });
    assert.deepEqual(Object.keys(body.meetings[0] ?? {}), ['id', 'at', 'atText', 'minutes', 'session', 'with', 'tasks', 'about', 'brief', 'status', 'missed']);
  });

  it('keeps the order it is handed', () => {
    assert.deepEqual(bodyOf(row({ id: 'M3' }), row({ id: 'M1' }), row({ id: 'M2' })).meetings.map((meeting) => meeting.id), ['M3', 'M1', 'M2']);
  });

  it('serves what a meeting is about as a plain text: the team wrote it', () => {
    assert.equal(bodyOf(row({ about: 'line one\nline two' })).meetings[0]?.about, 'line one\nline two');
  });

  it('cuts what it is about when that has a secret\'s shape, and names the meeting, the field and the shape', () => {
    const body = bodyOf(row(), row({ id: 'M2', about: `rotate ${SECRET} first` }));
    assert.deepEqual(body.meetings.map((meeting) => meeting.about), ['the release plan', CUT]);
    assert.notEqual(SHAPE, '');
    assert.deepEqual(body.cuts, [{ id: 'M2', field: 'about', shape: SHAPE }]);
  });

  it('cuts a brief with a secret\'s shape and leaves a meeting with none as null', () => {
    const body = bodyOf(row(), row({ id: 'M2', brief: `${SECRET}.md` }));
    assert.deepEqual(body.meetings.map((meeting) => meeting.brief), [null, CUT]);
    assert.deepEqual(body.cuts, [{ id: 'M2', field: 'brief', shape: SHAPE }]);
  });

  it('looks at each session joining and each task by itself, so one cut leaves its neighbours', () => {
    const body = bodyOf(row({ session: SECRET, with: ['bravo', SECRET, 'charlie'], tasks: [SECRET, 'T2'] }));
    const [meeting] = body.meetings;
    assert.deepEqual([meeting?.session, meeting?.with, meeting?.tasks], [CUT, ['bravo', CUT, 'charlie'], [CUT, 'T2']]);
    assert.deepEqual(body.cuts.map((cut) => [cut.id, cut.field]), [['M1', 'session'], ['M1', 'with'], ['M1', 'tasks']]);
    assert.equal(JSON.stringify(body).includes(SECRET), false);
  });
});
