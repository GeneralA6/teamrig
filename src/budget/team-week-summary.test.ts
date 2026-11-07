import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fieldPaths } from '../testing/field-paths.ts';
import { formatTeamWeek, parseTeamWeek, TEAM_WEEK_FORMAT, type NamedTeamWeek } from './team-week-summary.ts';

const SUMMARY: NamedTeamWeek = {
  account: 'work',
  usedPct: 15.25,
  plannedPct: 84.5,
  accountUsedPct: 30,
  resetsAt: Date.parse('2030-01-14T01:00:00Z'),
  start: Date.parse('2030-01-07T01:00:00Z'),
  at: Date.parse('2030-01-08T10:00:00Z'),
  limits: [{ start: Date.parse('2030-01-06T08:00:00Z'), end: Date.parse('2030-01-07T01:00:00Z') }],
};

describe('the team week summary', () => {
  it('reads back what it wrote', () => {
    const text = formatTeamWeek(SUMMARY);
    assert.equal(text, JSON.stringify({ v: TEAM_WEEK_FORMAT, ...SUMMARY }));
    assert.deepEqual(parseTeamWeek(text), SUMMARY);
  });

  it('writes the pinned fields of its format: a field added to the file raises TEAM_WEEK_FORMAT', () => {
    const written: Readonly<Record<number, readonly string[]>> = {
      1: ['accountUsedPct', 'at', 'plannedPct', 'resetsAt', 'usedPct', 'v'],
      2: ['account', 'accountUsedPct', 'at', 'limits[].end', 'limits[].start', 'plannedPct', 'resetsAt', 'usedPct', 'v'],
      3: ['account', 'accountUsedPct', 'at', 'limits[].end', 'limits[].start', 'plannedPct', 'resetsAt', 'start', 'usedPct', 'v'],
    };
    assert.deepEqual(fieldPaths(JSON.parse(formatTeamWeek(SUMMARY))), written[TEAM_WEEK_FORMAT]);
  });

  it('reads a format 1 file, which an idle team keeps until its hooks write again, as naming no account, no stretch and no start (T1777, T2050, T2082)', () => {
    const { account: _named, limits: _spans, start: _start, ...unnamed } = SUMMARY;
    assert.deepEqual(parseTeamWeek(JSON.stringify({ v: 1, ...unnamed })), { ...SUMMARY, account: undefined, start: undefined, limits: [] });
  });

  it('reads a format 2 file, which an idle team keeps until its hooks write again, as naming no start (T2082)', () => {
    const { start: _start, ...unstarted } = SUMMARY;
    assert.deepEqual(parseTeamWeek(JSON.stringify({ v: 2, ...unstarted })), { ...SUMMARY, start: undefined });
  });

  it('reads back a week that never sat at its limit as no stretches (T2050)', () => {
    const summary = { ...SUMMARY, limits: [] };
    assert.deepEqual(parseTeamWeek(formatTeamWeek(summary)), summary);
  });

  it('reads nothing from a current file whose stretches are missing or damaged (T2050)', () => {
    const { limits: _spans, ...without } = SUMMARY;
    const stored = { v: TEAM_WEEK_FORMAT, ...without };
    assert.equal(parseTeamWeek(JSON.stringify(stored)), undefined, 'missing');
    for (const limits of ['none', [7], [{ start: 1 }], [{ start: '1', end: 2 }], [{ start: 2, end: 2 }], [{ start: 1, end: 2 }, null]]) {
      assert.equal(parseTeamWeek(JSON.stringify({ ...stored, limits })), undefined, JSON.stringify(limits));
    }
  });

  it('reads nothing from a current file that names no account, or names it by something not a string (T1777)', () => {
    const { account: _named, ...unnamed } = SUMMARY;
    assert.equal(parseTeamWeek(JSON.stringify({ v: TEAM_WEEK_FORMAT, ...unnamed })), undefined);
    assert.equal(parseTeamWeek(JSON.stringify({ v: TEAM_WEEK_FORMAT, ...unnamed, account: 7 })), undefined);
  });

  it('reads nothing from a damaged or torn file', () => {
    assert.equal(parseTeamWeek(''), undefined);
    assert.equal(parseTeamWeek(formatTeamWeek(SUMMARY).slice(0, 30)), undefined);
    assert.equal(parseTeamWeek('[1, 2]'), undefined);
  });

  it('reads nothing from a format it does not know, an older unversioned one or a newer one', () => {
    const unversioned: Record<string, unknown> = { ...SUMMARY };
    assert.equal(parseTeamWeek(JSON.stringify(unversioned)), undefined);
    assert.equal(parseTeamWeek(JSON.stringify({ ...unversioned, v: TEAM_WEEK_FORMAT + 1 })), undefined);
  });

  it('reads nothing when a field is missing or not a number', () => {
    for (const field of ['usedPct', 'plannedPct', 'accountUsedPct', 'resetsAt', 'start', 'at']) {
      const stored = { v: TEAM_WEEK_FORMAT, ...SUMMARY };
      assert.equal(parseTeamWeek(JSON.stringify({ ...stored, [field]: undefined })), undefined, `${field} missing`);
      assert.equal(parseTeamWeek(JSON.stringify({ ...stored, [field]: '15' })), undefined, `${field} a string`);
    }
  });
});
