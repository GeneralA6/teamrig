import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The daily-meeting skill held to the week report the owner gets once a week: the main lead brings it at the first
 * meeting after the reset, before the ship board, with the split, each plan, the motivation, last week and the appeals,
 * and it asks the owner nothing, so the weekly split never turns into a decision that waits on them.
 */

const SKILL = readFileSync(fileURLToPath(new URL('../../plugins/teamrig/skills/daily-meeting/SKILL.md', import.meta.url)), 'utf8');

/** The week report's paragraph and its list, up to the next blank line after the list. */
function weekReport(): string {
  const start = SKILL.indexOf('At the first meeting after the weekly reset');
  assert.ok(start >= 0, 'the skill has no week report');
  const end = SKILL.indexOf('\n\n', SKILL.indexOf('\n- ', start));
  return SKILL.slice(start, end < 0 ? SKILL.length : end);
}

describe('the daily-meeting skill', () => {
  it('has the main lead bring the week report before the ship board, asking for nothing', () => {
    const report = weekReport();
    assert.match(report, /the main lead \(the lead of the team\s`\[budget\.accountLead\]` names, else of the root team\) brings the week report before the ship board/);
    assert.match(report, /nothing in it asks\s+for an answer/);
  });

  it('carries the split, each plan, the motivation, last week and the appeals', () => {
    const report = weekReport();
    for (const item of ["- the week's split among the teams, and its reasoning", "- each team's plan: what ships, and when", '- the motivation:', '- last week in two lines:', '- the appeals that reached the owner']) {
      assert.ok(report.includes(item), `the week report lacks ${item}`);
    }
  });
});
