import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Burst } from '../budget/burst.ts';
import type { Task } from '../register/fold.ts';
import { NO_TASKS_ELSEWHERE, type TasksElsewhere } from '../register/tree.ts';
import { testTask } from '../testing/task.ts';
import {
  dayStartAt,
  dayStartPrompt,
  dayStartToast,
  decideDayStart,
  dueMoments,
  nextDayStartAt,
  startableTasks,
  teamDayStartAt,
  type DayMoment,
  type DayStartInput,
  type DayStartLogin,
} from './day-start.ts';
import { NO_SETTLED_MOMENTS } from './decide.ts';
import { TimeZone } from '../core/zone.ts';
import { JERUSALEM } from '../testing/zone.ts';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const SIX = Date.parse('2030-01-08T06:00:00.000Z');
const NOW = SIX + 2 * HOUR;
const GAP_MS = 15 * MINUTE;
const AWAKE = { held: false, quiet: false };
const COLD = { w: 210_000, cold: true, weekPct: 0.021 };

const BURST: Burst = {
  kind: 'surplus',
  sessions: ['alpha', 'bravo'],
  helpers: 3,
  hires: 0,
  dailyPct: 2.5,
  stopPct: 99.3,
  endsAt: Date.parse('2030-01-10T00:00:00.000Z'),
  tasks: [],
  reason: 'week-end surplus',
  by: 'lead',
  at: SIX + HOUR,
};

const DAY_START: DayMoment = { kind: 'day-start', at: SIX };
const BURST_MOMENT: DayMoment = { kind: 'burst', at: BURST.at, burst: BURST };
const LOGIN_OK: DayStartLogin = { kind: 'ok' };

function tasksOf(...tasks: Task[]): ReadonlyMap<string, Task> {
  return new Map(tasks.map((task) => [task.id, task]));
}

function input(overrides: Partial<DayStartInput> = {}): DayStartInput {
  return {
    due: [DAY_START],
    startable: [testTask()],
    lastTurnAt: SIX - 8 * HOUR,
    rest: AWAKE,
    now: NOW,
    lastWakeAt: undefined,
    minGapMs: GAP_MS,
    settled: NO_SETTLED_MOMENTS,
    login: LOGIN_OK,
    ...overrides,
  };
}

describe('the day start', () => {
  it('is the latest start at or before now, and the next one after it, crossing midnight', () => {
    assert.equal(dayStartAt('06:00', SIX), SIX);
    assert.equal(dayStartAt('06:00', SIX - 1), SIX - DAY);
    assert.equal(dayStartAt('06:00', SIX + 18 * HOUR), SIX);
    assert.equal(dayStartAt('23:30', SIX), Date.parse('2030-01-07T23:30:00.000Z'));
    assert.equal(nextDayStartAt('06:00', SIX), SIX + DAY);
    assert.equal(nextDayStartAt('06:00', SIX - 1), SIX);
    assert.equal(dayStartAt('6:00', SIX), undefined);
    assert.equal(nextDayStartAt('24:00', SIX), undefined);
  });

  it("is the team's day start when it sets one, else midnight UTC, also for a malformed time", () => {
    const midnight = Date.parse('2030-01-08T00:00:00.000Z');
    assert.equal(teamDayStartAt('06:00', SIX - 1), SIX - DAY);
    assert.equal(teamDayStartAt(undefined, SIX - 1), midnight);
    assert.equal(teamDayStartAt('6:00', NOW), midnight);
  });
});

describe('dueMoments', () => {
  it('names the day start until it is settled, and a burst the session is in from its start until it is settled', () => {
    assert.deepEqual(dueMoments(NOW, '06:00', undefined, NO_SETTLED_MOMENTS), [DAY_START]);
    assert.deepEqual(dueMoments(NOW, '06:00', BURST, NO_SETTLED_MOMENTS), [DAY_START, BURST_MOMENT]);
    assert.deepEqual(dueMoments(NOW, '06:00', BURST, { dayStart: SIX, burst: BURST.at }), []);
    assert.deepEqual(dueMoments(NOW, '06:00', undefined, { dayStart: SIX - DAY, burst: undefined }), [DAY_START], "yesterday's start settles none of today");
    assert.deepEqual(dueMoments(NOW, '06:00', BURST, { dayStart: SIX, burst: BURST.at - DAY }), [BURST_MOMENT], 'an earlier burst settles none of a new one');
    assert.deepEqual(dueMoments(BURST.at - 1, undefined, BURST, NO_SETTLED_MOMENTS), [], 'a burst logged ahead of its start');
    assert.deepEqual(dueMoments(NOW, undefined, BURST, NO_SETTLED_MOMENTS), [BURST_MOMENT]);
  });
});

