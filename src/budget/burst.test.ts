import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_BURST } from '../config/defaults.ts';
import { TimeZone } from '../core/zone.ts';
import { JERUSALEM } from '../testing/zone.ts';
import type { BurstConfig } from '../config/types.ts';
import {
  activeBurst,
  burstDailyPct,
  burstsOver,
  decideBurst,
  isBurst,
  isBurstKind,
  isBurstOver,
  surplusOf,
  withBurst,
  type Burst,
  type BurstContext,
  type BurstDecision,
  type BurstEnd,
  type BurstRequest,
} from './burst.ts';
import { weekWindow } from './pace.ts';

const HOUR = 3_600_000;
/** The week's reset, Wednesday 01:00 UTC; its pace line ends an hour before, at midnight. */
const RESET = Date.parse('2030-01-09T01:00:00Z');
const PACE_END = Date.parse('2030-01-09T00:00:00Z');
const WINDOW = weekWindow(RESET, 1);
/** Tuesday 10:00 UTC: 153 hours into the week, 14 before the pace end, inside the 48-hour surplus window. */
const NOW = Date.parse('2030-01-08T10:00:00Z');
const OWNER: BurstConfig = { ...DEFAULT_BURST, policy: 'owner' };

const REQUEST: BurstRequest = {
  kind: 'surplus',
  sessions: ['alpha', 'bravo'],
  helpers: undefined,
  hires: undefined,
  stopPct: undefined,
  deadline: undefined,
  tasks: [],
  reason: 'week-end surplus',
  approvedBy: 'owner',
  by: 'lead',
  now: NOW,
};
const CONTEXT: BurstContext = { usedPct: 60, window: WINDOW, targetPct: 99.5, config: OWNER, active: undefined, zone: TimeZone.UTC };
const DUE = Date.parse('2030-01-08T20:00:00Z');
const DEADLINE: BurstRequest = { ...REQUEST, kind: 'deadline', stopPct: 80, deadline: DUE, tasks: ['T1', 'T2'] };

function refusal(decision: BurstDecision): string {
  assert.equal(decision.kind, 'refused');
  return decision.kind === 'refused' ? decision.reason : '';
}

function given(decision: BurstDecision): Burst {
  assert.equal(decision.kind, 'burst', decision.kind === 'refused' ? decision.reason : '');
  if (decision.kind !== 'burst') {
    throw new Error('refused');
  }
  return decision.burst;
}

function burst(overrides: Partial<Burst> = {}): Burst {
  return {
    kind: 'surplus',
    sessions: ['alpha', 'bravo'],
    helpers: 3,
    hires: 0,
    dailyPct: 19.75,
    stopPct: 99.5,
    endsAt: PACE_END,
    tasks: [],
    reason: 'week-end surplus',
    approvedBy: 'owner',
    by: 'lead',
    at: NOW,
    ...overrides,
  };
}

function end(burstAt: number, at: number): BurstEnd {
  return { kind: 'end', burstAt, reason: 'done early', by: 'lead', at };
}

describe('surplusOf', () => {
  const input = { window: WINDOW, now: NOW, usedPct: 60, targetPct: 99.5, config: DEFAULT_BURST };

  it("projects the week's mean rate so far to the pace end and measures what the target leaves", () => {
    const surplus = surplusOf(input);
    assert.ok(surplus !== undefined);
    assert.equal(surplus.reset, RESET);
    assert.equal(surplus.paceEnd, PACE_END);
    assert.equal(surplus.opensAt, RESET - 48 * HOUR);
    assert.ok(Math.abs(surplus.projectedPct - (60 + (60 / 153) * 14)) < 1e-9);
    assert.ok(Math.abs(surplus.sparePct - (99.5 - surplus.projectedPct)) < 1e-9);
    assert.equal(surplus.open, true);
    assert.equal(surplus.worth, true);
  });

  it('opens burst.surplusHours before the reset and closes at the pace end', () => {
    assert.equal(surplusOf({ ...input, now: RESET - 48 * HOUR - 1 })?.open, false);
    assert.equal(surplusOf({ ...input, now: RESET - 48 * HOUR })?.open, true);
    assert.equal(surplusOf({ ...input, now: PACE_END - 1 })?.open, true);
    const late = surplusOf({ ...input, now: PACE_END });
    assert.equal(late?.open, false);
    assert.equal(late?.worth, false);
    assert.equal(late?.projectedPct, 60);
  });

  it('is not worth a burst below burst.minSparePct, and spares nothing when the projection passes the target', () => {
    const tight = surplusOf({ ...input, usedPct: 88 });
    assert.ok(tight !== undefined && tight.sparePct > 0 && tight.sparePct < 5);
    assert.equal(tight.worth, false);
    assert.equal(surplusOf({ ...input, usedPct: 95 })?.sparePct, 0);
  });

  it("is undefined at the week's very start, which has no rate yet", () => {
    assert.equal(surplusOf({ ...input, now: WINDOW.start }), undefined);
  });
});

