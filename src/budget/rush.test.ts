import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TimeZone } from '../core/zone.ts';
import { testConfig } from '../testing/config.ts';
import { JERUSALEM } from '../testing/zone.ts';
import type { Rush } from './burst.ts';
import { rushLine, rushOverlay, rushSegment } from './rush.ts';

const RUSH: Rush = {
  kind: 'rush',
  goal: 'PROD',
  sessions: ['lead', 'alpha', 'bravo'],
  helpers: 3,
  hires: 0,
  dailyPct: 20,
  stopPct: 90,
  endsAt: Date.parse('2030-01-11T16:00:00Z'),
  deadline: Date.parse('2030-01-11T16:00:00Z'),
  tasks: [],
  reason: 'release',
  by: 'lead',
  at: Date.parse('2030-01-08T10:00:00Z'),
};

const QUIET = { startUtc: '22:00', endUtc: '06:00', action: 'block' };

describe('rushOverlay', () => {
  it('turns every budget hold to report only: over-budget action, pause by priority, quiet hours, the WIP rule', () => {
    const config = testConfig({ budget: { enabled: true, overAction: 'ask-lead', pauseByPriority: true, quietHours: QUIET }, focus: { wip: { mode: 'refuse' } } });
    const rushed = rushOverlay(config);
    assert.equal(rushed.budget.overAction, 'warn');
    assert.equal(rushed.budget.pauseByPriority, false);
    assert.deepEqual(rushed.budget.quietHours, { ...config.budget.quietHours, action: 'warn' });
    assert.equal(rushed.focus.wip.mode, 'warn');
    assert.equal(config.budget.overAction, 'ask-lead', 'the config read stays as it was');
  });

  it('keeps a WIP rule the team turned off off, and adds no quiet hours a team has none of', () => {
    const rushed = rushOverlay(testConfig({ focus: { wip: { mode: 'off' } } }));
    assert.equal(rushed.focus.wip.mode, 'off');
    assert.equal(rushed.budget.quietHours, undefined);
  });
});

describe('rushSegment and rushLine', () => {
  it("name the goal and its end on the team's clock, and the line its stop % and the holds that stay", () => {
    assert.equal(rushSegment(RUSH, JERUSALEM), 'RUSH PROD to Fri 01-11 18:00 IST');
    assert.equal(
      rushLine(RUSH, TimeZone.UTC),
      "RUSH goal PROD until Fri 01-11 16:00 UTC or 90.0% of the week: the budget's holds only report; queue cutoffs, CPU gates and owner gates still hold",
    );
  });
});
