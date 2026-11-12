import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_MEETING } from '../config/defaults.ts';
import { MS_PER_HOUR } from '../core/time.ts';
import type { Meeting } from './state.ts';
import { coloured, statusLineMeetingOf } from './status-line.ts';

const START = Date.parse('2030-01-08T08:00:00Z');
const OPEN: Meeting = { startedAt: new Date(START).toISOString(), by: 'lead', endedAt: null, since: null };
const SHOWN = DEFAULT_MEETING.statusLine;

describe('statusLineMeetingOf', () => {
  it("colours the tab of the lead that started an open meeting and holds every other tab's", () => {
    const now = START + 60_000;
    assert.deepEqual(statusLineMeetingOf({ shown: SHOWN, meeting: OPEN, now, tab: 'lead' }), { kind: 'tab', colour: '#d75fd7' });
    assert.deepEqual(statusLineMeetingOf({ shown: SHOWN, meeting: OPEN, now, tab: 'front' }), { kind: 'held', text: 'meeting on: held' });
    assert.deepEqual(statusLineMeetingOf({ shown: SHOWN, meeting: OPEN, now, tab: undefined }), { kind: 'held', text: 'meeting on: held' });
  });

  it('marks nothing with no meeting, an ended or lapsed one, or the marks off', () => {
    const now = START + 60_000;
    assert.equal(statusLineMeetingOf({ shown: SHOWN, meeting: undefined, now, tab: 'lead' }), undefined);
    const ended = { ...OPEN, endedAt: new Date(START + 30_000).toISOString() };
    assert.equal(statusLineMeetingOf({ shown: SHOWN, meeting: ended, now, tab: 'front' }), undefined);
    assert.equal(statusLineMeetingOf({ shown: SHOWN, meeting: OPEN, now: START + 5 * MS_PER_HOUR, tab: 'front' }), undefined);
    assert.equal(statusLineMeetingOf({ shown: { ...SHOWN, enabled: false }, meeting: OPEN, now, tab: 'lead' }), undefined);
  });
});

describe('coloured', () => {
  it('wraps the text in the 24-bit foreground code of the colour and resets after it', () => {
    assert.equal(coloured('Opus 5.5', '#d75fd7'), '\x1b[38;2;215;95;215mOpus 5.5\x1b[0m');
    assert.equal(coloured('x', '#00FF0a'), '\x1b[38;2;0;255;10mx\x1b[0m');
  });
});
