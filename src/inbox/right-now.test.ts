import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Task } from '../register/fold.ts';
import { testTask } from '../testing/task.ts';
import type { RegisterTasks } from './groups.ts';
import { actorsOf, rightNowNamedIn } from './right-now.ts';

function registerOf(team: string, tasks: readonly Task[]): RegisterTasks {
  return { team, tasks: new Map(tasks.map((task) => [task.id, task])) };
}

const P0 = testTask({ id: 'T7', priority: 0, status: 'in-progress' });
const BLOCKER = testTask({ id: 'T8', priority: -1, status: 'waiting' });
const P1 = testTask({ id: 'T9', priority: 1, status: 'open' });
const DONE_P0 = testTask({ id: 'T10', priority: 0, status: 'done' });

describe('rightNowNamedIn (T4414)', () => {
  it('finds an unfinished p0 the line names, past a p1 named first, with the team that holds it', () => {
    const app = registerOf('app', [P0, P1]);
    const found = rightNowNamedIn('T9 is merged; T7 waits on your review', [app], 'app');
    assert.deepEqual([found?.task.id, found?.team], ['T7', 'app']);
  });

  it('counts a level above p0 as right-now work', () => {
    assert.equal(rightNowNamedIn('T8 needs your approval', [registerOf('app', [BLOCKER])], 'app')?.task.id, 'T8');
  });

  it('finds nothing for a finished p0, a p1, an unknown id or a word that only starts with T and digits', () => {
    const app = registerOf('app', [P0, P1, DONE_P0]);
    assert.equal(rightNowNamedIn('T10 is done', [app], 'app'), undefined);
    assert.equal(rightNowNamedIn('T9 next', [app], 'app'), undefined);
    assert.equal(rightNowNamedIn('T404 and T7x and xT7', [app], 'app'), undefined);
  });

  it("reads an id as the reader's own register holds it before another team's", () => {
    const own = registerOf('web', [testTask({ id: 'T7', priority: 2, status: 'open' })]);
    const other = registerOf('app', [P0]);
    assert.equal(rightNowNamedIn('T7 please', [other, own], 'web'), undefined, "web's T7 is a p2");
    assert.equal(rightNowNamedIn('T7 please', [other], 'web')?.team, 'app', "with no T7 of its own, web reads app's");
  });
});

describe('actorsOf (T4431)', () => {
  it('names the owner, the owners of the unfinished tasks it needs, and who its unanswered asks wait on, each once', () => {
    const p0 = testTask({
      id: 'T7',
      priority: 0,
      status: 'waiting',
      owner: 'alpha',
      after: ['T2', 'T3'],
      waits: [{ kind: 'task', id: 'T4' }, { kind: 'task', id: 'T2' }, { kind: 'approval', who: 'lead' }, { kind: 'time', at: '2030-01-09T10:00:00Z' }],
    });
    const app = registerOf('app', [
      p0,
      testTask({ id: 'T2', owner: 'bravo', status: 'in-progress' }),
      testTask({ id: 'T3', owner: 'charlie', status: 'done' }),
      testTask({ id: 'T4', owner: 'alpha', status: 'open' }),
    ]);
    assert.deepEqual(actorsOf({ task: p0, team: 'app' }, [app]), [
      { team: 'app', id: 'alpha' },
      { team: 'app', id: 'bravo' },
      { team: 'app', id: 'lead' },
    ]);
  });

  it("reads a need another team's register holds as that team's session, and drops an answered approval", () => {
    const p0 = testTask({ id: 'T7', priority: 0, status: 'waiting', owner: 'alpha', after: ['T20'], waits: [{ kind: 'approval', who: 'lead' }], answer: { verdict: 'approved', by: 'lead', at: '2030-01-08T09:00:00.000Z', note: 'go' } });
    const app = registerOf('app', [p0]);
    const web = registerOf('web', [testTask({ id: 'T20', owner: 'front', status: 'open' })]);
    assert.deepEqual(actorsOf({ task: p0, team: 'app' }, [app, web]), [
      { team: 'app', id: 'alpha' },
      { team: 'web', id: 'front' },
    ]);
  });
});
