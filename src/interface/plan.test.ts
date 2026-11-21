import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TimeZone } from '../core/zone.ts';
import type { Task } from '../register/fold.ts';
import { NO_TASKS_ELSEWHERE, TaskTree, type TaskElsewhere, type TasksElsewhere } from '../register/tree.ts';
import type { WaitReason } from '../register/waits.ts';
import { TEST_CARD, TEST_OWNER_CARD } from '../testing/card.ts';
import { parkedFacts, TEST_FOCUS, testRanking } from '../testing/ranking.ts';
import { testTask } from '../testing/task.ts';
import { planBody, type PlanBody, type PlannedTask } from './plan.ts';

const NOW = new Date('2030-01-08T10:00:00.000Z');
const STARTED = '2030-01-07T09:00:00.000Z';
/** A text one of teamrig's own secret shapes matches, built from parts so this file holds none. */
const TOKEN = ['pass', 'word', '=', 'hunter2'].join('');
const TURNS = { dueSoonDays: TEST_FOCUS.score.dueSoonDays, parkAfterDays: TEST_FOCUS.parkAfterDays };
const SETTINGS = { ownerMarker: 'owner', requireGate: true };

/** A card on the owner's decision, with its gate, owned by `owner`, put off until each of `times`. */
function cardOf(id: string, owner: string, times: readonly string[] = [], overrides: Partial<Task> = {}): Task {
  const waits: WaitReason[] = [{ kind: 'decision', who: 'owner' }, ...times.map((at): WaitReason => ({ kind: 'time', at }))];
  return testTask({ id, owner, status: 'waiting', startedAt: STARTED, waits, card: TEST_OWNER_CARD, ...overrides });
}

function treeOf(tasks: readonly Task[], elsewhere: TasksElsewhere = NO_TASKS_ELSEWHERE): TaskTree {
  return new TaskTree(new Map(tasks.map((task) => [task.id, task])), NOW, TimeZone.UTC, null, elsewhere, testRanking());
}

function planOf(tasks: readonly Task[], owner: string | null = null, elsewhere: TasksElsewhere = NO_TASKS_ELSEWHERE): PlanBody {
  return planBody({ tree: treeOf(tasks, elsewhere), tasks, owner, now: NOW.getTime(), turns: TURNS, ...SETTINGS });
}

function planned(body: PlanBody, id: string): PlannedTask {
  const task = body.tasks.find((candidate) => candidate.id === id);
  assert.ok(task !== undefined, `${id} is in the plan`);
  return task;
}

/** A task being worked, which no rule of the clock turns: it has no due, no wait, and only an open task parks. */
function working(overrides: Partial<Task> = {}): Task {
  return testTask({ status: 'in-progress', startedAt: STARTED, ...overrides });
}

