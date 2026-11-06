import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { BudgetFacts } from '../budget/warn.ts';
import type { ApprovalAnswer, OwnerDecision, Task } from '../register/fold.ts';
import { NO_TASKS_ELSEWHERE, type TasksElsewhere } from '../register/tree.ts';
import type { WaitReason } from '../register/waits.ts';
import { parkedFacts, TEST_PARKING } from '../testing/ranking.ts';
import { testTask } from '../testing/task.ts';
import { JERUSALEM } from '../testing/zone.ts';
import {
  COLD_WAKE_W,
  costText,
  decideWake,
  effectivePriority,
  isNews,
  isWakeWorthy,
  NO_SETTLED_MOMENTS,
  openedWakeState,
  taskListText,
  WAKE_TITLE_MAX,
  wakeContext,
  wakeCost,
  wakePrompt,
  wakeRestOf,
  wakeToast,
  WARM_WAKE_W,
  type OpenedTab,
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
  return { tasks, elsewhere: NO_TASKS_ELSEWHERE, session: 'alpha', tab: TAB, now: NOW, zone: TimeZone.UTC, maxPriority: 1, parking: TEST_PARKING, batchMs: BATCH_MS, minGapMs: GAP_MS, previous, ...overrides };
}

const QUIET: WakeState = { tab: TAB, known: [], pending: undefined, lastWakeAt: undefined, settled: NO_SETTLED_MOMENTS };

const ON_LEAD: WaitReason = { kind: 'approval', who: 'lead' };
const APPROVED: ApprovalAnswer = { verdict: 'approved', by: 'lead', at: '2030-01-08T09:30:00.000Z', note: 'tests green' };
const DECLINED: ApprovalAnswer = { ...APPROVED, verdict: 'declined', note: 'add the test' };
const DECIDED: OwnerDecision = { by: 'lead', at: '2030-01-08T09:30:00.000Z', note: 'human decided: ship it' };

