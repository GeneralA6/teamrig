import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { BudgetFacts } from '../budget/warn.ts';
import type { Task } from '../register/fold.ts';
import { waitContext } from '../register/waits.ts';
import { testTask } from '../testing/task.ts';
import {
  COLD_WAKE_W,
  costText,
  decideWake,
  effectivePriority,
  isNews,
  isWakeWorthy,
  NO_SETTLED_MOMENTS,
  taskListText,
  WAKE_TITLE_MAX,
  wakeCost,
  wakePrompt,
  wakeRestOf,
  wakeToast,
  WARM_WAKE_W,
  type WakeInput,
  type WakeState,
} from './decide.ts';
import { TimeZone } from '../core/zone.ts';

const NOW = Date.parse('2030-01-08T10:00:00.000Z');
const TAB = 'tab-1';
const MINUTE = 60_000;
const BATCH_MS = 2 * MINUTE;
const GAP_MS = 15 * MINUTE;

function p1(overrides: Partial<Task> = {}): Task {
  return testTask({ priority: 1, ...overrides });
}

function tasksOf(...tasks: Task[]): ReadonlyMap<string, Task> {
  return new Map(tasks.map((task) => [task.id, task]));
}

function input(tasks: ReadonlyMap<string, Task>, previous: WakeState | undefined, overrides: Partial<WakeInput> = {}): WakeInput {
  return { tasks, session: 'alpha', tab: TAB, now: NOW, zone: TimeZone.UTC, maxPriority: 1, batchMs: BATCH_MS, minGapMs: GAP_MS, previous, ...overrides };
}

const QUIET: WakeState = { tab: TAB, known: [], pending: undefined, lastWakeAt: undefined, settled: NO_SETTLED_MOMENTS };

describe('isWakeWorthy', () => {
  const context = waitContext(tasksOf(testTask({ id: 'T5', status: 'done' }), testTask({ id: 'T6' })), new Date(NOW), TimeZone.UTC);

  it('takes a task of its own, open or started task at the priority or more urgent', () => {
    assert.equal(isWakeWorthy(p1(), 'alpha', 1, context), true);
    assert.equal(isWakeWorthy(p1({ status: 'in-progress' }), 'alpha', 1, context), true);
    assert.equal(isWakeWorthy(testTask({ priority: 2 }), 'alpha', 2, context), true);
  });

  it('refuses a task of another session, a less urgent one, and one waiting, verifying or finished', () => {
    assert.equal(isWakeWorthy(p1({ owner: 'bravo' }), 'alpha', 1, context), false);
    assert.equal(isWakeWorthy(testTask({ priority: 2 }), 'alpha', 1, context), false);
    for (const status of ['waiting', 'verifying', 'done', 'dropped'] as const) {
      assert.equal(isWakeWorthy(p1({ status }), 'alpha', 1, context), false, status);
    }
  });

  it('refuses a task that comes after one not finished, and takes it once all are finished or retired', () => {
    assert.equal(isWakeWorthy(p1({ after: ['T5', 'T6'] }), 'alpha', 1, context), false);
    assert.equal(isWakeWorthy(p1({ after: ['T5', 'T99'] }), 'alpha', 1, context), true);
  });
});

describe('isNews', () => {
  it('is news when another handed it over, raised it or set its status after the owner last touched it', () => {
    assert.equal(isNews(p1(), 'alpha', tasksOf()), true);
    const seen = '2030-01-08T09:00:00.000Z';
    assert.equal(isNews(p1({ ownerSeenAt: seen }), 'alpha', tasksOf()), false);
    assert.equal(isNews(p1({ ownerSeenAt: seen, priorityAt: '2030-01-08T09:30:00.000Z' }), 'alpha', tasksOf()), true);
    assert.equal(isNews(p1({ ownerSeenAt: seen, statusAt: '2030-01-08T09:30:00.000Z' }), 'alpha', tasksOf()), true);
    assert.equal(isNews(p1({ ownerSeenAt: seen, assignedAt: '2030-01-08T09:30:00.000Z' }), 'alpha', tasksOf()), true);
  });

  it('is news when another finished a task it comes after, never when the owner did or the task is retired', () => {
    const task = p1({ after: ['T5', 'T7'], ownerSeenAt: '2030-01-08T09:00:00.000Z' });
    const finishedBy = (by: string) => testTask({ id: 'T5', status: 'done', updatedBy: by, statusAt: '2030-01-08T09:30:00.000Z' });
    assert.equal(isNews(task, 'alpha', tasksOf(finishedBy('bravo'))), true);
    assert.equal(isNews(task, 'alpha', tasksOf(finishedBy('alpha'))), false);
    assert.equal(isNews(task, 'alpha', tasksOf(testTask({ id: 'T5', status: 'done', updatedBy: 'bravo' }))), false);
  });
});

