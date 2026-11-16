import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { NewerDataError } from '../core/jsonl.ts';
import { MS_PER_HOUR } from '../core/time.ts';
import { TimeZone } from '../core/zone.ts';
import { fieldPaths } from '../testing/field-paths.ts';
import { MemoryFiles } from '../testing/memory-files.ts';
import { formatMeeting, inMeeting, MEETING_FORMAT, MEETING_LAPSE_MS, MeetingStore, parseMeeting, phaseOf, startingKindOf, stoppedAt, type Meeting } from './state.ts';

const STARTED = '2030-01-08T09:00:00.000Z';
const START = Date.parse(STARTED);
const OPEN: Meeting = { startedAt: STARTED, by: 'lead', endedAt: null, since: null, carried: [], kind: 'daily' };

describe('the meeting phase', () => {
  it('is none before any meeting, open while one runs, closed once ended', () => {
    assert.deepEqual(phaseOf(undefined, START), { kind: 'none' });
    assert.deepEqual(phaseOf(OPEN, START + MS_PER_HOUR), { kind: 'open', meeting: OPEN });
    const ended: Meeting = { ...OPEN, endedAt: '2030-01-08T09:40:00.000Z' };
    assert.deepEqual(phaseOf(ended, START + MS_PER_HOUR), { kind: 'closed', meeting: ended, until: Date.parse('2030-01-08T09:40:00.000Z') });
  });

  it('lapses a meeting never ended at the lapse time, so a forgotten end holds nothing for good', () => {
    assert.equal(phaseOf(OPEN, START + MEETING_LAPSE_MS - 1).kind, 'open');
    assert.deepEqual(phaseOf(OPEN, START + MEETING_LAPSE_MS), { kind: 'lapsed', meeting: OPEN, until: START + MEETING_LAPSE_MS });
  });

  it('stopped at the end or the lapse, and not for an open meeting or none', () => {
    assert.equal(stoppedAt({ kind: 'none' }), undefined);
    assert.equal(stoppedAt({ kind: 'open', meeting: OPEN }), undefined);
    assert.equal(stoppedAt({ kind: 'lapsed', meeting: OPEN, until: 7 }), 7);
    assert.equal(stoppedAt({ kind: 'closed', meeting: OPEN, until: 9 }), 9);
  });

  it('has only the session that started it in it, and only while it is open', () => {
    const later = START + MS_PER_HOUR;
    assert.equal(inMeeting(OPEN, 'lead', later), true);
    assert.equal(inMeeting(OPEN, 'alpha', later), false, 'another session works on');
    assert.equal(inMeeting(undefined, 'lead', later), false);
    assert.equal(inMeeting({ ...OPEN, endedAt: '2030-01-08T09:40:00.000Z' }, 'lead', later), false, 'ended');
    assert.equal(inMeeting(OPEN, 'lead', START + MEETING_LAPSE_MS), false, 'lapsed');
  });
});

