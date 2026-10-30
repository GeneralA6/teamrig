import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_BUDGET, DEFAULT_BURST } from '../config/defaults.ts';
import { TimeZone } from '../core/zone.ts';
import { JERUSALEM } from '../testing/zone.ts';
import type { BudgetConfig, BurstConfig } from '../config/types.ts';
import { DailyProfile } from './active-time.ts';
import {
  activeBurst,
  burstFloorOf,
  burstFloorPct,
  burstsOver,
  decideBurst,
  isBurst,
  isBurstKind,
  isBurstOver,
  spareShareNote,
  surplusOf,
  withBurst,
  type Burst,
  type BurstContext,
  type BurstDecision,
  type BurstEnd,
  type BurstPace,
  type BurstRequest,
} from './burst.ts';
import { dailyAllowancePct, weekWindow } from './pace.ts';
import type { BudgetSplit, TeamsOnAccount } from './parts.ts';
import { emptyPatterns } from './patterns.ts';
import type { UsageState } from './store.ts';

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
/** A team of `ids` at the default share, with no queued work or lift. */
function plainTeam(team: string, ids: readonly string[]): BudgetSplit {
  return { team, ids, sessions: {}, work: new Map(), leads: {}, lifted: new Map(), liftedGroups: new Map(), pausable: new Set(), funded: new Map() };
}

/** The team alone on its account, and beside a team of the same weight, which takes half the account's spare. */
const ALONE: TeamsOnAccount = { split: plainTeam('app', ['lead', 'alpha', 'bravo']), others: [] };
const SHARED: TeamsOnAccount = { ...ALONE, others: [plainTeam('web', ['lead', 'front', 'back'])] };
const EVEN = DailyProfile.even();
const CONTEXT: BurstContext = {
  usedPct: 60,
  window: WINDOW,
  targetPct: 99.5,
  config: OWNER,
  active: undefined,
  zone: TimeZone.UTC,
  profile: EVEN,
  sessionsTodayPct: 0,
  teams: ALONE,
  ownerAsk: 'the owner',
};
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
  const input = { window: WINDOW, now: NOW, usedPct: 60, targetPct: 99.5, config: DEFAULT_BURST, teams: ALONE };

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

  it("gives a team that shares the account its part of the account's spare, and judges a burst on that part", () => {
    const alone = surplusOf(input);
    const shared = surplusOf({ ...input, teams: SHARED });
    assert.ok(alone !== undefined && shared !== undefined);
    assert.equal(alone.accountSparePct, undefined);
    assert.equal(shared.projectedPct, alone.projectedPct);
    assert.equal(shared.accountSparePct, alone.sparePct);
    assert.ok(Math.abs(shared.sparePct - alone.sparePct / 2) < 1e-9);
    // At 84% used the account spares about 7.8%: worth a burst for a team alone, not for one that takes half of it.
    const tight = surplusOf({ ...input, usedPct: 84, teams: SHARED });
    assert.ok(tight?.accountSparePct !== undefined && tight.accountSparePct > 5 && tight.sparePct < 5);
    assert.equal(tight.worth, false);
    assert.equal(surplusOf({ ...input, usedPct: 84 })?.worth, true);
  });
});

