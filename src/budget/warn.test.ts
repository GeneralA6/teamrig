import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { OverAction } from '../config/types.ts';
import type { Lift } from './lift.ts';
import { readPace, weekWindow, type PaceBudget } from './pace.ts';
import { emptyWarnState, helperGate, levelOf, promptWarning, quietStartOf, stopWarning, type BudgetFacts, type WarnBudget, type WarnState } from './warn.ts';

const RESET = Date.parse('2026-10-21T01:00:00Z');
const WINDOW = weekWindow(RESET, 1);
const PACE: PaceBudget = { targetPct: 99.5, paceEndHoursBeforeReset: 1, paceTolerancePct: 0.5 };
/** Thursday 2026-10-15 14:00 UTC: the pace line is at 22.0%. */
const DAY = Date.parse('2026-10-15T14:00:00Z');
const NIGHT = Date.parse('2026-10-15T23:00:00Z');
const QUIET = { startUtc: '22:00', endUtc: '06:00', action: 'ask' } as const;

const DAYTIME: WarnBudget = { warnAtPct: [80, 100], overAction: 'ask-lead', escalate: 'session-and-fleet' };
const BUDGET: WarnBudget = { ...DAYTIME, quietHours: QUIET };

/** A session at `usedTodayPct` of a 1% daily budget, with the week `weekUsedPct` used at `now`. */
function facts(usedTodayPct: number, weekUsedPct: number, now = DAY, extra: Partial<BudgetFacts> = {}): BudgetFacts {
  return {
    now,
    id: 'alpha',
    name: 'alpha',
    usedTodayPct,
    budgetPct: 1,
    lift: undefined,
    weekUsedPct,
    pace: readPace(WINDOW, PACE, now, weekUsedPct),
    isLead: false,
    ...extra,
  };
}

/** Behind the pace line and ahead of it at `DAY`. */
const BEHIND = 10;
const AHEAD = 40;

function lift(overrides: Partial<Lift> = {}): Lift {
  return {
    session: 'alpha',
    toPct: 2,
    stopPct: 97,
    endsAt: Date.parse('2026-10-15T23:59:00Z'),
    reserve: false,
    quietHoursExempt: true,
    reason: 'incident',
    by: 'lead',
    at: Date.parse('2026-10-15T12:00:00Z'),
    ...overrides,
  };
}

describe('levelOf', () => {
  const table: readonly [number, number][] = [
    [0, 0],
    [79.9, 0],
    [80, 80],
    [99, 80],
    [100, 100],
    [124, 100],
    [125, 125],
    [190, 175],
    [Number.POSITIVE_INFINITY, 100],
  ];
  for (const [use, level] of table) {
    it(`puts ${use}% of the budget at level ${level}`, () => {
      assert.equal(levelOf(use, [100, 80]), level);
    });
  }

  it('has no level without warning levels', () => {
    assert.equal(levelOf(500, []), 0);
  });
});

describe('quietStartOf', () => {
  it('finds the start of quiet hours that cross midnight, on either side of it', () => {
    assert.equal(quietStartOf(QUIET, NIGHT), Date.parse('2026-10-15T22:00:00Z'));
    assert.equal(quietStartOf(QUIET, Date.parse('2026-10-16T05:59:00Z')), Date.parse('2026-10-15T22:00:00Z'));
    assert.equal(quietStartOf(QUIET, Date.parse('2026-10-16T06:00:00Z')), undefined);
    assert.equal(quietStartOf(QUIET, DAY), undefined);
  });

  it('finds quiet hours within one day, and none for unset, equal or malformed hours', () => {
    const lunch = { startUtc: '12:00', endUtc: '15:00', action: 'ask' } as const;
    assert.equal(quietStartOf(lunch, DAY), Date.parse('2026-10-15T12:00:00Z'));
    assert.equal(quietStartOf(undefined, DAY), undefined);
    assert.equal(quietStartOf({ ...lunch, endUtc: '12:00' }, DAY), undefined);
    assert.equal(quietStartOf({ ...lunch, startUtc: '25:00' }, DAY), undefined);
  });
});