describe('decideWake', () => {
  it('takes what is there as known at a first check in a tab, keeping the last wake and the settled moments', () => {
    const first = decideWake(input(tasksOf(p1()), undefined));
    assert.deepEqual(first, { verdict: { kind: 'none' }, state: { tab: TAB, known: ['T1'], pending: undefined, lastWakeAt: undefined, settled: NO_SETTLED_MOMENTS } });
    const settled = { dayStart: NOW - 60 * MINUTE, burst: NOW - 120 * MINUTE };
    const moved = decideWake(input(tasksOf(p1()), { ...QUIET, tab: 'old', lastWakeAt: NOW - MINUTE, settled }));
    assert.deepEqual(moved.state, { tab: TAB, known: ['T1'], pending: undefined, lastWakeAt: NOW - MINUTE, settled });
    const woke = decideWake(input(tasksOf(p1()), { ...QUIET, settled }, { batchMs: 0 }));
    assert.equal(woke.verdict.kind, 'wake');
    assert.deepEqual(woke.state.settled, settled);
  });

  it('holds a new task for the batch, then wakes for it and everything handed meanwhile, most urgent first', () => {
    const first = decideWake(input(tasksOf(p1({ id: 'T4' })), QUIET));
    assert.deepEqual(first.verdict, { kind: 'later', at: NOW + BATCH_MS, ids: ['T4'] });
    const later = NOW + MINUTE;
    const second = decideWake(input(tasksOf(p1({ id: 'T4' }), p1({ id: 'T2' })), first.state, { now: later }));
    assert.deepEqual(second.verdict, { kind: 'later', at: NOW + BATCH_MS, ids: ['T2', 'T4'] });
    const due = decideWake(input(tasksOf(p1({ id: 'T4' }), p1({ id: 'T2' })), second.state, { now: NOW + BATCH_MS }));
    assert.equal(due.verdict.kind, 'wake');
    assert.deepEqual(due.verdict.kind === 'wake' ? due.verdict.tasks.map((task) => task.id) : [], ['T2', 'T4']);
    assert.deepEqual(due.state, { tab: TAB, known: ['T4', 'T2'], pending: undefined, lastWakeAt: NOW + BATCH_MS, settled: NO_SETTLED_MOMENTS });
  });

  it('wakes at once with no batch, and never twice for the same task', () => {
    const woke = decideWake(input(tasksOf(p1()), QUIET, { batchMs: 0 }));
    assert.equal(woke.verdict.kind, 'wake');
    const again = decideWake(input(tasksOf(p1()), woke.state, { now: NOW + 60 * MINUTE, batchMs: 0 }));
    assert.deepEqual(again.verdict, { kind: 'none' });
  });

  it('waits out the least gap since the last wake', () => {
    const verdict = decideWake(input(tasksOf(p1()), { ...QUIET, lastWakeAt: NOW - MINUTE }, { batchMs: 0 })).verdict;
    assert.deepEqual(verdict, { kind: 'later', at: NOW - MINUTE + GAP_MS, ids: ['T1'] });
  });

  it('drops a pending task the owner touched or that stopped being wake-worthy, and starts the batch over', () => {
    const pending: WakeState = { ...QUIET, known: ['T1', 'T2'], pending: { since: NOW - MINUTE, ids: ['T1', 'T2'] } };
    const touched = p1({ ownerSeenAt: '2030-01-08T09:59:00.000Z' });
    const result = decideWake(input(tasksOf(touched, p1({ id: 'T2', status: 'waiting' }), p1({ id: 'T3' })), pending));
    assert.deepEqual(result.verdict, { kind: 'later', at: NOW + BATCH_MS, ids: ['T3'] });
    const nothing = decideWake(input(tasksOf(touched), pending));
    assert.deepEqual(nothing, { verdict: { kind: 'none' }, state: { ...QUIET, known: ['T1'] } });
  });

  it('ignores a task the session added itself and work less urgent than the priority', () => {
    const own = p1({ createdBy: 'alpha', ownerSeenAt: '2030-01-07T09:00:00.000Z' });
    assert.deepEqual(decideWake(input(tasksOf(own, testTask({ id: 'T2' })), QUIET)).verdict, { kind: 'none' });
    assert.equal(decideWake(input(tasksOf(testTask({ id: 'T2' })), QUIET, { maxPriority: 2 })).verdict.kind, 'later');
  });
});