describe('spareShareNote', () => {
  it("names the account's spare when other teams share it, and nothing for a team alone", () => {
    assert.equal(spareShareNote({ accountSparePct: undefined }), '');
    assert.equal(spareShareNote({ accountSparePct: 7.8 }), ", this team's part of the account's 7.8%,");
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
    assert.match(refusal(decideBurst({ ...REQUEST, approvedBy: undefined }, CONTEXT)), /approves each one; ask the owner, then pass --approved-by/);
    const child = { ...CONTEXT, ownerAsk: 'the lead of team app, who takes it to the owner' };
    assert.match(refusal(decideBurst({ ...REQUEST, approvedBy: undefined }, child)), /approves each one; ask the lead of team app, who takes it to the owner, then pass --approved-by/);
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
    assert.match(
      refusal(decideBurst(REQUEST, { ...CONTEXT, usedPct: 84, teams: SHARED })),
      /only 3\.9% of the week, this team's part of the account's 7\.8%, is projected unused at the pace end, below burst\.minSparePct \(5\.0%\)/,
    );
    assert.equal(given(decideBurst(REQUEST, { ...CONTEXT, usedPct: 84 })).kind, 'surplus');
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

describe('burstFloorPct', () => {
  /** A deadline burst from Thursday 10:00 to Saturday 10:00 UTC, to 80% of the week, for two sessions. */
  const THURSDAY = Date.parse('2030-01-03T10:00:00Z');
  const LONG = burst({ kind: 'deadline', stopPct: 80, endsAt: THURSDAY + 48 * HOUR });
  const NIGHTS = DailyProfile.ofQuietHours({ startUtc: '22:00', endUtc: '06:00', action: 'ask' });

  function floor(now: number, usedPct: number, todayPct: number, profile = EVEN, of = LONG): number {
    const pace: BurstPace = { window: WINDOW, now, usedPct, todayPct, profile };
    return Math.round(burstFloorPct(of, pace) * 100) / 100;
  }

  it("shares what is left to the stop % among the burst's sessions, a day of the active time to its end", () => {
    assert.equal(floor(THURSDAY, 60, 0), 5);
    // Quiet 22:00-06:00: a day has 16 active hours, and 32 are left to Saturday 10:00.
    assert.equal(floor(THURSDAY, 60, 0, NIGHTS), 5);
    assert.equal(floor(THURSDAY, 60, 0, EVEN, burst({ ...LONG, sessions: [] })), 10);
  });

  it('is recomputed at every reading: spending ahead lowers it and spending less raises it', () => {
    const friday = THURSDAY + 24 * HOUR;
    assert.equal(floor(friday, 70, 0.5), 5);
    assert.equal(floor(friday, 75, 0.5), 2.5);
    assert.equal(floor(friday, 62, 0.5), 9);
    assert.equal(floor(friday, 80, 0.5), 0);
  });

  it("is never above its sessions' use today plus what is left, on the day it ends", () => {
    // Saturday 06:00, four hours to the end of ten today: at that rate today is 5%, above the 1% used plus the 2% left.
    assert.equal(floor(THURSDAY + 44 * HOUR, 78, 1), 1.5);
  });

  it("is the team's allowance shared by its sessions when it runs to the pace end, to the target", () => {
    const team = dailyAllowancePct({ window: WINDOW, budget: { ...DEFAULT_BUDGET, targetPct: 99.5 }, now: THURSDAY, usedPct: 60, todayPct: 0, profile: NIGHTS });
    assert.equal(floor(THURSDAY, 60, 0, NIGHTS, burst()), Math.round((team / 2) * 100) / 100);
    assert.equal(floor(NOW, 60, 0, EVEN, burst()), 19.75);
  });
});

describe('burstFloorOf', () => {
  const DAY = '2030-01-08';
  /** No quiet hours: every hour is active. */
  const AWAKE: Pick<BudgetConfig, 'quietHours'> = {};
  /** 1% of the week is 1,000 W. */
  const WEEK = { window: WINDOW, usedPct: 60, todayWPerPct: 1_000, todayFrom: Date.parse('2030-01-08T00:00:00Z') };

  function used(w: number): UsageState {
    return { byDay: { [DAY]: { w, calls: 1, patterns: emptyPatterns() } }, byHour: {}, byTask: {}, cursors: {}, recentKeys: [] };
  }

  it("reads its sessions' use today, not the others', into the floor", () => {
    const states = new Map([
      ['alpha', used(2_000)],
      ['bravo', used(1_000)],
      ['carol', used(30_000)],
    ]);
    const due = burst({ kind: 'deadline', stopPct: 62, endsAt: NOW + 4 * HOUR });
    // 2% left in four of today's fourteen hours is 7% today, above the 3% used today plus the 2% left.
    assert.equal(burstFloorOf(due, WEEK, states, AWAKE, NOW), 2.5);
    assert.equal(burstFloorOf(due, WEEK, new Map(), AWAKE, NOW), 1);
  });

  it('keeps its start reading while the week cannot be read', () => {
    const started = burst({ dailyPct: 7 });
    assert.equal(burstFloorOf(started, { ...WEEK, todayWPerPct: undefined }, new Map(), AWAKE, NOW), 7);
    assert.equal(burstFloorOf(started, { ...WEEK, usedPct: undefined }, new Map(), AWAKE, NOW), 7);
    assert.equal(burstFloorOf(started, { ...WEEK, window: undefined }, new Map(), AWAKE, NOW), 7);
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
  it("gives a burst's session at least the burst's floor, and leaves a session out of it alone", () => {
    assert.equal(withBurst(4, 6), 6);
    assert.equal(withBurst(8, 6), 8);
    assert.equal(withBurst(undefined, 6), 6);
    assert.equal(withBurst(4, undefined), 4);
    assert.equal(withBurst(undefined, undefined), undefined);
  });
});
