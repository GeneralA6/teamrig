import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { OverAction } from '../config/types.ts';
import { TimeZone } from '../core/zone.ts';
import { JERUSALEM } from '../testing/zone.ts';
import type { Burst } from './burst.ts';
import type { SurplusHint } from './burst-lines.ts';
import type { Lift } from './lift.ts';
import { DailyProfile } from './active-time.ts';
import { readPace, weekWindow, type PaceBudget, type TeamDay } from './pace.ts';
import { emptyWarnState, helperGate, isHeld, isPastDailyBudget, levelOf, promptWarning, quietSpanOf, sessionQuietSpan, stopWarning, type BudgetFacts, type BudgetLeader, type WarnBudget, type WarnState } from './warn.ts';

const RESET = Date.parse('2026-10-21T01:00:00Z');
const WINDOW = weekWindow(RESET, 1);
const PACE: PaceBudget = { targetPct: 99.5, paceEndHoursBeforeReset: 1, paceTolerancePct: 0.5 };
/** Thursday 2026-10-15 14:00 UTC: the pace line is at 22.0%. */
const DAY = Date.parse('2026-10-15T14:00:00Z');
const NIGHT = Date.parse('2026-10-15T23:00:00Z');
const QUIET = { startUtc: '22:00', endUtc: '06:00', action: 'ask' } as const;

const DAYTIME: WarnBudget = { warnAtPct: [80, 100], overAction: 'ask-lead', escalate: 'session-and-fleet' };
const BUDGET: WarnBudget = { ...DAYTIME, quietHours: QUIET };

/** The team at its in-day pace, so a session past its part is held; and below it, so none is. */
const NO_ROOM: TeamDay = { usedPct: 5, pacePct: 5 };
const ROOM: TeamDay = { usedPct: 2, pacePct: 5 };

/** The team's lead as a session's leader, and a sub-lead that leads alpha. */
const LEAD: BudgetLeader = { id: 'lead', name: 'lead', isLead: true };
const SUB_LEAD: BudgetLeader = { id: 'bravo', name: 'app-bravo', isLead: false };

/** A session at `usedTodayPct` of a 1% daily budget, with the week `weekUsedPct` used at `now` and no room today; 10M W make 1%. */
function facts(usedTodayPct: number, weekUsedPct: number, now = DAY, extra: Partial<BudgetFacts> = {}): BudgetFacts {
  return {
    now,
    id: 'alpha',
    name: 'alpha',
    usedTodayPct,
    todayWPerPct: 10_000_000,
    budgetPct: 1,
    lift: undefined,
    liftBy: undefined,
    liftParent: undefined,
    burst: undefined,
    paused: false,
    surplus: undefined,
    weekUsedPct,
    pace: readPace(WINDOW, PACE, now, weekUsedPct, DailyProfile.even()),
    teamDay: NO_ROOM,
    isLead: false,
    urgent: [],
    leader: LEAD,
    zone: TimeZone.UTC,
    ...extra,
  };
}

/** Behind the pace line and ahead of it at `DAY`. */
const BEHIND = 10;
const AHEAD = 40;

function lift(overrides: Partial<Lift> = {}): Lift {
  return {
    session: 'alpha',
    partPct: 40,
    stopPct: 97,
    endsAt: Date.parse('2026-10-15T23:59:00Z'),
    reserve: false,
    group: false,
    quietHoursExempt: true,
    reason: 'incident',
    by: 'lead',
    at: Date.parse('2026-10-15T12:00:00Z'),
    ...overrides,
  };
}

function burst(overrides: Partial<Burst> = {}): Burst {
  return {
    kind: 'surplus',
    sessions: ['alpha'],
    helpers: 2,
    hires: 0,
    dailyPct: 3,
    stopPct: 99.5,
    endsAt: Date.parse('2026-10-21T00:00:00Z'),
    tasks: [],
    reason: 'surplus',
    by: 'lead',
    at: Date.parse('2026-10-15T12:00:00Z'),
    ...overrides,
  };
}

const HINT: SurplusHint = { sparePct: 12, accountSparePct: undefined, paceEnd: Date.parse('2026-10-21T00:00:00Z'), reset: RESET, ownerAsk: 'the owner' };

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

/** The quiet hours of the night of 10-15: 22:00 to 06:00 UTC. */
const QUIET_NIGHT = { from: Date.parse('2026-10-15T22:00:00Z'), to: Date.parse('2026-10-16T06:00:00Z') };

