import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatTeamWeek, parseTeamWeek, TEAM_WEEK_FORMAT, type TeamWeekSummary } from './team-week-summary.ts';

const SUMMARY: TeamWeekSummary = {
  usedPct: 15.25,
  plannedPct: 84.5,
  accountUsedPct: 30,
  resetsAt: Date.parse('2030-01-14T01:00:00Z'),
  at: Date.parse('2030-01-08T10:00:00Z'),
};

describe('the team week summary', () => {
  it('reads back what it wrote', () => {
    const text = formatTeamWeek(SUMMARY);
    assert.equal(text, JSON.stringify({ v: TEAM_WEEK_FORMAT, ...SUMMARY }));
    assert.deepEqual(parseTeamWeek(text), SUMMARY);
  });

  it('reads nothing from a damaged or torn file', () => {
    assert.equal(parseTeamWeek(''), undefined);
    assert.equal(parseTeamWeek(formatTeamWeek(SUMMARY).slice(0, 30)), undefined);
    assert.equal(parseTeamWeek('[1, 2]'), undefined);
  });

  it('reads nothing from a format it does not know, an older unversioned one or a newer one', () => {
    const unversioned: Record<string, number> = { ...SUMMARY };
    assert.equal(parseTeamWeek(JSON.stringify(unversioned)), undefined);
    assert.equal(parseTeamWeek(JSON.stringify({ ...unversioned, v: TEAM_WEEK_FORMAT + 1 })), undefined);
  });

  it('reads nothing when a field is missing or not a number', () => {
    for (const field of ['usedPct', 'plannedPct', 'accountUsedPct', 'resetsAt', 'at']) {
      const stored = { v: TEAM_WEEK_FORMAT, ...SUMMARY };
      assert.equal(parseTeamWeek(JSON.stringify({ ...stored, [field]: undefined })), undefined, `${field} missing`);
      assert.equal(parseTeamWeek(JSON.stringify({ ...stored, [field]: '15' })), undefined, `${field} a string`);
    }
  });
});
