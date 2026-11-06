import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TimeZone } from '../core/zone.ts';
import type { Task } from '../register/fold.ts';
import { NO_TASKS_ELSEWHERE, type TasksElsewhere } from '../register/tree.ts';
import { parkedFacts, TEST_PARKING } from '../testing/ranking.ts';
import { testTask } from '../testing/task.ts';
import type { WakeRest } from './decide.ts';
import { keepWorkingOf, keepWorkingReason, type KeepWorking } from './keep-working.ts';

const NOW = Date.parse('2030-01-08T10:00:00.000Z');
const ASK = { task: 'T1', at: '2030-01-08T09:59:00.000Z' };
const WAITING = testTask({ id: 'T1', title: 'Pick the plan', status: 'waiting', waits: [{ kind: 'decision', who: 'owner' }] });

function tasksOf(...tasks: readonly Task[]): ReadonlyMap<string, Task> {
  return new Map(tasks.map((task) => [task.id, task]));
}

const AWAKE: WakeRest = { quiet: false, held: false };

function workOf(tasks: ReadonlyMap<string, Task>, rest = AWAKE, elsewhere: TasksElsewhere = NO_TASKS_ELSEWHERE): KeepWorking | undefined {
  return keepWorkingOf({ tasks, elsewhere, session: 'alpha', ask: ASK, now: NOW, zone: TimeZone.UTC, rest, parking: TEST_PARKING });
}

function idsOf(tasks: ReadonlyMap<string, Task>, elsewhere: TasksElsewhere = NO_TASKS_ELSEWHERE): readonly string[] | undefined {
  return workOf(tasks, AWAKE, elsewhere)?.startable.map((task) => task.id);
}

describe('keepWorkingOf', () => {
  it('never sends the session to a parked task, which the list it points at leaves out (T2090)', () => {
    const parked = testTask({ id: 'T2', ...parkedFacts(NOW) });
    assert.deepEqual(idsOf(tasksOf(WAITING, parked, testTask({ id: 'T3', priority: 3 }))), ['T3']);
    assert.equal(workOf(tasksOf(WAITING, parked)), undefined);
  });

  it('sends the session to its independent tasks, most urgent first', () => {
    const tasks = tasksOf(
      WAITING,
      testTask({ id: 'T2', priority: 3 }),
      testTask({ id: 'T3', status: 'in-progress', priority: 1 }),
      testTask({ id: 'T4', priority: 2, after: ['T9'] }),
      testTask({ id: 'T9', status: 'done', owner: 'bravo' }),
    );
    assert.deepEqual(idsOf(tasks), ['T3', 'T4', 'T2']);
    assert.equal(workOf(tasks)?.waiting, WAITING);
  });

  it("leaves a task after another team's open task of the tree, and sends the session to it once that team finished it (T1139)", () => {
    const tasks = tasksOf(WAITING, testTask({ id: 'T2', after: ['T9'] }), testTask({ id: 'T3', priority: 3 }));
    const held = (status: 'in-progress' | 'done'): TasksElsewhere => new Map([['T9', { team: 'app', task: testTask({ id: 'T9', owner: 'web', status }) }]]);
    assert.deepEqual(idsOf(tasks, held('in-progress')), ['T3']);
    assert.deepEqual(idsOf(tasks, held('done')), ['T2', 'T3']);
  });

  it('sends nobody back in quiet hours or while the budget holds it', () => {
    const tasks = tasksOf(WAITING, testTask({ id: 'T2' }));
    assert.equal(workOf(tasks, { quiet: true, held: false }), undefined);
    assert.equal(workOf(tasks, { quiet: false, held: true }), undefined);
  });

  it('leaves the tasks that depend on the waiting one, directly or through another unfinished task', () => {
    const tasks = tasksOf(
      WAITING,
      testTask({ id: 'T2', after: ['T1'] }),
      testTask({ id: 'T3', after: ['T2'] }),
      testTask({ id: 'T4', after: ['T8', 'T1'] }),
      testTask({ id: 'T5' }),
      testTask({ id: 'T8', status: 'done' }),
    );
    assert.deepEqual(idsOf(tasks), ['T5']);
  });

  it('finds nothing when every other task depends on the waiting one, waits, verifies, is closed or is not the session\'s', () => {
    const tasks = tasksOf(
      WAITING,
      testTask({ id: 'T2', after: ['T1'] }),
      testTask({ id: 'T3', status: 'waiting', waits: [{ kind: 'task', id: 'T7' }] }),
      testTask({ id: 'T4', status: 'verifying' }),
      testTask({ id: 'T5', status: 'done' }),
      testTask({ id: 'T6', status: 'dropped' }),
      testTask({ id: 'T7', owner: 'bravo' }),
    );
    assert.equal(workOf(tasks), undefined);
  });

  it('finds nothing once the task stopped waiting, changed hands or is gone', () => {
    const other = testTask({ id: 'T2' });
    assert.equal(idsOf(tasksOf({ ...WAITING, status: 'in-progress', waits: [] }, other)), undefined);
    assert.equal(idsOf(tasksOf({ ...WAITING, owner: 'bravo' }, other)), undefined);
    assert.equal(idsOf(tasksOf(other)), undefined);
  });

  it('counts a wait of any kind: a peer task or a time holds the task as a decision does', () => {
    const other = testTask({ id: 'T2' });
    assert.deepEqual(idsOf(tasksOf({ ...WAITING, waits: [{ kind: 'task', id: 'T7' }] }, other, testTask({ id: 'T7', owner: 'bravo' }))), ['T2']);
    assert.deepEqual(idsOf(tasksOf({ ...WAITING, waits: [{ kind: 'time', at: '2030-01-09 12:00' }] }, other)), ['T2']);
  });

  it('never sends the session to the waiting task itself, even once its waits cleared', () => {
    const cleared: Task = { ...WAITING, waits: [{ kind: 'time', at: '2030-01-08 09:00' }] };
    assert.deepEqual(idsOf(tasksOf(cleared, testTask({ id: 'T2' }))), ['T2']);
    assert.equal(idsOf(tasksOf(cleared)), undefined);
  });
});

describe('keepWorkingReason', () => {
  it('names what the task waits on, the work to do instead and how to end a turn that already does it', () => {
    const tasks = tasksOf(WAITING, testTask({ id: 'T2', title: 'Fix the login', priority: 1 }), testTask({ id: 'T3', title: 'Tidy the docs' }));
    const work = workOf(tasks);
    assert.ok(work !== undefined);
    assert.equal(
      keepWorkingReason('alpha', work, TimeZone.UTC),
      'T1 waits (decision owner), and you own work that does not come after it: T2 "Fix the login" (p1), T3 "Tidy the docs" (p2). ' +
        'Work it now in plan order (`teamrig list --session alpha`); leave a task that is the same change as T1, and say so in one line. ' +
        'If you already work one and wait on a background step, end the turn again.',
    );
  });
});
