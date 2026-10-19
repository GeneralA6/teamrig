import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { testTask } from '../testing/task.ts';
import type { Task } from './fold.ts';
import { MAX_PLACES_SHOWN, stopgapFlags, stopgapTags } from './stopgap.ts';
import { TimeZone } from '../core/zone.ts';

function tasksOf(...tasks: Task[]): ReadonlyMap<string, Task> {
  return new Map(tasks.map((task) => [task.id, task]));
}

describe('stopgapTags', () => {
  it('finds every tag with its line, several on one line and across CRLF lines', () => {
    const text = 'intro\r\n- cap the pool (stopgap T316), and stopgap T321 too\r\nno tag: stopgap T, stopgaps T9, astopgap T7\nstopgap T42';
    assert.deepEqual(stopgapTags('CLAUDE.md', text), [
      { id: 'T316', at: 'CLAUDE.md:2' },
      { id: 'T321', at: 'CLAUDE.md:2' },
      { id: 'T42', at: 'CLAUDE.md:4' },
    ]);
  });

  it('finds none in a text without tags', () => {
    assert.deepEqual(stopgapTags('a.md', ''), []);
  });
});

describe('stopgapFlags', () => {
  it('flags a done task once with every place, and a dropped task with its own ask', () => {
    const done = testTask({ id: 'T1', status: 'done' });
    const dropped = testTask({ id: 'T2', status: 'dropped' });
    const flags = stopgapFlags(
      [
        { id: 'T1', at: 'CLAUDE.md:3' },
        { id: 'T2', at: 'rules/x.md:1' },
        { id: 'T1', at: 'ship/SKILL.md:81' },
      ],
      tasksOf(done, dropped), TimeZone.UTC,
    );
    assert.deepEqual(flags, [
      { kind: 'STOPGAP-DONE', task: done, detail: 'tagged in CLAUDE.md:3, ship/SKILL.md:81; remove the stopgap' },
      { kind: 'STOPGAP-DONE', task: dropped, detail: 'tagged in rules/x.md:1; replace the task or keep the stopgap by a decision' },
    ]);
  });

  it(`names the first ${MAX_PLACES_SHOWN} places and counts the rest`, () => {
    const tags = ['a:1', 'b:2', 'c:3', 'd:4', 'e:5'].map((at) => ({ id: 'T1', at }));
    const [flag] = stopgapFlags(tags, tasksOf(testTask({ id: 'T1', status: 'done' })), TimeZone.UTC);
    assert.equal(flag?.detail, 'tagged in a:1, b:2, c:3 and 2 more; remove the stopgap');
  });

  it('leaves tags of active tasks and of unknown ids alone', () => {
    const active = (['open', 'in-progress', 'waiting', 'verifying'] as const).map((status, index) => testTask({ id: `T${index + 1}`, status }));
    const tags = ['T1', 'T2', 'T3', 'T4', 'T99'].map((id) => ({ id, at: 'CLAUDE.md:1' }));
    assert.deepEqual(stopgapFlags(tags, tasksOf(...active), TimeZone.UTC), []);
  });
});
