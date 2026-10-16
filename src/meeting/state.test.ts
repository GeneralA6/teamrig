import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MS_PER_HOUR } from '../core/time.ts';
import { MemoryFiles } from '../testing/memory-files.ts';
import { formatMeeting, MEETING_LAPSE_MS, MeetingStore, parseMeeting, phaseOf, stoppedAt, type Meeting } from './state.ts';

const STARTED = '2030-01-08T09:00:00.000Z';
const START = Date.parse(STARTED);
const OPEN: Meeting = { startedAt: STARTED, by: 'lead', endedAt: null, since: null };

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
});

describe('the meeting file', () => {
  it('reads back what it writes, open or ended', () => {
    assert.deepEqual(parseMeeting(formatMeeting(OPEN)), OPEN);
    const ended: Meeting = { startedAt: STARTED, by: 'lead', endedAt: '2030-01-08T09:40:00.000Z', since: '2030-01-07T09:30:00.000Z' };
    assert.deepEqual(parseMeeting(formatMeeting(ended)), ended);
  });

  it('reads a damaged file, another format or a bad field as no meeting', () => {
    assert.equal(parseMeeting('{not json'), undefined);
    assert.equal(parseMeeting(JSON.stringify({ v: 2, startedAt: STARTED, by: 'lead', endedAt: null, since: null })), undefined);
    assert.equal(parseMeeting(JSON.stringify({ v: 1, startedAt: 'soon', by: 'lead', endedAt: null, since: null })), undefined);
    assert.equal(parseMeeting(JSON.stringify({ v: 1, by: 'lead', endedAt: null, since: null })), undefined);
    assert.equal(parseMeeting(JSON.stringify({ v: 1, startedAt: STARTED, endedAt: null, since: null })), undefined);
    assert.equal(parseMeeting(JSON.stringify({ v: 1, startedAt: STARTED, by: 'lead', endedAt: 5, since: null })), undefined);
    assert.equal(parseMeeting(JSON.stringify({ v: 1, startedAt: STARTED, by: 'lead', endedAt: null, since: false })), undefined);
  });

  it('stores the latest meeting in one file, none before the first', async () => {
    const files = new MemoryFiles();
    const store = new MeetingStore(files, '/kit/state/meeting.json');
    assert.equal(await store.read(), undefined);
    await store.write(OPEN);
    assert.deepEqual(await store.read(), OPEN);
    assert.equal(await files.read('/kit/state/meeting.json'), formatMeeting(OPEN));
  });
});