describe('startableTasks', () => {
  it("is the session's open or started work of any priority with all it comes after finished, most urgent first", () => {
    const tasks = tasksOf(
      testTask({ id: 'T1', priority: 3 }),
      testTask({ id: 'T2', priority: 1, status: 'in-progress' }),
      testTask({ id: 'T3', priority: 2, owner: 'bravo' }),
      testTask({ id: 'T4', priority: 1, status: 'waiting' }),
      testTask({ id: 'T5', priority: 1, after: ['T6'] }),
      testTask({ id: 'T6', priority: 2, owner: 'bravo' }),
      testTask({ id: 'T7', priority: 2, after: ['T8'] }),
      testTask({ id: 'T8', priority: 2, owner: 'bravo', status: 'done' }),
    );
    assert.deepEqual(
      startableTasks(tasks, NO_TASKS_ELSEWHERE, 'alpha', NOW, TimeZone.UTC).map((task) => task.id),
      ['T2', 'T7', 'T1'],
    );
    assert.deepEqual(
      startableTasks(tasks, NO_TASKS_ELSEWHERE, 'alpha', NOW, TimeZone.UTC, 2).map((task) => task.id),
      ['T2', 'T7'],
      'a max priority leaves out less urgent work',
    );
    assert.deepEqual(startableTasks(tasks, NO_TASKS_ELSEWHERE, 'charlie', NOW, TimeZone.UTC), []);
  });

  it('takes a waiting task once every wait cleared, and a started task past what it comes after', () => {
    const tasks = tasksOf(
      testTask({ id: 'T1', status: 'waiting', waits: [{ kind: 'time', at: '2030-01-08 07:00' }] }),
      testTask({ id: 'T2', status: 'waiting', waits: [{ kind: 'time', at: '2030-01-08' }] }),
      testTask({ id: 'T3', status: 'in-progress', after: ['T4'], startedAt: '2030-01-07T12:00:00.000Z' }),
      testTask({ id: 'T4', owner: 'bravo' }),
    );
    assert.deepEqual(
      startableTasks(tasks, NO_TASKS_ELSEWHERE, 'alpha', NOW, TimeZone.UTC).map((task) => task.id),
      ['T1', 'T3'],
    );
  });

  it("holds a task waiting on or after another team's open task of the tree, and takes it once that team finished it (T1139)", () => {
    const tasks = tasksOf(
      testTask({ id: 'T1', status: 'waiting', waits: [{ kind: 'task', id: 'T8' }] }),
      testTask({ id: 'T2', after: ['T8'] }),
      testTask({ id: 'T3', status: 'waiting', waits: [{ kind: 'task', id: 'T9' }] }),
      testTask({ id: 'T4', after: ['T9'] }),
    );
    const elsewhere: TasksElsewhere = new Map([
      ['T8', { team: 'app', task: testTask({ id: 'T8', owner: 'web', status: 'done' }) }],
      ['T9', { team: 'app', task: testTask({ id: 'T9', owner: 'web', status: 'in-progress' }) }],
    ]);
    assert.deepEqual(startableTasks(tasks, elsewhere, 'alpha', NOW, TimeZone.UTC).map((task) => task.id).sort(), ['T1', 'T2']);
  });
});

