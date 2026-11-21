import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Task } from '../register/fold.ts';
import { BLOCKER_PRIORITY_ID } from '../register/model.ts';
import { testTask } from '../testing/task.ts';
import type { RegisterTasks } from './groups.ts';
import { actorsOf, blockerNamedIn } from './blocker-named.ts';

function registerOf(team: string, tasks: readonly Task[]): RegisterTasks {
  return { team, tasks: new Map(tasks.map((task) => [task.id, task])) };
}

const P0 = testTask({ id: 'T7', priority: 0, status: 'in-progress' });
const BLOCKER = testTask({ id: 'T8', priority: BLOCKER_PRIORITY_ID, status: 'waiting' });
const P1 = testTask({ id: 'T9', priority: 1, status: 'open' });
const DONE_BLOCKER = testTask({ id: 'T10', priority: BLOCKER_PRIORITY_ID, status: 'done' });

describe('blockerNamedIn (T4414, T4329)', () => {
  it('finds an unfinished blocker the line names, past a p1 and a p0 named first, with the team that holds it', () => {
    const app = registerOf('app', [P0, P1, BLOCKER]);
    const found = blockerNamedIn('T9 is merged; T7 next; T8 waits on your review', [app], 'app');
    assert.deepEqual([found?.task.id, found?.team], ['T8', 'app']);
  });

  it('finds nothing for p0 work: it reaches its receiver through the normal wake gate', () => {
    assert.equal(blockerNamedIn('T7 needs your review', [registerOf('app', [P0])], 'app'), undefined);
  });

  it('finds nothing for a finished blocker, a p1, an unknown id or a word that only starts with T and digits', () => {
    const app = registerOf('app', [BLOCKER, P1, DONE_BLOCKER]);
    assert.equal(blockerNamedIn('T10 is done', [app], 'app'), undefined);
    assert.equal(blockerNamedIn('T9 next', [app], 'app'), undefined);
    assert.equal(blockerNamedIn('T404 and T8x and xT8', [app], 'app'), undefined);
  });

  it("reads an id as the reader's own register holds it before another team's", () => {
    const own = registerOf('web', [testTask({ id: 'T8', priority: 2, status: 'open' })]);
    const other = registerOf('app', [BLOCKER]);
    assert.equal(blockerNamedIn('T8 please', [other, own], 'web'), undefined, "web's T8 is a p2");
    assert.equal(blockerNamedIn('T8 please', [other], 'web')?.team, 'app', "with no T8 of its own, web reads app's");
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