describe('decideBurst', () => {
  it('starts a surplus burst until the pace end, for the whole of what the target leaves', () => {
    assert.deepEqual(given(decideBurst(REQUEST, CONTEXT)), burst());
  });

  it('starts a deadline burst for its tasks until the deadline or the reset, whichever comes first', () => {
    const started = given(decideBurst(DEADLINE, CONTEXT));
    assert.deepEqual(started, burst({ kind: 'deadline', stopPct: 80, endsAt: DUE, deadline: DUE, tasks: ['T1', 'T2'], dailyPct: 10 }));
    const late = Date.parse('2030-01-09T06:00:00Z');
    assert.equal(given(decideBurst({ ...DEADLINE, deadline: late }, CONTEXT)).endsAt, RESET);
  });

  it('a deadline burst may start any time in the week, outside the surplus window too', () => {
    const early = Date.parse('2030-01-03T10:00:00Z');
    assert.equal(given(decideBurst({ ...DEADLINE, now: early, deadline: early + 10 * HOUR }, CONTEXT)).endsAt, early + 10 * HOUR);
  });

  it('takes the caps and stop % given, within the team caps', () => {
    const started = given(decideBurst({ ...REQUEST, helpers: 1, hires: 2, stopPct: 90, approvedBy: '  owner  ' }, CONTEXT));
    assert.equal(started.helpers, 1);
    assert.equal(started.hires, 2);
    assert.equal(started.stopPct, 90);
    assert.equal(started.approvedBy, 'owner');
    assert.equal(given(decideBurst({ ...REQUEST, helpers: 0, hires: 1 }, CONTEXT)).helpers, 0);
  });

  it('follows burst.policy: off refuses, owner needs --approved-by, lead needs nobody', () => {
    assert.match(refusal(decideBurst(REQUEST, { ...CONTEXT, config: { ...OWNER, policy: 'off' } })), /burst\.policy is off/);
    assert.match(refusal(decideBurst({ ...REQUEST, approvedBy: undefined }, CONTEXT)), /burst\.policy is owner: .*--approved-by/);
    assert.match(refusal(decideBurst({ ...REQUEST, approvedBy: ' ' }, CONTEXT)), /burst\.policy is owner/);
    const byLead = given(decideBurst({ ...REQUEST, approvedBy: undefined }, { ...CONTEXT, config: { ...OWNER, policy: 'lead' } }));
    assert.equal(byLead.approvedBy, undefined);
    assert.equal('approvedBy' in byLead, false);
  });

  it('refuses a burst without a reason or sessions, or while another runs', () => {
    assert.match(refusal(decideBurst({ ...REQUEST, reason: ' ' }, CONTEXT)), /needs --reason/);
    assert.match(refusal(decideBurst({ ...REQUEST, sessions: [] }, CONTEXT)), /at least one session/);
    assert.match(refusal(decideBurst(REQUEST, { ...CONTEXT, active: burst() })), /a surplus burst runs until Wed 01-09 00:00 UTC or 99\.5% of the week; end it first/);
  });

  it('refuses helpers or hires above the team caps, and a burst that adds neither', () => {
    assert.match(refusal(decideBurst({ ...REQUEST, helpers: 4 }, CONTEXT)), /--helpers 4 is above burst\.maxHelpers \(3\)/);
    assert.match(refusal(decideBurst({ ...REQUEST, hires: 3 }, CONTEXT)), /--hires 3 is above burst\.maxHires \(2\)/);
    assert.match(refusal(decideBurst({ ...REQUEST, helpers: 0 }, CONTEXT)), /adds nothing/);
  });

  it("refuses when the week's use or reset is unknown", () => {
    assert.match(refusal(decideBurst(REQUEST, { ...CONTEXT, usedPct: undefined })), /use or reset is unknown/);
    assert.match(refusal(decideBurst(REQUEST, { ...CONTEXT, window: undefined })), /use or reset is unknown/);
  });

  it('never spends the reserve, and refuses a week already at the stop %', () => {
    assert.match(refusal(decideBurst({ ...REQUEST, stopPct: 99.6 }, CONTEXT)), /above budget\.targetPct \(99\.5\): a burst never spends the reserve/);
    assert.match(refusal(decideBurst({ ...REQUEST, stopPct: 60 }, CONTEXT)), /already at or past the stop % 60/);
  });

  it('refuses a surplus burst outside its window, or with too little projected unused', () => {
    assert.match(refusal(decideBurst({ ...REQUEST, now: RESET - 49 * HOUR }, CONTEXT)), /starts only from Mon 01-07 01:00 UTC \(burst\.surplusHours 48/);
    assert.match(refusal(decideBurst({ ...REQUEST, now: RESET - 49 * HOUR }, { ...CONTEXT, zone: JERUSALEM })), /starts only from Mon 01-07 03:00 IST \(/);
    assert.match(refusal(decideBurst({ ...REQUEST, now: PACE_END }, CONTEXT)), /starts only from/);
    assert.match(refusal(decideBurst(REQUEST, { ...CONTEXT, usedPct: 88 })), /projected unused at the pace end, below burst\.minSparePct \(5\.0%\)/);
  });

  it('refuses a deadline burst without a stop %, a deadline in the future or its tasks', () => {
    assert.match(refusal(decideBurst({ ...DEADLINE, stopPct: undefined }, CONTEXT)), /needs --stop-pct/);
    assert.match(refusal(decideBurst({ ...DEADLINE, deadline: undefined }, CONTEXT)), /needs --by <time>/);
    assert.match(refusal(decideBurst({ ...DEADLINE, deadline: NOW }, CONTEXT)), /--by 2030-01-08 10:00 UTC has passed/);
    assert.match(refusal(decideBurst({ ...DEADLINE, deadline: NOW }, { ...CONTEXT, zone: JERUSALEM })), /--by 2030-01-08 12:00 IST has passed/);
    assert.match(refusal(decideBurst({ ...DEADLINE, tasks: [] }, CONTEXT)), /needs --task <ids>/);
  });

  it('keeps no tasks or deadline on a surplus burst', () => {
    const started = given(decideBurst({ ...REQUEST, tasks: ['T1'], deadline: NOW + HOUR }, CONTEXT));
    assert.deepEqual(started.tasks, []);
    assert.equal('deadline' in started, false);
  });
});

describe('burstDailyPct', () => {
  it("shares what is left to the stop % among the burst's sessions over its days, one day at least", () => {
    assert.equal(burstDailyPct(99.5, 60, 2, 14 * HOUR), 19.75);
    assert.equal(burstDailyPct(90, 60, 3, 48 * HOUR), 5);
    assert.equal(burstDailyPct(70, 60, 0, 24 * HOUR), 10);
    assert.equal(burstDailyPct(70, 60, 3, 24 * HOUR), 3.33);
  });
});

describe('activeBurst and burstsOver', () => {
  const first = burst({ at: NOW - 30 * HOUR, endsAt: NOW - 20 * HOUR });
  const second = burst({ at: NOW - HOUR });

  it('is the newest burst started by now, until its time, its stop % or the lead ends it', () => {
    assert.deepEqual(activeBurst([first, second], NOW, 70), second);
    assert.equal(activeBurst([first, second], NOW - 2 * HOUR, 70), undefined);
    assert.equal(activeBurst([first, second], PACE_END, 70), undefined);
    assert.equal(activeBurst([first, second], NOW, 99.5), undefined);
    assert.deepEqual(activeBurst([first, second], NOW, undefined), second);
    assert.equal(activeBurst([first, second, end(second.at, NOW - 1)], NOW, 70), undefined);
    assert.deepEqual(activeBurst([first, second, end(second.at, NOW + 1)], NOW, 70), second);
    assert.deepEqual(activeBurst([first, second, end(first.at, NOW - 1)], NOW, 70), second);
    assert.equal(activeBurst([], NOW, 70), undefined);
  });

  it('lists every burst over at now, so its hires are due to retire', () => {
    assert.deepEqual([...burstsOver([first, second], NOW, 70)], [first.at]);
    assert.deepEqual([...burstsOver([first, second, end(second.at, NOW)], NOW, 70)], [first.at, second.at]);
    assert.deepEqual([...burstsOver([first, second], NOW, 99.5)], [first.at, second.at]);
  });

  it('tells a burst from an end, and a kind from anything else', () => {
    assert.equal(isBurst(first), true);
    assert.equal(isBurst(end(first.at, NOW)), false);
    assert.equal(isBurstOver(second, [], NOW, undefined), false);
    assert.equal(isBurstKind('deadline'), true);
    assert.equal(isBurstKind('end'), false);
  });
});

describe('withBurst', () => {
  it("gives a burst's session at least the burst's daily budget, and leaves the others alone", () => {
    const active = burst({ dailyPct: 6 });
    assert.equal(withBurst(4, active, 'alpha'), 6);
    assert.equal(withBurst(8, active, 'alpha'), 8);
    assert.equal(withBurst(undefined, active, 'alpha'), 6);
    assert.equal(withBurst(4, active, 'carol'), 4);
    assert.equal(withBurst(undefined, undefined, 'alpha'), undefined);
  });
});