describe('quietSpanOf', () => {
  it('finds the quiet hours that cross midnight, on either side of it', () => {
    assert.deepEqual(quietSpanOf(QUIET, NIGHT), QUIET_NIGHT);
    assert.deepEqual(quietSpanOf(QUIET, Date.parse('2026-10-16T05:59:00Z')), QUIET_NIGHT);
    assert.equal(quietSpanOf(QUIET, Date.parse('2026-10-16T06:00:00Z')), undefined);
    assert.equal(quietSpanOf(QUIET, DAY), undefined);
  });

  it('finds quiet hours within one day, and none for unset, equal or malformed hours', () => {
    const lunch = { startUtc: '12:00', endUtc: '15:00', action: 'ask' } as const;
    assert.deepEqual(quietSpanOf(lunch, DAY), { from: Date.parse('2026-10-15T12:00:00Z'), to: Date.parse('2026-10-15T15:00:00Z') });
    assert.equal(quietSpanOf(undefined, DAY), undefined);
    assert.equal(quietSpanOf({ ...lunch, endUtc: '12:00' }, DAY), undefined);
    assert.equal(quietSpanOf({ ...lunch, startUtc: '25:00' }, DAY), undefined);
  });
});

describe('isPastDailyBudget and sessionQuietSpan', () => {
  it('is past budget only above 100% of it, and any use is past a budget of 0', () => {
    assert.equal(isPastDailyBudget(facts(1, BEHIND)), false);
    assert.equal(isPastDailyBudget(facts(1.01, BEHIND)), true);
    assert.equal(isPastDailyBudget(facts(0, BEHIND, DAY, { budgetPct: 0 })), false);
    assert.equal(isPastDailyBudget(facts(0.01, BEHIND, DAY, { budgetPct: 0 })), true);
  });

  it('holds a session past its budget only while the team has no room today', () => {
    assert.equal(isHeld(facts(1.1, BEHIND)), true);
    assert.equal(isHeld(facts(1.1, AHEAD, DAY, { teamDay: ROOM })), false);
    assert.equal(isHeld(facts(1, AHEAD)), false);
  });

  it('counts a turn about to start as spent, so a session with less left than that turn is held before it (T1322)', () => {
    assert.equal(isHeld(facts(0.95, BEHIND)), false);
    assert.equal(isHeld(facts(0.95, BEHIND), 0.1), true);
    assert.equal(isHeld(facts(0, BEHIND, DAY, { budgetPct: 0 })), false);
    assert.equal(isHeld(facts(0, BEHIND, DAY, { budgetPct: 0 }), 0.01), true);
    assert.equal(isHeld(facts(0.95, AHEAD, DAY, { teamDay: ROOM }), 0.1), false);
  });

  it('holds a session past its budget when the turn about to start spends the team room left (T1322)', () => {
    // Seconds after the quiet hours end the in-day pace is the night's use and a hair more.
    const dayStart: TeamDay = { usedPct: 0.9, pacePct: 0.9005 };
    assert.equal(isHeld(facts(1.1, AHEAD, DAY, { teamDay: dayStart })), false);
    assert.equal(isHeld(facts(1.1, AHEAD, DAY, { teamDay: dayStart }), 0.003), true);
    assert.equal(isHeld(facts(0.5, AHEAD, DAY, { teamDay: dayStart }), 0.003), false);
    assert.equal(isHeld(facts(1.1, AHEAD, DAY, { teamDay: ROOM }), 0.003), false);
  });

  it('finds the quiet hours the session is in, unless its lift exempts it', () => {
    assert.deepEqual(sessionQuietSpan(facts(0, BEHIND, NIGHT), QUIET), QUIET_NIGHT);
    assert.equal(sessionQuietSpan(facts(0, BEHIND, NIGHT, { lift: lift() }), QUIET), undefined);
    assert.deepEqual(sessionQuietSpan(facts(0, BEHIND, NIGHT, { lift: lift({ quietHoursExempt: false }) }), QUIET), QUIET_NIGHT);
    assert.equal(sessionQuietSpan(facts(0, BEHIND, DAY), QUIET), undefined);
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

  it('only tells a held session that nothing more happens while the team is not ahead', () => {
    const result = stopWarning(facts(1.1, BEHIND), BUDGET, undefined);
    assert.match(result.lines[0] ?? '', /Team: 10\.0% used, pace line 22\.0%\. The team has used 5\.0% of the week today, at or past its in-day pace of 5\.0%, but the team is not ahead of its pace line, so nothing more happens\./);
    assert.equal(result.leadLine, undefined);
    assert.equal(result.state.leadTold, false);
    assert.equal(result.state.held, true);
  });

  it('never escalates a session past its budget while the team has room today', () => {
    const result = stopWarning(facts(1.1, AHEAD, DAY, { teamDay: ROOM }), { ...BUDGET, overAction: 'block' }, undefined);
    assert.match(result.lines[0] ?? '', /^Budget: alpha has used 1\.1% of the week today; its daily budget is 1\.0%\. The team has room today: 2\.0% of the week used, below its in-day pace of 5\.0%, so nothing more happens\. More: teamrig budget$/);
    assert.equal(result.leadLine, undefined);
    assert.equal(result.state.held, false);
  });

  it("escalates once the team's room for the day runs out, with no new level", () => {
    const room = stopWarning(facts(1.1, AHEAD, DAY, { teamDay: ROOM }), BUDGET, undefined);
    const none = stopWarning(facts(1.1, AHEAD), BUDGET, room.state);
    assert.deepEqual(none.lines, [
      'Budget: alpha is past its daily budget, and the team has used 5.0% of the week today, at or past its in-day pace of 5.0%, and the team is 18.0 points ahead of its pace line. The lead has an inbox line. More: teamrig budget',
    ]);
    assert.ok(none.leadLine !== undefined);
    assert.equal(stopWarning(facts(1.1, AHEAD), BUDGET, none.state).lines.length, 0);
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

  it('escalates on the session alone with escalate "session", never naming a pace gap the team is behind', () => {
    const result = stopWarning(facts(1.1, BEHIND), { ...BUDGET, escalate: 'session' }, undefined);
    assert.match(result.lines[0] ?? '', /The team has used 5\.0% of the week today, at or past its in-day pace of 5\.0%\. The lead has an inbox line\./);
    assert.match(result.leadLine ?? '', /against 1\.0%, and the team has used 5\.0% of the week today, at or past its in-day pace of 5\.0%\. It finishes/);
    assert.ok(!(result.leadLine ?? '').includes('points'), result.leadLine);
  });

  it('tells the lead once a day, naming the lift command', () => {
    const first = stopWarning(facts(1.1, AHEAD), BUDGET, undefined);
    assert.match(
      first.leadLine ?? '',
      /^alpha is past its daily budget: 1\.1% of the week today against 1\.0%, and the team has used 5\.0% of the week today, at or past its in-day pace of 5\.0%, and the team is 18\.0 points ahead .*teamrig budget lift alpha --part <pct> --stop-pct <pct>/,
    );
    const later = stopWarning(facts(1.6, AHEAD), BUDGET, first.state);
    assert.equal(later.leadLine, undefined);
    assert.equal(later.lines.length, 1);
  });

  it("names a sub-lead's member's own leader, whose line has it lift the session itself", () => {
    const result = stopWarning(facts(1.1, AHEAD, DAY, { leader: SUB_LEAD }), BUDGET, undefined);
    assert.match(result.lines[0] ?? '', /Its leader app-bravo has an inbox line\./);
    assert.ok(!(result.lines[0] ?? '').includes('the lead has'), result.lines[0]);
    assert.match(result.leadLine ?? '', /It finishes the step in hand; lift it only with a stop %: teamrig budget lift alpha --part <pct> --stop-pct <pct> --reason "<why>"\.$/);
  });

  it('tells the person and the leader that p0 work goes on past the stop, helpers too', () => {
    const result = stopWarning(facts(1.1, AHEAD, DAY, { urgent: ['T5', 'T7'] }), { ...BUDGET, overAction: 'block' }, undefined);
    assert.match(result.lines[0] ?? '', /Its p0 work \(T5, T7\) goes on past the stop, helpers too; the lead has an inbox line\./);
    assert.ok(!(result.lines[0] ?? '').includes('refused'), result.lines[0]);
    assert.match(result.leadLine ?? '', /It goes on with its p0 work \(T5, T7\) past the stop; lift it only with a stop %: teamrig budget lift alpha /);
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
    assert.match(ahead.lines[0] ?? '', /^Budget: alpha is past its daily budget, and the team has used 5\.0% .*, and the team is \d+\.\d points ahead of its pace line\. The lead has an inbox line\./);
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

  it("shows the quiet hours on the team's clock", () => {
    assert.deepEqual(stopWarning(facts(0, BEHIND, NIGHT, { zone: JERUSALEM }), BUDGET, undefined).lines, ['Quiet hours (01:00-09:00 IDT): new helpers ask first. More: teamrig budget']);
  });

  it('shows a lift starting and ending', () => {
    const lifted = stopWarning(facts(0.5, AHEAD, DAY, { lift: lift(), liftBy: 'commander', budgetPct: 2 }), BUDGET, undefined);
    assert.match(lifted.lines[0] ?? '', /^Budget: commander lifted alpha to 40\.0% of the team's daily budget today until .* or 97\.0% of the week/);
    assert.equal(lifted.state.liftAt, lift().at);
    const ended = stopWarning(facts(0.5, AHEAD), BUDGET, lifted.state);
    assert.deepEqual(ended.lines, ["Budget: alpha's lift has ended; its daily budget is 1.0% again."]);
    assert.equal(ended.state.liftAt, undefined);
  });

  it("names the sub-lead that lifted the session and whose group's daily budget the lift is a part of", () => {
    const lifted = stopWarning(facts(0.5, AHEAD, DAY, { lift: lift({ by: 'bravo' }), liftBy: 'app-bravo', liftParent: 'app-bravo', budgetPct: 2, leader: SUB_LEAD }), BUDGET, undefined);
    assert.match(lifted.lines[0] ?? '', /^Budget: app-bravo lifted alpha to 40\.0% of app-bravo's group's daily budget today /);
  });

  it('marks the budget of a session a short day pauses', () => {
    const paused = stopWarning(facts(0.5, AHEAD, DAY, { budgetPct: 0, paused: true }), BUDGET, undefined);
    assert.match(paused.lines.join('\n'), /its daily budget is 0\.0% \(paused\)\./);
  });

  it('shows a burst starting and ending, and marks the budget it sets', () => {
    const started = stopWarning(facts(2.5, AHEAD, DAY, { burst: burst(), budgetPct: 3 }), BUDGET, undefined);
    assert.match(started.lines[0] ?? '', /^Budget: the lead started a surplus burst until Wed 10-21 00:00 UTC or 99\.5% of the week: alpha's daily budget is at least 3\.0%/);
    assert.match(started.lines[1] ?? '', /its daily budget is 3\.0% \(burst\)\./);
    assert.equal(started.state.burstAt, burst().at);
    const ended = stopWarning(facts(0.5, AHEAD), BUDGET, started.state);
    assert.deepEqual(ended.lines, ["Budget: alpha's burst has ended; its daily budget is 1.0% again."]);
    assert.equal(ended.state.burstAt, undefined);
  });

  it('keeps the burst and surplus marks across midnight, and the model marks it did not change', () => {
    const state: WarnState = { ...emptyWarnState('2026-10-14'), level: 100, burstAt: 5, modelBurstAt: 5, surplusShown: RESET };
    const next = stopWarning(facts(0, BEHIND, DAY, { burst: burst({ at: 5 }) }), BUDGET, state);
    assert.deepEqual(next.lines, []);
    assert.deepEqual(next.state, { ...emptyWarnState('2026-10-15'), burstAt: 5, modelBurstAt: 5, surplusShown: RESET });
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
      "teamrig budget: you are past today's budget and the team has no room left today, and it is ahead of its pace line. Finish the step in hand and start no new work items or helpers. " +
        'Never skip a test or check to save budget. The lead can lift it.',
    );
    assert.equal(promptWarning(facts(1.2, AHEAD), BUDGET, first.state).line, undefined);
    assert.ok(promptWarning(facts(1.3, AHEAD), BUDGET, first.state).line !== undefined);
  });

  it("tells a sub-lead's member that its own leader can lift it", () => {
    assert.match(promptWarning(facts(1.1, AHEAD, DAY, { leader: SUB_LEAD }), BUDGET, undefined).line ?? '', /Never skip a test or check to save budget\. Your leader app-bravo can lift it\.$/);
  });

  it('says nothing under budget, while the team is not ahead or while it has room today', () => {
    assert.equal(promptWarning(facts(0.9, AHEAD), BUDGET, undefined).line, undefined);
    assert.equal(promptWarning(facts(1.5, BEHIND), BUDGET, undefined).line, undefined);
    assert.equal(promptWarning(facts(1.5, AHEAD, DAY, { teamDay: ROOM }), BUDGET, undefined).line, undefined);
  });

  it('tells the model its p0 work goes on past the daily stop', () => {
    assert.match(
      promptWarning(facts(1.1, AHEAD, DAY, { urgent: ['T5'] }), BUDGET, undefined).line ?? '',
      /Finish the step in hand and start no new work items or helpers, except your p0 work \(T5\): it goes on past the daily stop\. Never skip a test/,
    );
  });

  it('tells the lead to lift itself only with a stop %', () => {
    assert.match(promptWarning(facts(1.1, AHEAD, DAY, { isLead: true }), BUDGET, undefined).line ?? '', /As the lead, lift it only with a stop %\.$/);
  });

  it('gives the burst lines and the past-budget line together, one per line, and marks each', () => {
    const result = promptWarning(facts(1.1, AHEAD, DAY, { burst: burst() }), BUDGET, undefined);
    const lines = (result.line ?? '').split('\n');
    assert.equal(lines.length, 2);
    assert.match(lines[0] ?? '', /^teamrig burst: a surplus burst runs until/);
    assert.match(lines[1] ?? '', /^teamrig budget: you are past today's budget/);
    assert.equal(result.state.modelBurstAt, burst().at);
    assert.equal(result.state.modelLevel, 100);
  });

  it('gives a burst line alone, leaving the warning level as it was', () => {
    const result = promptWarning(facts(0.1, BEHIND, DAY, { isLead: true, surplus: HINT }), BUDGET, undefined);
    assert.match(result.line ?? '', /^teamrig burst: about 12\.0% of the week is projected unused/);
    assert.equal(result.state.modelLevel, 0);
    assert.equal(result.state.surplusShown, RESET);
    assert.equal(promptWarning(facts(0.1, BEHIND, DAY, { isLead: true, surplus: HINT }), BUDGET, result.state).line, undefined);
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

  it("gives the quiet hours on the team's clock", () => {
    const gate = helperGate(facts(1.5, AHEAD, NIGHT, { zone: JERUSALEM }), { ...BUDGET, overAction: 'ask' });
    assert.match(gate.kind === 'ask' ? gate.reason : gate.kind, /It is quiet hours \(01:00-09:00 IDT\)\./);
  });

  it('gives the reasons and the way out', () => {
    const gate = helperGate(facts(1.5, AHEAD, NIGHT), { ...BUDGET, overAction: 'ask' });
    if (gate.kind !== 'ask') {
      assert.fail(`expected ask, got ${gate.kind}`);
    }
    assert.match(
      gate.reason,
      /^teamrig budget: alpha is past its daily budget \(1\.5% of the week today against 1\.0%\), and the team has used 5\.0% of the week today, at or past its in-day pace of 5\.0%, and the team is 12\.6 points ahead of its pace line\. It is quiet hours \(22:00-06:00 UTC\)\. New helpers ask first; the lead can lift it\. More: teamrig budget$/,
    );
  });

  it("names a sub-lead's member's own leader as the one who can lift it", () => {
    const gate = helperGate(facts(1.5, AHEAD, DAY, { leader: SUB_LEAD }), { ...BUDGET, overAction: 'block' });
    assert.match(gate.kind === 'deny' ? gate.reason : gate.kind, /New helpers are refused; its leader app-bravo can lift it\. More: teamrig budget$/);
  });

  it('lets a session past its budget launch helpers while the team has room today', () => {
    assert.equal(helperGate(facts(1.5, AHEAD, DAY, { teamDay: ROOM }), { ...BUDGET, overAction: 'block' }).kind, 'allow');
  });

  it('lets the lead and a lifted session launch helpers, even at night', () => {
    const budget: WarnBudget = { ...BUDGET, overAction: 'block', quietHours: { ...QUIET, action: 'block' } };
    assert.equal(helperGate(facts(5, AHEAD, NIGHT, { isLead: true }), budget).kind, 'allow');
    assert.equal(helperGate(facts(5, AHEAD, NIGHT, { lift: lift({ endsAt: NIGHT + 3_600_000 }) }), budget).kind, 'allow');
  });

  it('lets a session with p0 work launch helpers past its budget and in quiet hours', () => {
    const budget: WarnBudget = { ...BUDGET, overAction: 'block', quietHours: { ...QUIET, action: 'block' } };
    assert.equal(helperGate(facts(5, AHEAD, NIGHT), budget).kind, 'deny');
    assert.equal(helperGate(facts(5, AHEAD, DAY, { urgent: ['T5'] }), budget).kind, 'allow');
    assert.equal(helperGate(facts(5, AHEAD, NIGHT, { urgent: ['T5'] }), budget).kind, 'allow');
  });

  it('holds nothing back without quiet hours', () => {
    assert.equal(helperGate(facts(0.5, AHEAD, NIGHT), DAYTIME).kind, 'allow');
  });
});