describe('wakeRestOf', () => {
  const QUIET_HOURS = { startUtc: '09:00', endUtc: '11:00', action: 'ask' } as const;
  const facts = (overrides: Partial<BudgetFacts> = {}): BudgetFacts => ({
    now: NOW,
    id: 'alpha',
    name: 'alpha',
    usedTodayPct: 0.5,
    budgetPct: 1,
    lift: undefined,
    burst: undefined,
    surplus: undefined,
    weekUsedPct: 10,
    pace: undefined,
    // The team at its in-day pace: no room, so a session past its part is held.
    teamDay: { usedPct: 5, pacePct: 5 },
    isLead: false,
    zone: TimeZone.UTC,
    ...overrides,
  });

  it('goes by the clock alone with no budget facts, never held', () => {
    assert.deepEqual(wakeRestOf(undefined, QUIET_HOURS, NOW), { held: false, quiet: true });
    assert.deepEqual(wakeRestOf(undefined, undefined, NOW), { held: false, quiet: false });
  });

  it("reads the hold and quiet hours from the session's facts, and its lift's exemption", () => {
    assert.deepEqual(wakeRestOf(facts(), undefined, NOW), { held: false, quiet: false });
    assert.deepEqual(wakeRestOf(facts({ usedTodayPct: 1.5 }), QUIET_HOURS, NOW), { held: true, quiet: true });
    const lift = { session: 'alpha', partPct: 40, stopPct: 97, endsAt: NOW + 60 * MINUTE, reserve: false, quietHoursExempt: true, reason: 'incident', by: 'lead', at: NOW - MINUTE };
    assert.deepEqual(wakeRestOf(facts({ lift }), QUIET_HOURS, NOW), { held: false, quiet: false });
  });

  it('never holds a session past its part while the team has room today', () => {
    assert.deepEqual(wakeRestOf(facts({ usedTodayPct: 1.5, teamDay: { usedPct: 4.9, pacePct: 5 } }), undefined, NOW), { held: false, quiet: false });
  });
});

describe('effectivePriority', () => {
  it('keeps the configured priority unless the budget holds the session or it is in quiet hours, then p1', () => {
    assert.equal(effectivePriority(3, { held: false, quiet: false }), 3);
    assert.equal(effectivePriority(3, { held: true, quiet: false }), 1);
    assert.equal(effectivePriority(3, { held: false, quiet: true }), 1);
  });
});

describe('wake cost', () => {
  it('is warm under coldAfterMinutes, cold at it or unknown, and the default applies when it is 0', () => {
    assert.deepEqual(wakeCost(59 * MINUTE, 60, undefined), { w: WARM_WAKE_W, cold: false, weekPct: undefined });
    assert.equal(wakeCost(60 * MINUTE, 60, undefined).w, COLD_WAKE_W);
    assert.equal(wakeCost(undefined, 60, undefined).cold, true);
    assert.equal(wakeCost(61 * MINUTE, 0, undefined).cold, true);
    assert.equal(wakeCost(MINUTE, 0, 0).weekPct, undefined);
  });

  it('reads as W, warmth and the share of the week', () => {
    assert.equal(costText(wakeCost(MINUTE, 60, undefined)), 'about 27k W, warm cache');
    assert.equal(costText(wakeCost(MINUTE, 60, 900_000_000)), 'about 27k W, warm cache, under 0.01% of the week');
    assert.equal(costText(wakeCost(undefined, 60, 900_000_000)), 'about 210k W, cold, 0.02% of the week');
  });
});

describe('wake text', () => {
  const many = ['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'].map((id) => p1({ id, title: `Fix ${id}` }));

  it('names at most five tasks and counts the rest, with long titles cut', () => {
    assert.equal(taskListText(many.slice(0, 2)), 'T1 "Fix T1" (p1), T2 "Fix T2" (p1)');
    assert.match(taskListText(many), /T5 "Fix T5" \(p1\) and 2 more$/);
    const long = taskListText([p1({ title: 'x'.repeat(WAKE_TITLE_MAX + 5) })]);
    assert.equal(long, `T1 "${'x'.repeat(WAKE_TITLE_MAX - 3)}..." (p1)`);
  });

  it('asks the session to start a work block and states the cost; the toast names the tasks', () => {
    const cost = wakeCost(MINUTE, 60, undefined);
    const prompt = wakePrompt('alpha', many.slice(0, 1), cost);
    assert.match(prompt, /T1 "Fix T1" \(p1\)/);
    assert.match(prompt, /`teamrig start --session alpha`/);
    assert.match(prompt, /This wake costs about 27k W, warm cache\.$/);
    assert.equal(wakeToast(many, cost), 'teamrig woke this tab for T1, T2, T3, T4, T5 and 2 more (about 27k W, warm cache)');
    assert.equal(wakeToast(many.slice(0, 1), cost), 'teamrig woke this tab for T1 (about 27k W, warm cache)');
  });
});
