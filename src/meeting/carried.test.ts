import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TimeZone } from '../core/zone.ts';
import type { RegisterEvent, UpdateEvent } from '../register/events.ts';
import type { Task } from '../register/fold.ts';
import { TaskTree } from '../register/tree.ts';
import { testTask } from '../testing/task.ts';
import { answeredKeys, carriedKeys } from './carried.ts';
import type { Decision } from './decision-order.ts';

const START = Date.parse('2030-01-08T09:00:00Z');
const DURING = '2030-01-08T09:10:00.000Z';

function update(id: string, overrides: Partial<UpdateEvent> = {}): UpdateEvent {
  return { v: 1, type: 'update', id, at: DURING, by: 'lead', changes: {}, note: 'owner decided: go', ...overrides };
}

function decisionOf(task: Task, team: string | undefined = undefined): Decision {
  return { task, team, tree: new TaskTree(new Map([[task.id, task]]), new Date(START), TimeZone.UTC) };
}

describe('the cards a meeting carries over (T2775)', () => {
  it("counts a Decided and a Later the lead recorded since the start as answered, by each register's label", () => {
    const own: RegisterEvent[] = [update('T1', { decided: true }), update('T2', { waits: [{ kind: 'time', at: '2030-01-10T09:00:00.000Z' }] })];
    const web: RegisterEvent[] = [update('T1', { by: 'app/lead', decided: true })];
    const answered = answeredKeys(
      [
        { events: own, decidedBy: 'lead', team: undefined },
        { events: web, decidedBy: 'app/lead', team: 'web' },
      ],
      START,
    );
    assert.deepEqual([...answered], ['T1', 'T2', 'web/T1']);
  });

  it('counts no plain note, no answer before the start, and none another session wrote', () => {
    const events: RegisterEvent[] = [
      update('T1', { changes: { priority: 1 } }),
      update('T2', { decided: true, at: '2030-01-08T08:59:59.000Z' }),
      update('T3', { decided: true, by: 'alpha' }),
      update('T4', { waits: [{ kind: 'decision', who: 'owner' }] }),
      { v: 1, type: 'create', id: 'T5', at: DURING, by: 'lead', task: testTask({ id: 'T5' }) },
    ];
    assert.deepEqual([...answeredKeys([{ events, decidedBy: 'lead', team: undefined }], START)], []);
  });

  it('carries every asked card with no answer, in the order asked, a card of a team under the lead by its label', () => {
    const asked = [decisionOf(testTask({ id: 'T3' })), decisionOf(testTask({ id: 'T1' })), decisionOf(testTask({ id: 'T1' }), 'web')];
    assert.deepEqual(carriedKeys(asked, new Set(['T1'])), ['T3', 'web/T1']);
    assert.deepEqual(carriedKeys(asked, new Set(['T3', 'T1', 'web/T1'])), []);
  });
});
