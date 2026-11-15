import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_MEETING } from '../config/defaults.ts';
import { MS_PER_HOUR } from '../core/time.ts';
import type { ScheduledMeeting } from './schedule.ts';
import type { Meeting } from './state.ts';
import { coloured, statusLineMeetingOf } from './status-line.ts';

const START = Date.parse('2030-01-08T08:00:00Z');
const OPEN: Meeting = { startedAt: new Date(START).toISOString(), by: 'lead', endedAt: null, since: null, carried: [], kind: 'daily' };
const SHOWN = DEFAULT_MEETING.statusLine;
const TAB = { kind: 'tab', colour: '#8b57e3', title: 'daily' };
const HELD = { kind: 'held', colour: '#8b57e3', text: 'meeting on: held' };
const TECH: ScheduledMeeting = {
  id: 'M4',
  at: START,
  minutes: 30,
  session: 'front',
  with: ['back'],
  tasks: [],
  about: 'the cache design.',
  brief: null,
  status: 'started',
  notifiedAt: null,
  by: 'lead',
  changedAt: START,
  note: null,
};

describe('statusLineMeetingOf', () => {
  it('marks the tab of a session met in a booked or on-the-spot meeting with its title, a worker too (T2985)', () => {
    const now = START + 60_000;
    const titled = { kind: 'tab', colour: '#8b57e3', title: 'the cache design' };
    assert.deepEqual(statusLineMeetingOf({ shown: SHOWN, own: undefined, above: [], booked: [TECH], now, tab: 'front' }), titled);
    assert.equal(statusLineMeetingOf({ shown: SHOWN, own: undefined, above: [], booked: [TECH], now, tab: 'back' }), undefined, 'one joining keeps its line');
    assert.deepEqual(statusLineMeetingOf({ shown: SHOWN, own: OPEN, above: [], booked: [TECH], now, tab: 'front' }), titled, 'its own meeting over the held text');
    assert.equal(statusLineMeetingOf({ shown: SHOWN, own: undefined, above: [], booked: [{ ...TECH, status: 'done' }], now, tab: 'front' }), undefined, 'ended');
  });

  it("marks the tab of the lead that started its team's open meeting with the daily title, and holds every other tab's", () => {
    const now = START + 60_000;
    assert.deepEqual(statusLineMeetingOf({ shown: SHOWN, own: OPEN, above: [], booked: [], now, tab: 'lead' }), TAB);
    assert.deepEqual(statusLineMeetingOf({ shown: SHOWN, own: OPEN, above: [], booked: [], now, tab: 'front' }), HELD);
    assert.deepEqual(statusLineMeetingOf({ shown: SHOWN, own: OPEN, above: [], booked: [], now, tab: undefined }), HELD);
  });

  // T3137: a meeting started after the day's daily one has ended is not the daily meeting.
  it("marks the lead's tab with the extra title for an extra meeting, and holds every other tab's as for the daily one", () => {
    const now = START + 60_000;
    const extra: Meeting = { ...OPEN, kind: 'extra' };
    assert.deepEqual(statusLineMeetingOf({ shown: SHOWN, own: extra, above: [], booked: [], now, tab: 'lead' }), { ...TAB, title: 'extra' });
    assert.deepEqual(statusLineMeetingOf({ shown: SHOWN, own: extra, above: [], booked: [], now, tab: 'front' }), HELD);
  });

  it("holds a sub-team's tabs while a team above meets, and colours its lead's tab for its own meeting (T2985)", () => {
    const now = START + 60_000;
    assert.deepEqual(statusLineMeetingOf({ shown: SHOWN, own: undefined, above: [undefined, OPEN], booked: [], now, tab: 'lead' }), HELD, "the root's lead shares the id, not the tab");
    assert.deepEqual(statusLineMeetingOf({ shown: SHOWN, own: OPEN, above: [OPEN], booked: [], now, tab: 'lead' }), TAB);
    assert.deepEqual(statusLineMeetingOf({ shown: SHOWN, own: OPEN, above: [undefined], booked: [], now, tab: 'front' }), HELD);
  });

  it('marks nothing with no meeting, an ended or lapsed one, or the marks off', () => {
    const now = START + 60_000;
    assert.equal(statusLineMeetingOf({ shown: SHOWN, own: undefined, above: [], booked: [], now, tab: 'lead' }), undefined);
    const ended = { ...OPEN, endedAt: new Date(START + 30_000).toISOString() };
    assert.equal(statusLineMeetingOf({ shown: SHOWN, own: ended, above: [ended], booked: [], now, tab: 'front' }), undefined);
    assert.equal(statusLineMeetingOf({ shown: SHOWN, own: OPEN, above: [OPEN], booked: [], now: START + 5 * MS_PER_HOUR, tab: 'front' }), undefined);
    assert.equal(statusLineMeetingOf({ shown: { ...SHOWN, enabled: false }, own: OPEN, above: [], booked: [], now, tab: 'lead' }), undefined);
  });
});

describe('coloured', () => {
  it('wraps the text in the 24-bit foreground code of the colour and resets after it', () => {
    assert.equal(coloured('Opus 5.5', '#d75fd7'), '\x1b[38;2;215;95;215mOpus 5.5\x1b[0m');
    assert.equal(coloured('x', '#00FF0a'), '\x1b[38;2;0;255;10mx\x1b[0m');
  });
});