describe('isWakeWorthy', () => {
  const context = wakeContext(tasksOf(testTask({ id: 'T5', status: 'done' }), testTask({ id: 'T6' })), NO_TASKS_ELSEWHERE, NOW, TimeZone.UTC, TEST_PARKING);

  it('takes a task of its own, open or started task at the priority or more urgent', () => {
    assert.equal(isWakeWorthy(p1(), 'alpha', 1, context), true);
    assert.equal(isWakeWorthy(p1({ status: 'in-progress' }), 'alpha', 1, context), true);
    assert.equal(isWakeWorthy(testTask({ priority: 2 }), 'alpha', 2, context), true);
  });

  it('refuses a task of another session, a less urgent one, one finished, and one waiting or verifying with no wait cleared', () => {
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

  it('takes a started task past what it comes after: `after` gates only the start', () => {
    const startedAt = '2030-01-08T08:00:00.000Z';
    assert.equal(isWakeWorthy(p1({ status: 'in-progress', after: ['T6'], startedAt }), 'alpha', 1, context), true);
    assert.equal(isWakeWorthy(p1({ status: 'open', after: ['T6'], startedAt }), 'alpha', 1, context), true);
    assert.equal(isWakeWorthy(p1({ status: 'in-progress', after: ['T6'] }), 'alpha', 1, context), false);
  });

  it('takes a waiting or verifying task once every wait cleared, and refuses it while one holds', () => {
    const cleared: readonly WaitReason[] = [
      { kind: 'task', id: 'T5' },
      { kind: 'time', at: '2030-01-08 09:00' },
    ];
    for (const status of ['waiting', 'verifying'] as const) {
      assert.equal(isWakeWorthy(p1({ status, waits: cleared }), 'alpha', 1, context), true, status);
      assert.equal(isWakeWorthy(p1({ status, waits: [...cleared, { kind: 'task', id: 'T6' }] }), 'alpha', 1, context), false, status);
    }
    assert.equal(isWakeWorthy(p1({ status: 'waiting', waits: [{ kind: 'time', at: '2030-01-08' }] }), 'alpha', 1, context), false);
    assert.equal(isWakeWorthy(p1({ status: 'waiting', waits: [{ kind: 'decision', who: 'owner' }] }), 'alpha', 1, context), false);
  });

  it('takes a waiting task whose approval its giver answered, either way, and refuses one unanswered, answered by another, or still held (T996)', () => {
    for (const answer of [APPROVED, DECLINED]) {
      assert.equal(isWakeWorthy(p1({ status: 'waiting', waits: [ON_LEAD], answer }), 'alpha', 1, context), true, answer.verdict);
    }
    assert.equal(isWakeWorthy(p1({ status: 'waiting', waits: [ON_LEAD] }), 'alpha', 1, context), false, 'unanswered');
    assert.equal(isWakeWorthy(p1({ status: 'waiting', waits: [{ kind: 'approval', who: 'owner' }], answer: APPROVED }), 'alpha', 1, context), false, 'another giver');
    const held = p1({ status: 'waiting', waits: [ON_LEAD, { kind: 'task', id: 'T6' }], answer: APPROVED });
    assert.equal(isWakeWorthy(held, 'alpha', 1, context), false, 'a task it waits on is not finished');
  });

  it("takes a task a leader recorded the owner's decision on once its waits left cleared, none counting (T1366)", () => {
    assert.equal(isWakeWorthy(p1({ status: 'waiting', waits: [], decided: DECIDED }), 'alpha', 1, context), true, 'no wait left');
    assert.equal(isWakeWorthy(p1({ status: 'verifying', waits: [{ kind: 'task', id: 'T5' }], decided: DECIDED }), 'alpha', 1, context), true, 'its proof wait cleared');
    assert.equal(isWakeWorthy(p1({ status: 'waiting', waits: [{ kind: 'task', id: 'T6' }], decided: DECIDED }), 'alpha', 1, context), false, 'a task it waits on is not finished');
    assert.equal(isWakeWorthy(p1({ status: 'waiting', waits: [] }), 'alpha', 1, context), false, 'neither waiting nor decided');
  });

  it('refuses a waiting task never started that comes after one not finished, though its waits cleared', () => {
    const waiting = p1({ status: 'waiting', waits: [{ kind: 'task', id: 'T5' }], after: ['T6'] });
    assert.equal(isWakeWorthy(waiting, 'alpha', 1, context), false);
    assert.equal(isWakeWorthy({ ...waiting, startedAt: '2030-01-08T08:00:00.000Z' }, 'alpha', 1, context), true);
  });
});

describe('isNews', () => {
  const seen = '2030-01-08T09:00:00.000Z';

  it('is news when another handed it over, raised it or set its status after the owner last touched it', () => {
    assert.equal(isNews(p1(), 'alpha', tasksOf(), NO_TASKS_ELSEWHERE, TimeZone.UTC), true);
    assert.equal(isNews(p1({ ownerSeenAt: seen }), 'alpha', tasksOf(), NO_TASKS_ELSEWHERE, TimeZone.UTC), false);
    assert.equal(isNews(p1({ ownerSeenAt: seen, priorityAt: '2030-01-08T09:30:00.000Z' }), 'alpha', tasksOf(), NO_TASKS_ELSEWHERE, TimeZone.UTC), true);
    assert.equal(isNews(p1({ ownerSeenAt: seen, statusAt: '2030-01-08T09:30:00.000Z' }), 'alpha', tasksOf(), NO_TASKS_ELSEWHERE, TimeZone.UTC), true);
    assert.equal(isNews(p1({ ownerSeenAt: seen, assignedAt: '2030-01-08T09:30:00.000Z' }), 'alpha', tasksOf(), NO_TASKS_ELSEWHERE, TimeZone.UTC), true);
  });

  it("is news when another recorded the owner's decision after the owner last touched it, never the owner's own (T1366)", () => {
    const decided = (overrides: Partial<OwnerDecision>) => p1({ status: 'waiting', ownerSeenAt: seen, decided: { ...DECIDED, ...overrides } });
    assert.equal(isNews(decided({}), 'alpha', tasksOf(), NO_TASKS_ELSEWHERE, TimeZone.UTC), true);
    assert.equal(isNews(decided({ by: 'alpha' }), 'alpha', tasksOf(), NO_TASKS_ELSEWHERE, TimeZone.UTC), false, 'its own record');
    assert.equal(isNews(decided({ at: '2030-01-08T08:30:00.000Z' }), 'alpha', tasksOf(), NO_TASKS_ELSEWHERE, TimeZone.UTC), false, 'seen since');
  });

  const finishedBy = (by: string) => testTask({ id: 'T5', status: 'done', updatedBy: by, statusAt: '2030-01-08T09:30:00.000Z' });

  it('is news when another finished a task it comes after, never when the owner did or the task is retired', () => {
    const task = p1({ after: ['T5', 'T7'], ownerSeenAt: seen });
    assert.equal(isNews(task, 'alpha', tasksOf(finishedBy('bravo')), NO_TASKS_ELSEWHERE, TimeZone.UTC), true);
    assert.equal(isNews(task, 'alpha', tasksOf(finishedBy('alpha')), NO_TASKS_ELSEWHERE, TimeZone.UTC), false);
    assert.equal(isNews(task, 'alpha', tasksOf(testTask({ id: 'T5', status: 'done', updatedBy: 'bravo' })), NO_TASKS_ELSEWHERE, TimeZone.UTC), false);
  });

  it('is news when another finished a task it waits on, never when the owner did', () => {
    const task = p1({ status: 'waiting', waits: [{ kind: 'task', id: 'T5' }], ownerSeenAt: seen });
    assert.equal(isNews(task, 'alpha', tasksOf(finishedBy('bravo')), NO_TASKS_ELSEWHERE, TimeZone.UTC), true);
    assert.equal(isNews(task, 'alpha', tasksOf(finishedBy('alpha')), NO_TASKS_ELSEWHERE, TimeZone.UTC), false);
  });

  it("is news when another team of the tree finished a task it waits on or comes after, whoever set it, never before the owner's touch (T1139)", () => {
    const elsewhere = (by: string, statusAt: string): TasksElsewhere => new Map([['T5', { team: 'app', task: testTask({ id: 'T5', status: 'done', updatedBy: by, statusAt }) }]]);
    const waiting = p1({ status: 'waiting', waits: [{ kind: 'task', id: 'T5' }], ownerSeenAt: seen });
    const after = p1({ after: ['T5'], ownerSeenAt: seen });
    for (const task of [waiting, after]) {
      assert.equal(isNews(task, 'alpha', tasksOf(), elsewhere('bravo', '2030-01-08T09:30:00.000Z'), TimeZone.UTC), true);
      assert.equal(isNews(task, 'alpha', tasksOf(), elsewhere('alpha', '2030-01-08T09:30:00.000Z'), TimeZone.UTC), true, "app's alpha is another session");
      assert.equal(isNews(task, 'alpha', tasksOf(), elsewhere('bravo', '2030-01-08T08:30:00.000Z'), TimeZone.UTC), false, 'seen since');
      assert.equal(isNews(task, 'alpha', tasksOf(finishedBy('alpha')), elsewhere('bravo', '2030-01-08T09:30:00.000Z'), TimeZone.UTC), false, 'the read wins an id both hold');
    }
  });

  it('is news when a time it waits for falls after the owner last touched it, a bare day ending in the team zone', () => {
    const until = (at: string, ownerSeenAt = seen) => p1({ status: 'waiting', waits: [{ kind: 'time', at }], ownerSeenAt });
    assert.equal(isNews(until('2030-01-08 09:30'), 'alpha', tasksOf(), NO_TASKS_ELSEWHERE, TimeZone.UTC), true);
    assert.equal(isNews(until('2030-01-08 08:30'), 'alpha', tasksOf(), NO_TASKS_ELSEWHERE, TimeZone.UTC), false);
    assert.equal(isNews(until('2030-01-08 09:30'), 'alpha', tasksOf(), NO_TASKS_ELSEWHERE, JERUSALEM), true, 'a stored minute is UTC in any zone');
    const late = '2030-01-08T23:00:00.000Z';
    assert.equal(isNews(until('2030-01-08', late), 'alpha', tasksOf(), NO_TASKS_ELSEWHERE, TimeZone.UTC), true, 'the day ends 23:59 UTC');
    assert.equal(isNews(until('2030-01-08', late), 'alpha', tasksOf(), NO_TASKS_ELSEWHERE, JERUSALEM), false, 'the day ended 21:59 UTC there');
  });

  it('is never news for a wait on a decision or an approval not yet answered', () => {
    const task = p1({ status: 'waiting', waits: [{ kind: 'decision', who: 'owner' }, ON_LEAD], ownerSeenAt: seen });
    assert.equal(isNews(task, 'alpha', tasksOf(), NO_TASKS_ELSEWHERE, TimeZone.UTC), false);
  });

  it("is news when the giver answered an approval it waits on after the owner's touch, never before or by the owner (T996)", () => {
    const waiting = (answer: ApprovalAnswer) => p1({ status: 'waiting', waits: [ON_LEAD], ownerSeenAt: seen, answer });
    assert.equal(isNews(waiting(APPROVED), 'alpha', tasksOf(), NO_TASKS_ELSEWHERE, TimeZone.UTC), true);
    assert.equal(isNews(waiting(DECLINED), 'alpha', tasksOf(), NO_TASKS_ELSEWHERE, TimeZone.UTC), true);
    assert.equal(isNews(waiting({ ...APPROVED, at: '2030-01-08T08:30:00.000Z' }), 'alpha', tasksOf(), NO_TASKS_ELSEWHERE, TimeZone.UTC), false, 'seen since');
    const own = p1({ status: 'waiting', waits: [{ kind: 'approval', who: 'alpha' }], ownerSeenAt: seen, answer: { ...APPROVED, by: 'alpha' } });
    assert.equal(isNews(own, 'alpha', tasksOf(), NO_TASKS_ELSEWHERE, TimeZone.UTC), false, "the owner's own answer");
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

  it('wakes the owner of a waiting task once its last wait clears, not before', () => {
    const waiting = p1({ status: 'waiting', waits: [{ kind: 'time', at: '2030-01-08 10:30' }], ownerSeenAt: '2030-01-08T09:00:00.000Z' });
    const before = decideWake(input(tasksOf(waiting), QUIET, { batchMs: 0 }));
    assert.deepEqual(before.verdict, { kind: 'none' });
    const cleared = decideWake(input(tasksOf(waiting), before.state, { now: NOW + 60 * MINUTE, batchMs: 0 }));
    assert.deepEqual(cleared.verdict.kind === 'wake' ? cleared.verdict.tasks.map((task) => task.id) : [], ['T1']);
  });

  it('wakes the owner of a task waiting on approval once the lead answers it, not before (T996)', () => {
    const waiting = p1({ status: 'waiting', waits: [ON_LEAD], ownerSeenAt: '2030-01-08T09:00:00.000Z' });
    const before = decideWake(input(tasksOf(waiting), QUIET, { batchMs: 0 }));
    assert.deepEqual(before.verdict, { kind: 'none' });
    const answered = { ...waiting, answer: { ...APPROVED, at: '2030-01-08T10:30:00.000Z' } };
    const woke = decideWake(input(tasksOf(answered), before.state, { now: NOW + 60 * MINUTE, batchMs: 0 }));
    assert.deepEqual(woke.verdict.kind === 'wake' ? woke.verdict.tasks.map((task) => task.id) : [], ['T1']);
    const again = decideWake(input(tasksOf(answered), woke.state, { now: NOW + 120 * MINUTE, batchMs: 0 }));
    assert.deepEqual(again.verdict, { kind: 'none' }, 'one answer wakes it once');
  });

  it("wakes the owner of a task waiting on another team's task of the tree once that team finishes it, not before (T1139)", () => {
    const waiting = p1({ status: 'waiting', waits: [{ kind: 'task', id: 'T9' }], ownerSeenAt: '2030-01-08T09:00:00.000Z' });
    const held = (status: 'in-progress' | 'done', statusAt: string): TasksElsewhere => new Map([['T9', { team: 'app', task: testTask({ id: 'T9', owner: 'alpha', status, statusAt }) }]]);
    const before = decideWake(input(tasksOf(waiting), QUIET, { batchMs: 0, elsewhere: held('in-progress', '2030-01-08T08:00:00.000Z') }));
    assert.deepEqual(before.verdict, { kind: 'none' });
    const woke = decideWake(input(tasksOf(waiting), before.state, { now: NOW + MINUTE, batchMs: 0, elsewhere: held('done', '2030-01-08T10:00:30.000Z') }));
    assert.deepEqual(woke.verdict.kind === 'wake' ? woke.verdict.tasks.map((task) => task.id) : [], ['T1']);
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

describe('openedWakeState', () => {
  function opened(tasks: ReadonlyMap<string, Task>, previous: WakeState | undefined): OpenedTab {
    return { tasks, elsewhere: NO_TASKS_ELSEWHERE, session: 'alpha', tab: TAB, now: NOW, zone: TimeZone.UTC, maxPriority: 1, parking: TEST_PARKING, previous };
  }

  it('knows what could wake the resumed tab now and counts the open as its wake, keeping the settled moments (T1616)', () => {
    const settled = { dayStart: NOW - 60 * MINUTE, burst: NOW - 120 * MINUTE };
    const previous: WakeState = { tab: TAB, known: ['T7'], pending: { since: NOW - MINUTE, ids: ['T7'] }, lastWakeAt: NOW - 90 * MINUTE, settled };
    const tasks = tasksOf(p1(), testTask({ id: 'T2' }), p1({ id: 'T3', owner: 'bravo' }));
    assert.deepEqual(openedWakeState(opened(tasks, previous)), { tab: TAB, known: ['T1'], pending: undefined, lastWakeAt: NOW, settled });
    assert.deepEqual(openedWakeState(opened(tasks, undefined)).settled, NO_SETTLED_MOMENTS);
  });

  it('wakes the resumed tab only for work handed after the open, and not within the least gap of it', () => {
    const state = openedWakeState(opened(tasksOf(p1()), QUIET));
    assert.deepEqual(decideWake(input(tasksOf(p1()), state, { now: NOW + 60 * MINUTE, batchMs: 0 })).verdict, { kind: 'none' });
    const handed = tasksOf(p1(), p1({ id: 'T2' }));
    assert.deepEqual(decideWake(input(handed, state, { now: NOW + MINUTE, batchMs: 0 })).verdict, { kind: 'later', at: NOW + GAP_MS, ids: ['T2'] });
  });

  it('does not count a parked task among what the resumed tab knows (T2090)', () => {
    const tasks = tasksOf(p1({ ...parkedFacts(NOW) }), p1({ id: 'T2' }));
    assert.deepEqual(openedWakeState(opened(tasks, QUIET)).known, ['T2']);
  });
});

describe('a parked task and the wake (T2090)', () => {
  const parked = p1({ ...parkedFacts(NOW) });

  it('wakes no session, though no owner ever touched it and so it stays news', () => {
    assert.equal(isNews(parked, 'alpha', tasksOf(parked), NO_TASKS_ELSEWHERE, TimeZone.UTC), true);
    assert.deepEqual(decideWake(input(tasksOf(parked), QUIET, { batchMs: 0 })).verdict, { kind: 'none' });
  });

  it('wakes it once an event moves the task', () => {
    const moved = { ...parked, updatedAt: new Date(NOW).toISOString() };
    assert.equal(decideWake(input(tasksOf(moved), QUIET, { batchMs: 0 })).verdict.kind, 'wake');
  });

  it('wakes it once an active task of this register or another needs the task', () => {
    const needing = testTask({ id: 'T2', owner: 'bravo', after: ['T1'] });
    assert.equal(decideWake(input(tasksOf(parked, needing), QUIET, { batchMs: 0 })).verdict.kind, 'wake');
    const elsewhere: TasksElsewhere = new Map([['T2', { team: 'app', task: needing }]]);
    assert.equal(decideWake(input(tasksOf(parked), QUIET, { batchMs: 0, elsewhere })).verdict.kind, 'wake');
  });
});

describe('wakeRestOf', () => {
  const QUIET_HOURS = { startUtc: '09:00', endUtc: '11:00', action: 'ask' } as const;
  const facts = (overrides: Partial<BudgetFacts> = {}): BudgetFacts => ({
    now: NOW,
    id: 'alpha',
    name: 'alpha',
    usedTodayPct: 0.5,
    // 10M W make 1% of the week: a cold wake (210k W) is 0.021% of it, a warm one (27k W) 0.0027%.
    todayWPerPct: 10_000_000,
    budgetPct: 1,
    lift: undefined,
    liftBy: undefined,
    liftParent: undefined,
    liftWeekPct: undefined,
    cut: undefined,
    cutBy: undefined,
    burst: undefined,
    paused: false,
    surplus: undefined,
    weekUsedPct: 10,
    pace: undefined,
    // The team at its in-day pace: no room, so a session past its part is held.
    teamDay: { usedPct: 5, pacePct: 5 },
    isLead: false,
    urgent: [],
    leader: { id: 'lead', name: 'lead', isLead: true },
    zone: TimeZone.UTC,
    ...overrides,
  });

  it('goes by the clock alone with no budget facts, never held', () => {
    assert.deepEqual(wakeRestOf(undefined, QUIET_HOURS, NOW, 0), { held: false, quiet: true });
    assert.deepEqual(wakeRestOf(undefined, undefined, NOW, 0), { held: false, quiet: false });
  });

  it("reads the hold and quiet hours from the session's facts, and its lift's exemption", () => {
    assert.deepEqual(wakeRestOf(facts(), undefined, NOW, 0), { held: false, quiet: false });
    assert.deepEqual(wakeRestOf(facts({ usedTodayPct: 1.5 }), QUIET_HOURS, NOW, 0), { held: true, quiet: true });
    const lift = { session: 'alpha', group: false, partPct: 40, stopPct: 97, endsAt: NOW + 60 * MINUTE, reserve: false, quietHoursExempt: true, reason: 'incident', by: 'lead', at: NOW - MINUTE };
    assert.deepEqual(wakeRestOf(facts({ lift }), QUIET_HOURS, NOW, 0), { held: false, quiet: false });
  });

  it('counts the turn a wake would start as spent, so a session with less left than that turn is held before it (T1322)', () => {
    const awake = { held: false, quiet: false };
    const held = { held: true, quiet: false };
    assert.deepEqual(wakeRestOf(facts({ usedTodayPct: 0, budgetPct: 0 }), undefined, NOW, COLD_WAKE_W), held);
    assert.deepEqual(wakeRestOf(facts({ usedTodayPct: 0, budgetPct: 0.05 }), undefined, NOW, COLD_WAKE_W), awake);
    assert.deepEqual(wakeRestOf(facts({ usedTodayPct: 0, budgetPct: 0.01 }), undefined, NOW, COLD_WAKE_W), held);
    assert.deepEqual(wakeRestOf(facts({ usedTodayPct: 0, budgetPct: 0.01 }), undefined, NOW, WARM_WAKE_W), awake);
    assert.deepEqual(wakeRestOf(facts({ usedTodayPct: 0, budgetPct: 0, teamDay: { usedPct: 4.9, pacePct: 5 } }), undefined, NOW, COLD_WAKE_W), awake);
  });

  it('never holds a session past its part while the team has room today', () => {
    assert.deepEqual(wakeRestOf(facts({ usedTodayPct: 1.5, teamDay: { usedPct: 4.9, pacePct: 5 } }), undefined, NOW, 0), { held: false, quiet: false });
  });

  it('holds a session a leader cut once past its part, whatever room the team has (T1616)', () => {
    const cut = { session: 'alpha', endsAt: NOW + 60 * MINUTE, reason: 'over on a p3', by: 'lead', at: NOW - MINUTE };
    const cutBy = { id: 'lead', name: 'lead', isLead: true };
    assert.deepEqual(wakeRestOf(facts({ usedTodayPct: 1.5, teamDay: { usedPct: 4.9, pacePct: 5 }, cut, cutBy }), undefined, NOW, 0), { held: true, quiet: false });
  });

  it('holds a session a short day pauses, whatever room the team has and before any use today (T1598)', () => {
    const room = { usedPct: 1, pacePct: 5 };
    assert.deepEqual(wakeRestOf(facts({ usedTodayPct: 0, budgetPct: 0, paused: true, teamDay: room }), undefined, NOW, 0), { held: true, quiet: false });
    assert.deepEqual(wakeRestOf(facts({ usedTodayPct: 0, budgetPct: 0, paused: false, teamDay: room }), undefined, NOW, 0), { held: false, quiet: false });
  });

  it('lets a burst hold a paused session up: its floor is the budget it goes by (T1598)', () => {
    const burst = { kind: 'surplus', sessions: ['alpha'], helpers: 1, hires: 0, dailyPct: 2, stopPct: 97, endsAt: NOW + 60 * MINUTE, tasks: [], reason: 'spare week', by: 'lead', at: NOW - MINUTE } as const;
    assert.deepEqual(wakeRestOf(facts({ budgetPct: 2, paused: true, burst }), undefined, NOW, 0), { held: false, quiet: false });
    assert.deepEqual(wakeRestOf(facts({ usedTodayPct: 2.5, budgetPct: 2, paused: true, burst }), undefined, NOW, 0), { held: true, quiet: false });
  });
});

describe('effectivePriority', () => {
  it('keeps the configured priority unless the budget holds the session, then p0, or it is in quiet hours, then p1', () => {
    assert.equal(effectivePriority(3, { held: false, quiet: false }), 3);
    assert.equal(effectivePriority(3, { held: true, quiet: false }), 0, 'the budget stop lets only p0 go on');
    assert.equal(effectivePriority(1, { held: true, quiet: false }), 0);
    assert.equal(effectivePriority(3, { held: false, quiet: true }), 1);
    assert.equal(effectivePriority(3, { held: true, quiet: true }), 0);
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
    assert.equal(costText(wakeCost(MINUTE, 60, 9_000_000)), 'about 27k W, warm cache, under 0.01% of the week');
    assert.equal(costText(wakeCost(undefined, 60, 9_000_000)), 'about 210k W, cold, 0.02% of the week');
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

  it('says a waiting or verifying task woke for its cleared waits', () => {
    assert.equal(taskListText([p1({ status: 'waiting', title: 'Fix it' })]), 'T1 "Fix it" (p1, waiting: every wait cleared)');
    assert.equal(taskListText([p1({ status: 'verifying', title: 'Fix it' })]), 'T1 "Fix it" (p1, verifying: every wait cleared)');
  });

  it("says a waiting task woke for its approval's answer, approved or declined (T996)", () => {
    assert.equal(taskListText([p1({ status: 'waiting', title: 'Fix it', waits: [ON_LEAD], answer: APPROVED })]), 'T1 "Fix it" (p1, waiting: lead approved it)');
    assert.equal(taskListText([p1({ status: 'waiting', title: 'Fix it', waits: [ON_LEAD], answer: DECLINED })]), 'T1 "Fix it" (p1, waiting: lead declined it)');
  });

  it("says a task woke for the owner's decision a leader recorded (T1366)", () => {
    assert.equal(taskListText([p1({ status: 'waiting', title: 'Fix it', decided: DECIDED })]), `T1 "Fix it" (p1, waiting: lead recorded the owner's decision)`);
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