describe('planBody', () => {
  it('serves the active tasks in plan order, the finished ones left out', () => {
    const tasks = [
      testTask({ id: 'T1' }),
      testTask({ id: 'T2', status: 'done' }),
      testTask({ id: 'T3', pin: 'lead' }),
      working({ id: 'T4', owner: 'bravo' }),
      testTask({ id: 'T5', status: 'dropped' }),
      testTask({ id: 'T6', status: 'verifying', startedAt: STARTED }),
    ];
    const body = planOf(tasks);
    const order = body.tasks.map((task) => task.id);
    assert.deepEqual([...order].sort(), ['T1', 'T3', 'T4', 'T6']);
    assert.deepEqual(order, treeOf(tasks).inPlanOrder(tasks.filter((task) => order.includes(task.id))).map((task) => task.id));
    assert.equal(order[0], 'T3', 'a pinned task leads');
    assert.equal(body.at, '2030-01-08T10:00:00.000Z');
    assert.equal(body.week, null);
  });

  it('serves one session its tasks in the order the team plans them', () => {
    const tasks = [testTask({ id: 'T1' }), testTask({ id: 'T2', owner: 'bravo', pin: 'lead' }), testTask({ id: 'T3', pin: 'lead' }), testTask({ id: 'T4', owner: 'bravo' })];
    const every = planOf(tasks).tasks.map((task) => task.id);
    assert.deepEqual(planOf(tasks, 'bravo').tasks.map((task) => task.id), every.filter((id) => id === 'T2' || id === 'T4'));
    assert.deepEqual(planOf(tasks, 'alpha').tasks.map((task) => task.id), every.filter((id) => id === 'T1' || id === 'T3'));
    assert.deepEqual(planOf(tasks, 'nobody').tasks, []);
  });

  it('serves the keys of plan order and what the score was read from', () => {
    const tasks = [
      working({ id: 'T1', size: 2, week: '2030-01-07', pin: 'lead' }),
      testTask({ id: 'T2', priority: 1, after: ['T1'] }),
      testTask({ id: 'T3', after: ['T1'] }),
    ];
    const tree = new TaskTree(new Map(tasks.map((task) => [task.id, task])), NOW, TimeZone.UTC, '2030-01-07', NO_TASKS_ELSEWHERE, testRanking({ goals: { T1: { tag: 'G2', rank: 2 } } }));
    const body = planBody({ tree, tasks, owner: null, now: NOW.getTime(), turns: TURNS, ...SETTINGS });
    const ranked = tree.placeOf(tasks[0] ?? testTask()).ranked;
    assert.ok(ranked !== undefined);
    assert.equal(body.week, '2030-01-07');
    assert.deepEqual(planned(body, 'T1'), {
      id: 'T1',
      parked: false,
      pinned: true,
      band: planned(body, 'T1').band,
      ready: true,
      score: ranked.score,
      started: true,
      due: null,
      unblocks: { first: 'T2', priority: 1, count: 2 },
      inWeek: true,
      size: 2,
      costOfDelay: ranked.costOfDelay,
      sizePct: ranked.sizePct,
      workClass: 'Improvements',
      goal: { tag: 'G2', rank: 2 },
      prep: false,
      needs: [],
      neededBy: [],
      next: { kind: 'work', who: 'alpha', task: 'T1', behind: null },
    });
    assert.ok(ranked.score > 0 && Number.isInteger(planned(body, 'T1').band));
    const waiting = planned(body, 'T2');
    assert.deepEqual([waiting.ready, waiting.started, waiting.pinned, waiting.inWeek, waiting.size, waiting.goal, waiting.unblocks], [false, false, false, false, null, null, null]);
  });

  it('serves the due a task works to, its own or the earlier one of a task that needs it', () => {
    const body = planOf([testTask({ id: 'T1', due: '2030-01-30' }), testTask({ id: 'T2' }), testTask({ id: 'T3', after: ['T2'], due: '2030-01-12' }), testTask({ id: 'T4', due: '2030-01-15 09:00' })]);
    assert.deepEqual(planned(body, 'T1').due, { due: '2030-01-30', at: '2030-01-30T23:59:59.999Z', from: null });
    assert.deepEqual(planned(body, 'T2').due, { due: '2030-01-12', at: '2030-01-12T23:59:59.999Z', from: 'T3' });
    assert.deepEqual(planned(body, 'T4').due, { due: '2030-01-15 09:00', at: '2030-01-15T09:00:00.000Z', from: null });
  });

  it('names the active tasks of other sessions that need a task, the earliest date first, each with the date it works to', () => {
    const body = planOf([
      testTask({ id: 'T1' }),
      testTask({ id: 'T2', after: ['T1'] }),
      testTask({ id: 'T3', owner: 'bravo', after: ['T1'] }),
      testTask({ id: 'T4', owner: 'charlie', after: ['T1'], due: '2030-01-20' }),
      testTask({ id: 'T5', owner: 'bravo', after: ['T1'], status: 'done' }),
      testTask({ id: 'T6', owner: 'delta', after: ['T3'], due: '2030-01-25' }),
    ]);
    assert.deepEqual(planned(body, 'T1').neededBy, [
      { id: 'T4', owner: 'charlie', due: { due: '2030-01-20', at: '2030-01-20T23:59:59.999Z', from: null } },
      { id: 'T3', owner: 'bravo', due: { due: '2030-01-25', at: '2030-01-25T23:59:59.999Z', from: 'T6' } },
    ]);
    assert.deepEqual(planned(body, 'T2').neededBy, []);
  });

  it('names a needer of another session under an owner filter too, by its id, owner and date alone', () => {
    const body = planOf([testTask({ id: 'T1' }), testTask({ id: 'T2', owner: 'bravo', after: ['T1'], title: 'A title of the needing task' })], 'alpha');
    assert.deepEqual(body.tasks.map((task) => task.id), ['T1']);
    assert.deepEqual(planned(body, 'T1').neededBy, [{ id: 'T2', owner: 'bravo', due: null }]);
    assert.ok(!JSON.stringify(body).includes('A title of the needing task'));
  });

  it('serves each finished task by its work class alone, by number, under the owner filter', () => {
    const tasks = [
      testTask({ id: 'T10', status: 'done', title: 'A finished title' }),
      testTask({ id: 'T2', status: 'dropped', owner: 'bravo' }),
      testTask({ id: 'T3' }),
      testTask({ id: 'T4', status: 'done' }),
    ];
    const tree = new TaskTree(new Map(tasks.map((task) => [task.id, task])), NOW, TimeZone.UTC, null, NO_TASKS_ELSEWHERE, testRanking({ classes: { T10: 'Roadmap' } }));
    const input = { tree, tasks, now: NOW.getTime(), turns: TURNS, ...SETTINGS };
    assert.deepEqual(planBody({ ...input, owner: null }).finished, [
      { id: 'T2', workClass: 'Improvements' },
      { id: 'T4', workClass: 'Improvements' },
      { id: 'T10', workClass: 'Roadmap' },
    ]);
    assert.deepEqual(planBody({ ...input, owner: 'bravo' }).finished, [{ id: 'T2', workClass: 'Improvements' }]);
    assert.deepEqual(planOf([testTask({ id: 'T1' })]).finished, []);
  });

  it('marks a quiet task the park rule takes, and not one an active task needs', () => {
    const body = planOf([testTask({ id: 'T1', ...parkedFacts(NOW.getTime()) }), testTask({ id: 'T2', ...parkedFacts(NOW.getTime()) }), testTask({ id: 'T3', after: ['T2'] })]);
    assert.deepEqual([planned(body, 'T1').parked, planned(body, 'T2').parked, planned(body, 'T3').parked], [true, false, false]);
  });

  it('names each need with where it stands: here, in another register of the tree, or retired', () => {
    const away: TaskElsewhere = { team: 'web', task: testTask({ id: 'T20', owner: 'lead', status: 'in-progress', title: 'A title of another team' }) };
    const tasks = [
      testTask({ id: 'T1', status: 'waiting', startedAt: STARTED, after: ['T2', 'T20'], waits: [{ kind: 'task', id: 'T99' }, { kind: 'task', id: 'T2' }] }),
      testTask({ id: 'T2', owner: 'bravo', status: 'done' }),
    ];
    const body = planOf(tasks, null, new Map([[away.task.id, away]]));
    assert.deepEqual(planned(body, 'T1').needs, [
      { id: 'T2', team: null, owner: 'bravo', status: 'done' },
      { id: 'T20', team: 'web', owner: 'lead', status: 'in-progress' },
      { id: 'T99', team: null, owner: null, status: null },
    ]);
    assert.deepEqual(planned(body, 'T1').next, { kind: 'elsewhere', who: 'lead', task: 'T1', team: 'web', need: 'T20' });
    assert.ok(!JSON.stringify(body).includes('A title'), 'nothing but id, team, owner and status of another team\'s task');
  });

  it('names the first move of each kind by ids alone', () => {
    const body = planOf([
      testTask({ id: 'T1', priority: 1, after: ['T2'] }),
      testTask({ id: 'T2', owner: 'bravo', priority: 3 }),
      working({ id: 'T8', owner: 'bravo', priority: 1 }),
      testTask({ id: 'T3', status: 'waiting', startedAt: STARTED, waits: [{ kind: 'approval', who: 'lead' }] }),
      testTask({ id: 'T4', status: 'waiting', startedAt: STARTED, waits: [{ kind: 'decision', who: 'owner' }] }),
      testTask({ id: 'T5', status: 'waiting', startedAt: STARTED, waits: [{ kind: 'time', at: '2030-01-09 12:00' }] }),
      testTask({ id: 'T6', status: 'waiting', startedAt: STARTED, waits: [{ kind: 'time', at: '2030-01-11' }] }),
    ]);
    assert.deepEqual(planned(body, 'T1').next, { kind: 'work', who: 'bravo', task: 'T2', behind: 'T8' });
    assert.deepEqual(planned(body, 'T8').next, { kind: 'work', who: 'bravo', task: 'T8', behind: null });
    assert.deepEqual(planned(body, 'T3').next, { kind: 'approval', who: 'lead', task: 'T3', behind: null });
    assert.deepEqual(planned(body, 'T4').next, { kind: 'decision', who: 'owner', task: 'T4', behind: null });
    assert.deepEqual(planned(body, 'T5').next, { kind: 'time', who: 'alpha', task: 'T5', behind: null, at: '2030-01-09T12:00:00.000Z' });
    assert.deepEqual(planned(body, 'T6').next, { kind: 'time', who: 'alpha', task: 'T6', behind: null, at: '2030-01-11T23:59:59.999Z' }, 'a day ends in the team\'s zone');
  });

  it('serves a stored time that reads as none as null, never as the text it holds', () => {
    const stored = `soon ${TOKEN}`;
    const body = planOf([testTask({ id: 'T1', status: 'waiting', startedAt: STARTED, waits: [{ kind: 'time', at: stored }] })]);
    assert.deepEqual(planned(body, 'T1').next, { kind: 'time', who: 'alpha', task: 'T1', behind: null, at: null });
    assert.ok(!JSON.stringify(body).includes(TOKEN));
    assert.equal(body.validUntil, null);
  });

  it('serves no move for a task whose every need runs into a loop', () => {
    const body = planOf([working({ id: 'T1', after: ['T2'] }), working({ id: 'T2', after: ['T3'] }), working({ id: 'T3', after: ['T2'] })]);
    assert.equal(planned(body, 'T1').next, null);
  });

  it('refuses a tree built with no ranking, which could place nothing', () => {
    const tasks = [testTask()];
    const tree = new TaskTree(new Map(tasks.map((task) => [task.id, task])), NOW, TimeZone.UTC);
    assert.throws(() => planBody({ tree, tasks, owner: null, now: NOW.getTime(), turns: TURNS, ...SETTINGS }), /needs a tree built with its ranking/);
  });
});

