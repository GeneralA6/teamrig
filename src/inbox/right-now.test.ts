import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Task } from '../register/fold.ts';
import { testTask } from '../testing/task.ts';
import type { RegisterTasks } from './groups.ts';
import { rightNowNamedIn } from './right-now.ts';

function registerOf(team: string, tasks: readonly Task[]): RegisterTasks {
  return { team, tasks: new Map(tasks.map((task) => [task.id, task])) };
}

const P0 = testTask({ id: 'T7', priority: 0, status: 'in-progress' });
const BLOCKER = testTask({ id: 'T8', priority: -1, status: 'waiting' });
const P1 = testTask({ id: 'T9', priority: 1, status: 'open' });
const DONE_P0 = testTask({ id: 'T10', priority: 0, status: 'done' });

describe('rightNowNamedIn (T4414)', () => {
  it('finds an unfinished p0 the line names, past a p1 named first', () => {
    const app = registerOf('app', [P0, P1]);
    assert.equal(rightNowNamedIn('T9 is merged; T7 waits on your review', [app], 'app')?.id, 'T7');
  });

  it('counts a level above p0 as right-now work', () => {
    assert.equal(rightNowNamedIn('T8 needs your approval', [registerOf('app', [BLOCKER])], 'app')?.id, 'T8');
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
    assert.equal(rightNowNamedIn('T7 please', [other], 'web')?.id, 'T7', "with no T7 of its own, web reads app's");
  });
});