describe('the meeting file', () => {
  it('reads back what it writes, open or ended', () => {
    assert.deepEqual(parseMeeting(formatMeeting(OPEN)), OPEN);
    const ended: Meeting = { startedAt: STARTED, by: 'lead', endedAt: '2030-01-08T09:40:00.000Z', since: '2030-01-07T09:30:00.000Z', carried: ['T4', 'web/T2'], kind: 'daily' };
    assert.deepEqual(parseMeeting(formatMeeting(ended)), ended);
  });

  it('reads a file written before carry-over (T2775) as carrying nothing', () => {
    assert.deepEqual(parseMeeting(JSON.stringify({ v: 1, startedAt: STARTED, by: 'lead', endedAt: null, since: null })), OPEN);
  });

  // T3137: format 2 added the kind; a format 1 file is the day's daily meeting, as every meeting was then.
  it('reads back an extra meeting, and a format 1 file as a daily one', () => {
    const extra: Meeting = { ...OPEN, kind: 'extra' };
    assert.deepEqual(parseMeeting(formatMeeting(extra)), extra);
    assert.deepEqual(parseMeeting(JSON.stringify({ v: 1, startedAt: STARTED, by: 'lead', endedAt: null, since: null, carried: [], kind: 'extra' })), OPEN, 'format 1 had no kind');
    assert.equal(parseMeeting(JSON.stringify({ v: 2, startedAt: STARTED, by: 'lead', endedAt: null, since: null, carried: [] })), undefined, 'format 2 needs it');
    assert.equal(parseMeeting(JSON.stringify({ v: 2, startedAt: STARTED, by: 'lead', endedAt: null, since: null, carried: [], kind: 'weekly' })), undefined);
  });

  it('pins the fields of the current format', () => {
    const full: Meeting = { ...OPEN, endedAt: '2030-01-08T09:40:00.000Z', since: '2030-01-07T09:30:00.000Z', carried: ['T4'] };
    assert.equal(MEETING_FORMAT, 2);
    assert.deepEqual(fieldPaths(JSON.parse(formatMeeting(full))), ['by', 'carried[]', 'endedAt', 'kind', 'since', 'startedAt', 'v']);
  });

  it('reads a damaged file, another format or a bad field as no meeting', () => {
    assert.equal(parseMeeting('{not json'), undefined);
    assert.equal(parseMeeting(JSON.stringify({ v: 3, startedAt: STARTED, by: 'lead', endedAt: null, since: null, carried: [], kind: 'daily' })), undefined);
    assert.equal(parseMeeting(JSON.stringify({ v: 1, startedAt: 'soon', by: 'lead', endedAt: null, since: null })), undefined);
    assert.equal(parseMeeting(JSON.stringify({ v: 1, by: 'lead', endedAt: null, since: null })), undefined);
    assert.equal(parseMeeting(JSON.stringify({ v: 1, startedAt: STARTED, endedAt: null, since: null })), undefined);
    assert.equal(parseMeeting(JSON.stringify({ v: 1, startedAt: STARTED, by: 'lead', endedAt: 5, since: null })), undefined);
    assert.equal(parseMeeting(JSON.stringify({ v: 1, startedAt: STARTED, by: 'lead', endedAt: null, since: false })), undefined);
    assert.equal(parseMeeting(JSON.stringify({ v: 1, startedAt: STARTED, by: 'lead', endedAt: null, since: null, carried: 'T4' })), undefined);
    assert.equal(parseMeeting(JSON.stringify({ v: 1, startedAt: STARTED, by: 'lead', endedAt: null, since: null, carried: [4] })), undefined);
  });

  it('stores the latest meeting in one file, none before the first', async () => {
    const files = new MemoryFiles();
    const store = new MeetingStore(files, '/kit/state/meeting.json');
    assert.equal(await store.read(), undefined);
    await store.write(OPEN);
    assert.deepEqual(await store.read(), OPEN);
    assert.equal(await files.read('/kit/state/meeting.json'), formatMeeting(OPEN));
  });

  it('overwrites a format 1 file, and refuses one a newer teamrig wrote, leaving it as it was', async () => {
    const files = new MemoryFiles();
    const store = new MeetingStore(files, '/kit/state/meeting.json');
    await files.write('/kit/state/meeting.json', JSON.stringify({ v: 1, startedAt: STARTED, by: 'lead', endedAt: null, since: null }));
    await store.write({ ...OPEN, kind: 'extra' });
    assert.equal((await store.read())?.kind, 'extra');
    const newer = JSON.stringify({ v: 3, startedAt: STARTED, by: 'lead' });
    await files.write('/kit/state/meeting.json', newer);
    await assert.rejects(store.write(OPEN), NewerDataError);
    assert.equal(await files.read('/kit/state/meeting.json'), newer);
  });
});

// T3137: only the day's first meeting is the owner's daily one.
describe('the kind of meeting a start opens', () => {
  const UTC = TimeZone.UTC;
  const ended = (at: string): Meeting => ({ ...OPEN, endedAt: at });

  it('is daily for the first meeting, and for the first of a later day', () => {
    assert.equal(startingKindOf(phaseOf(undefined, START), START, UTC), 'daily');
    const yesterday: Meeting = { ...OPEN, startedAt: '2030-01-07T09:00:00.000Z', endedAt: '2030-01-07T09:30:00.000Z' };
    assert.equal(startingKindOf(phaseOf(yesterday, START), START, UTC), 'daily');
  });

  it('is extra after a meeting started earlier the same day, ended or lapsed, a daily or an extra one', () => {
    const later = START + 2 * MS_PER_HOUR;
    assert.equal(startingKindOf(phaseOf(ended('2030-01-08T09:30:00.000Z'), later), later, UTC), 'extra');
    const lapsedAt = START + MEETING_LAPSE_MS + MS_PER_HOUR;
    assert.equal(startingKindOf(phaseOf(OPEN, lapsedAt), lapsedAt, UTC), 'extra');
    const afterExtra: Meeting = { ...ended('2030-01-08T12:00:00.000Z'), startedAt: '2030-01-08T11:30:00.000Z', kind: 'extra' };
    assert.equal(startingKindOf(phaseOf(afterExtra, later + MS_PER_HOUR), later + MS_PER_HOUR, UTC), 'extra');
  });

  it("counts the day on the team's clock", () => {
    const evening: Meeting = { ...OPEN, startedAt: '2030-01-08T20:00:00.000Z', endedAt: '2030-01-08T20:30:00.000Z' };
    const now = Date.parse('2030-01-08T22:30:00.000Z');
    const jerusalem = TimeZone.of('Asia/Jerusalem');
    assert.ok(jerusalem, 'the system knows Asia/Jerusalem');
    assert.equal(startingKindOf(phaseOf(evening, now), now, UTC), 'extra');
    assert.equal(startingKindOf(phaseOf(evening, now), now, jerusalem), 'daily', 'past midnight on its clock');
  });
});