describe('stopWarning', () => {
  it('shows each level once a day, with the team line under budget', () => {
    const first = stopWarning(facts(0.85, BEHIND), BUDGET, undefined);
    assert.equal(first.lines.length, 1);
    assert.match(first.lines[0] ?? '', /^Budget: alpha has used 0\.85% of the week today; its daily budget is 1\.0%\. Team: 10\.0% used, pace line 22\.0%\. More: teamrig budget$/);
    assert.equal(first.leadLine, undefined);
    assert.equal(stopWarning(facts(0.9, BEHIND), BUDGET, first.state).lines.length, 0);
    const nextDay = stopWarning(facts(0.85, BEHIND, Date.parse('2026-10-16T09:00:00Z')), BUDGET, first.state);
    assert.equal(nextDay.lines.length, 1);
    assert.equal(nextDay.state.day, '2026-10-16');
  });

  it('only tells a session past budget that nothing more happens while the team is not ahead', () => {
    const result = stopWarning(facts(1.1, BEHIND), BUDGET, undefined);
    assert.match(result.lines[0] ?? '', /The team is not ahead of its pace line, so nothing more happens\./);
    assert.equal(result.leadLine, undefined);
    assert.equal(result.state.leadTold, false);
  });

  const actions: readonly [OverAction, string, boolean][] = [
    ['warn', 'More: teamrig budget', false],
    ['ask-lead', 'The lead has an inbox line. More', true],
    ['ask', 'New helpers ask first; the lead has an inbox line.', true],
    ['block', 'New helpers are refused; the lead has an inbox line.', true],
  ];
  for (const [overAction, text, tellsLead] of actions) {
    it(`escalates with ${overAction} once the session is past budget and the team ahead`, () => {
      const result = stopWarning(facts(1.1, AHEAD), { ...BUDGET, overAction }, undefined);
      assert.ok((result.lines[0] ?? '').includes('points ahead of its pace line.'), result.lines[0]);
      assert.ok((result.lines[0] ?? '').includes(text), result.lines[0]);
      assert.equal(result.leadLine !== undefined, tellsLead);
      assert.equal(result.state.leadTold, tellsLead);
    });
  }

  it('escalates on the session alone with escalate "session"', () => {
    const result = stopWarning(facts(1.1, BEHIND), { ...BUDGET, escalate: 'session' }, undefined);
    assert.match(result.lines[0] ?? '', /Team: 10\.0% used.*The lead has an inbox line\./);
    assert.ok(result.leadLine !== undefined);
  });

  it('tells the lead once a day, naming the lift command', () => {
    const first = stopWarning(facts(1.1, AHEAD), BUDGET, undefined);
    assert.match(first.leadLine ?? '', /^alpha is past its daily budget: 1\.1% of the week today against 1\.0%, and the team is 18\.0 points ahead .*teamrig budget lift alpha --to <pct> --stop-pct <pct>/);
    const later = stopWarning(facts(1.6, AHEAD), BUDGET, first.state);
    assert.equal(later.leadLine, undefined);
    assert.equal(later.lines.length, 1);
  });

  it('never tells the lead about itself', () => {
    const result = stopWarning(facts(1.1, AHEAD, DAY, { isLead: true }), BUDGET, undefined);
    assert.equal(result.leadLine, undefined);
    assert.ok(!(result.lines[0] ?? '').includes('inbox line'));
  });

  it('shows the team moving ahead while the session is past budget, once', () => {
    const behind = stopWarning(facts(1.1, BEHIND), BUDGET, undefined);
    const ahead = stopWarning(facts(1.1, AHEAD), BUDGET, behind.state);
    assert.equal(ahead.lines.length, 1);
    assert.match(ahead.lines[0] ?? '', /^Budget: alpha is past its daily budget, and the team is \d+\.\d points ahead of its pace line\. The lead has an inbox line\./);
    assert.ok(ahead.leadLine !== undefined);
    assert.equal(stopWarning(facts(1.1, AHEAD), BUDGET, ahead.state).lines.length, 0);
  });

  it('shows the quiet hours once per night, and not under a lift', () => {
    const night = stopWarning(facts(0, BEHIND, NIGHT), BUDGET, undefined);
    assert.deepEqual(night.lines, ['Quiet hours (22:00-06:00 UTC): new helpers ask first. More: teamrig budget']);
    const afterMidnight = stopWarning(facts(0, BEHIND, Date.parse('2026-10-16T01:00:00Z')), BUDGET, night.state);
    assert.deepEqual(afterMidnight.lines, []);
    const lifted = stopWarning(facts(0, BEHIND, NIGHT, { lift: lift({ endsAt: NIGHT + 3_600_000 }) }), BUDGET, undefined);
    assert.ok(lifted.lines.every((line) => !line.startsWith('Quiet hours')));
  });

  it('says only that the team rests when quiet hours do not hold helpers back', () => {
    const result = stopWarning(facts(0, BEHIND, NIGHT), { ...BUDGET, quietHours: { ...QUIET, action: 'warn' } }, undefined);
    assert.deepEqual(result.lines, ['Quiet hours (22:00-06:00 UTC): the team rests; start no new work. More: teamrig budget']);
  });

  it('shows a lift starting and ending', () => {
    const lifted = stopWarning(facts(0.5, AHEAD, DAY, { lift: lift(), budgetPct: 2 }), BUDGET, undefined);
    assert.match(lifted.lines[0] ?? '', /^Budget: the lead lifted alpha to 2\.0% today until .* or 97\.0% of the week/);
    assert.equal(lifted.state.liftAt, lift().at);
    const ended = stopWarning(facts(0.5, AHEAD), BUDGET, lifted.state);
    assert.deepEqual(ended.lines, ["Budget: alpha's lift has ended; its daily budget is 1.0% again."]);
    assert.equal(ended.state.liftAt, undefined);
  });

  it('counts any use past a budget of 0', () => {
    const result = stopWarning(facts(0.01, AHEAD, DAY, { budgetPct: 0 }), BUDGET, undefined);
    assert.equal(result.state.level, 100);
    assert.ok(result.leadLine !== undefined);
  });
});