describe('planBody ownerCards', () => {
  it("serves each session's cards on the owner: those asked now in plan order, those put off soonest back first", () => {
    const tasks = [
      cardOf('T1', 'alpha'),
      cardOf('T2', 'alpha', ['2030-01-10']),
      cardOf('T3', 'alpha', ['2030-01-09 12:00']),
      cardOf('T4', 'alpha', [], { pin: 'lead' }),
      cardOf('T5', 'bravo'),
      testTask({ id: 'T6', owner: 'carol', status: 'waiting', waits: [{ kind: 'decision', who: 'lead' }] }),
      working({ id: 'T7', owner: 'dave' }),
    ];
    assert.deepEqual(planOf(tasks).ownerCards, [
      {
        session: 'alpha',
        due: ['T4', 'T1'],
        later: [
          { id: 'T3', until: '2030-01-09 12:00', at: '2030-01-09T12:00:00.000Z' },
          { id: 'T2', until: '2030-01-10', at: '2030-01-10T23:59:59.999Z' },
        ],
      },
      { session: 'bravo', due: ['T5'], later: [] },
    ]);
  });

  it('keeps plan order among cards back at the same time', () => {
    const tasks = [cardOf('T1', 'alpha', ['2030-01-09 12:00']), cardOf('T2', 'alpha', ['2030-01-09 12:00'], { pin: 'lead' })];
    assert.deepEqual(planOf(tasks).ownerCards[0]?.later.map((card) => card.id), ['T2', 'T1']);
  });

  it("serves only the asked session's cards under the owner filter", () => {
    const tasks = [cardOf('T1', 'alpha'), cardOf('T2', 'bravo')];
    assert.deepEqual(planOf(tasks, 'bravo').ownerCards, [{ session: 'bravo', due: ['T2'], later: [] }]);
    assert.deepEqual(planOf(tasks, 'carol').ownerCards, []);
  });

  it("leaves out a card with no gate while the owner's cards need one, and serves it when they do not", () => {
    const tasks = [cardOf('T1', 'alpha', [], { card: TEST_CARD })];
    assert.deepEqual(planOf(tasks).ownerCards, []);
    const input = { tree: treeOf(tasks), tasks, owner: null, now: NOW.getTime(), turns: TURNS };
    assert.deepEqual(planBody({ ...input, ownerMarker: 'owner', requireGate: false }).ownerCards, [{ session: 'alpha', due: ['T1'], later: [] }]);
    assert.deepEqual(planBody({ ...input, ownerMarker: 'boss', requireGate: false }).ownerCards, [], 'another owner marker');
  });
});

