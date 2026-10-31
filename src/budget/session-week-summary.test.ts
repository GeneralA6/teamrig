import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fieldPaths } from '../testing/field-paths.ts';
import { formatSessionsWeek, parseSessionsWeek, SESSIONS_WEEK_FORMAT, type SessionsWeekSummary } from './session-week-summary.ts';

const SUMMARY: SessionsWeekSummary = {
  resetsAt: Date.parse('2030-01-14T01:00:00Z'),
  at: Date.parse('2030-01-08T10:00:00Z'),
  sessions: { lead: { usedPct: 5.25, workHours: 3 }, alpha: { usedPct: 10, workHours: 7 }, bravo: { usedPct: 0, workHours: 0 } },
};

/** The summary's file as a plain object, to break one field of. */
function stored(): Record<string, unknown> {
  return { v: SESSIONS_WEEK_FORMAT, resetsAt: SUMMARY.resetsAt, at: SUMMARY.at, sessions: { ...SUMMARY.sessions } };
}

describe("the sessions' week summary", () => {
  it('reads back what it wrote, the sessions in the order written', () => {
    const text = formatSessionsWeek(SUMMARY);
    assert.equal(text, JSON.stringify(stored()));
    assert.deepEqual(parseSessionsWeek(text), SUMMARY);
    assert.deepEqual(Object.keys(parseSessionsWeek(text)?.sessions ?? {}), ['lead', 'alpha', 'bravo']);
  });

  it('reads a team with no sessions', () => {
    const empty = { ...SUMMARY, sessions: {} };
    assert.deepEqual(parseSessionsWeek(formatSessionsWeek(empty)), empty);
  });

  it('writes the pinned fields of its format: a field added to the file raises SESSIONS_WEEK_FORMAT', () => {
    const written: Readonly<Record<number, readonly string[]>> = { 1: ['at', 'resetsAt', 'sessions.*.usedPct', 'sessions.*.workHours', 'v'] };
    assert.deepEqual(fieldPaths(JSON.parse(formatSessionsWeek(SUMMARY)), new Set(['sessions'])), written[SESSIONS_WEEK_FORMAT]);
  });

  it('reads nothing from a damaged or torn file', () => {
    assert.equal(parseSessionsWeek(''), undefined);
    assert.equal(parseSessionsWeek(formatSessionsWeek(SUMMARY).slice(0, 40)), undefined);
    assert.equal(parseSessionsWeek('[1, 2]'), undefined);
  });

  it('reads nothing from a format it does not know, an older unversioned one or a newer one', () => {
    assert.equal(parseSessionsWeek(JSON.stringify({ ...stored(), v: undefined })), undefined);
    assert.equal(parseSessionsWeek(JSON.stringify({ ...stored(), v: SESSIONS_WEEK_FORMAT + 1 })), undefined);
  });

  it('reads nothing when a field is missing or of the wrong kind', () => {
    for (const field of ['resetsAt', 'at', 'sessions']) {
      assert.equal(parseSessionsWeek(JSON.stringify({ ...stored(), [field]: undefined })), undefined, `${field} missing`);
      assert.equal(parseSessionsWeek(JSON.stringify({ ...stored(), [field]: '15' })), undefined, `${field} a string`);
    }
  });

  it("reads nothing when a session's entry is damaged, rather than a team short of that session", () => {
    const broken: readonly unknown[] = [
      7,
      { workHours: 3 },
      { usedPct: '5', workHours: 3 },
      { usedPct: 5 },
      { usedPct: 5, workHours: 2.5 },
      { usedPct: 5, workHours: -1 },
    ];
    for (const entry of broken) {
      const text = JSON.stringify({ ...stored(), sessions: { ...SUMMARY.sessions, alpha: entry } });
      assert.equal(parseSessionsWeek(text), undefined, JSON.stringify(entry));
    }
  });
});