describe('promptWarning', () => {
  it('tells the model once per level while escalated, never to skip a check', () => {
    const first = promptWarning(facts(1.1, AHEAD), BUDGET, undefined);
    assert.equal(
      first.line,
      "teamrig budget: you are past today's budget and the team is ahead of its pace line. Finish the step in hand and start no new work items or helpers. " +
        'Never skip a test or check to save budget. The lead can lift it.',
    );
    assert.equal(promptWarning(facts(1.2, AHEAD), BUDGET, first.state).line, undefined);
    assert.ok(promptWarning(facts(1.3, AHEAD), BUDGET, first.state).line !== undefined);
  });

  it('says nothing under budget or while the team is not ahead', () => {
    assert.equal(promptWarning(facts(0.9, AHEAD), BUDGET, undefined).line, undefined);
    assert.equal(promptWarning(facts(1.5, BEHIND), BUDGET, undefined).line, undefined);
  });

  it('tells the lead to lift itself only with a stop %', () => {
    assert.match(promptWarning(facts(1.1, AHEAD, DAY, { isLead: true }), BUDGET, undefined).line ?? '', /As the lead, lift it only with a stop %\.$/);
  });

  it('keeps the stop marks it did not change', () => {
    const state: WarnState = { ...emptyWarnState('2026-10-15'), level: 100, leadTold: true, ahead: true };
    const result = promptWarning(facts(1.1, AHEAD), BUDGET, state);
    assert.deepEqual(result.state, { ...state, modelLevel: 100 });
  });
});

describe('helperGate', () => {
  const table: readonly [string, OverAction, number, number, string][] = [
    ['under budget by day', 'ask', 0.5, DAY, 'allow'],
    ['past budget, the team behind', 'block', 1.5, DAY, 'allow'],
    ['ask-lead past budget', 'ask-lead', 1.5, DAY, 'allow'],
    ['ask past budget', 'ask', 1.5, DAY, 'ask'],
    ['block past budget', 'block', 1.5, DAY, 'deny'],
    ['quiet hours, under budget', 'ask-lead', 0.5, NIGHT, 'ask'],
    ['quiet hours with block past budget', 'block', 1.5, NIGHT, 'deny'],
  ];
  for (const [what, overAction, used, now, kind] of table) {
    it(`${kind}s a helper: ${what}`, () => {
      const week = what.includes('behind') ? BEHIND : AHEAD;
      assert.equal(helperGate(facts(used, week, now), { ...BUDGET, overAction }).kind, kind);
    });
  }

  it('gives the reasons and the way out', () => {
    const gate = helperGate(facts(1.5, AHEAD, NIGHT), { ...BUDGET, overAction: 'ask' });
    if (gate.kind !== 'ask') {
      assert.fail(`expected ask, got ${gate.kind}`);
    }
    assert.match(
      gate.reason,
      /^teamrig budget: alpha is past its daily budget \(1\.5% of the week today against 1\.0%\) and the team is 12\.6 points ahead of its pace line\. It is quiet hours \(22:00-06:00 UTC\)\. New helpers ask first; the lead can lift it\. More: teamrig budget$/,
    );
  });

  it('lets the lead and a lifted session launch helpers, even at night', () => {
    const budget: WarnBudget = { ...BUDGET, overAction: 'block', quietHours: { ...QUIET, action: 'block' } };
    assert.equal(helperGate(facts(5, AHEAD, NIGHT, { isLead: true }), budget).kind, 'allow');
    assert.equal(helperGate(facts(5, AHEAD, NIGHT, { lift: lift({ endsAt: NIGHT + 3_600_000 }) }), budget).kind, 'allow');
  });

  it('holds nothing back without quiet hours', () => {
    assert.equal(helperGate(facts(0.5, AHEAD, NIGHT), DAYTIME).kind, 'allow');
  });
});