describe('decideDayStart', () => {
  it('wakes a session with no turn since the moments for all of them at once, and settles them', () => {
    const decision = decideDayStart(input({ due: [DAY_START, BURST_MOMENT] }));
    assert.deepEqual(decision, {
      verdict: { kind: 'wake', moments: [DAY_START, BURST_MOMENT], tasks: [testTask()] },
      settled: { dayStart: SIX, burst: BURST.at },
    });
  });

  it('settles with no wake a moment the session had a turn after, and wakes it for the rest', () => {
    const between = decideDayStart(input({ due: [DAY_START, BURST_MOMENT], lastTurnAt: SIX + 30 * MINUTE }));
    assert.deepEqual(between, { verdict: { kind: 'wake', moments: [BURST_MOMENT], tasks: [testTask()] }, settled: { dayStart: SIX, burst: BURST.at } });
    const after = decideDayStart(input({ due: [DAY_START, BURST_MOMENT], lastTurnAt: BURST.at }));
    assert.deepEqual(after, { verdict: { kind: 'none' }, settled: { dayStart: SIX, burst: BURST.at } });
  });

  it('keeps the moments due, with no wake, in quiet hours, past the daily budget or with no work it can start', () => {
    for (const overrides of [{ rest: { held: false, quiet: true } }, { rest: { held: true, quiet: false } }, { startable: [] }, { due: [] }]) {
      assert.deepEqual(decideDayStart(input(overrides)), { verdict: { kind: 'none' }, settled: NO_SETTLED_MOMENTS }, JSON.stringify(overrides));
    }
  });

  it('waits out the gap after the last wake, keeping what it settled', () => {
    const lastWakeAt = NOW - 5 * MINUTE;
    const early = decideDayStart(input({ due: [DAY_START, BURST_MOMENT], lastTurnAt: SIX + 1, lastWakeAt }));
    assert.deepEqual(early, { verdict: { kind: 'later', at: lastWakeAt + GAP_MS }, settled: { dayStart: SIX, burst: undefined } });
    assert.equal(decideDayStart(input({ lastWakeAt: NOW - GAP_MS })).verdict.kind, 'wake');
  });

  it('keeps the moments due, with no wake, while the login is expired, still settling one the session had a turn after', () => {
    const decision = decideDayStart(input({ due: [DAY_START, BURST_MOMENT], lastTurnAt: SIX + 1, login: { kind: 'expired' } }));
    assert.deepEqual(decision, { verdict: { kind: 'none' }, settled: { dayStart: SIX, burst: undefined } });
  });

  it("waits for another tab's probe until its recheck, keeping the open moments due", () => {
    const recheckAt = NOW + MINUTE;
    const decision = decideDayStart(input({ due: [DAY_START, BURST_MOMENT], lastTurnAt: SIX + 1, login: { kind: 'probing', recheckAt } }));
    assert.deepEqual(decision, { verdict: { kind: 'later', at: recheckAt }, settled: { dayStart: SIX, burst: undefined } });
    const lastWakeAt = NOW - 5 * MINUTE;
    assert.deepEqual(decideDayStart(input({ lastWakeAt, login: { kind: 'probing', recheckAt } })).verdict, { kind: 'later', at: lastWakeAt + GAP_MS });
  });
});

describe('the day-start prompt and toast', () => {
  const tasks = [testTask({ id: 'T4', title: 'Ship the page', priority: 1 }), testTask({ id: 'T9', title: 'Tidy the docs', priority: 3 })];

  it('tells the session which moments woke it, its work, how to start and what the wake costs', () => {
    assert.equal(
      dayStartPrompt('alpha', 'app-alpha', [DAY_START], tasks, COLD, TimeZone.UTC),
      'The day started at 06:00 UTC and this tab has had no turn since. Work you can start: T4 "Ship the page" (p1), T9 "Tidy the docs" (p3). ' +
        'Start a work block (`teamrig start --session alpha`) and work your list in plan order. This wake costs about 210k W, cold, 0.02% of the week.',
    );
    const both = dayStartPrompt('alpha', 'app-alpha', [DAY_START, BURST_MOMENT], tasks, COLD, TimeZone.UTC);
    assert.match(both, /^The day started at 06:00 UTC and this tab has had no turn since\. The lead started a surplus burst until .*: app-alpha's daily budget is at least 2\.5%, up to 3 helpers at once\. Work you can start: T4/);
  });

  it("gives the day's start on the team's clock", () => {
    assert.match(dayStartPrompt('alpha', 'app-alpha', [DAY_START], tasks, COLD, JERUSALEM), /^The day started at 08:00 IST and this tab has had no turn since\. /);
  });

  it('tells the person which moments woke the tab, for which tasks, and the cost', () => {
    assert.equal(dayStartToast([DAY_START], tasks, COLD), 'teamrig woke this tab for the day start: T4, T9 (about 210k W, cold, 0.02% of the week)');
    assert.equal(dayStartToast([BURST_MOMENT], tasks, COLD), 'teamrig woke this tab for the burst: T4, T9 (about 210k W, cold, 0.02% of the week)');
    assert.equal(dayStartToast([DAY_START, BURST_MOMENT], tasks, COLD).startsWith('teamrig woke this tab for the day start and the burst: '), true);
  });
});