describe('planBody validUntil', () => {
  const until = (...tasks: Task[]): string | null => planOf(tasks).validUntil;

  it('is null when no answer turns with the clock', () => {
    assert.equal(until(working()), null);
    assert.equal(until(), null);
    assert.equal(until(working({ due: '2030-01-02' })), null, 'a due long past turns nothing more');
  });

  it('is the day a due comes near, then the due itself', () => {
    assert.equal(until(working({ due: '2030-01-20' })), '2030-01-17T23:59:59.999Z');
    assert.equal(until(working({ due: '2030-01-10' })), '2030-01-10T23:59:59.999Z', 'already near');
  });

  it('reads the due of a task that needs it', () => {
    assert.equal(until(working({ id: 'T1' }), working({ id: 'T2', after: ['T1'], due: '2030-01-10 09:00' })), '2030-01-10T09:00:00.000Z');
  });

  it('is the time a wait ends, a past one turning nothing', () => {
    const waiting = (at: string): Task => testTask({ status: 'waiting', startedAt: STARTED, waits: [{ kind: 'time', at }] });
    assert.equal(until(waiting('2030-01-09 12:00')), '2030-01-09T12:00:00.000Z');
    assert.equal(until(waiting('2030-01-01')), null);
  });

  it('is the day the park rule may take an open task', () => {
    assert.equal(until(testTask({ updatedAt: '2030-01-07T09:00:00.000Z' })), '2030-01-21T09:00:00.000Z');
  });

  it('is the first of them, and counts the tasks of every session under an owner filter', () => {
    const tasks = [testTask({ id: 'T1' }), working({ id: 'T2', owner: 'bravo', due: '2030-01-12' })];
    assert.equal(planOf(tasks).validUntil, '2030-01-09T23:59:59.999Z');
    assert.equal(planOf(tasks, 'alpha').validUntil, '2030-01-09T23:59:59.999Z', 'another session\'s due can move this one\'s rank');
  });
});
