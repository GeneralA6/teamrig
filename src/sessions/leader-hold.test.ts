import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Task } from '../register/fold.ts';
import { testTask } from '../testing/task.ts';
import { leaderHoldOf, leadNeverCloses, type LeaderHoldInput } from './leader-hold.ts';

function tasksOf(...tasks: Task[]): ReadonlyMap<string, Task> {
  return new Map(tasks.map((task) => [task.id, task]));
}

/** Sub-lead `web` leading `ui` and `api`, none running, no task. */
function input(fields: Partial<LeaderHoldInput> = {}): LeaderHoldInput {
  return { leader: 'web', tasks: new Map(), ownerMarker: undefined, led: ['ui', 'api'], running: new Set(), ...fields };
}

const waitingOn = (who: string, kind: 'approval' | 'decision' = 'approval', fields: Partial<Task> = {}): Task =>
  testTask({ id: 'T5', owner: 'ui', status: 'waiting', waits: [{ kind, who }], ...fields });

describe('leadNeverCloses', () => {
  it('keeps the lead of a root team only, unless every lead is kept (T3387)', () => {
    assert.equal(leadNeverCloses({ leaders: 'root' }, undefined), true, 'a config from before team trees is a root');
    assert.equal(leadNeverCloses({ leaders: 'root' }, {}), true);
    assert.equal(leadNeverCloses({ leaders: 'root' }, { parent: 'org' }), false);
    assert.equal(leadNeverCloses({ leaders: 'all' }, { parent: 'org' }), true);
  });
});

describe('leaderHoldOf', () => {
  it('holds nothing for a leader nothing waits on and none of whose sessions runs', () => {
    assert.equal(leaderHoldOf(input()), undefined);
    assert.equal(leaderHoldOf(input({ running: new Set(['web', 'other']) })), undefined, 'its own run, or one it does not lead, holds nothing');
  });

  it('holds a leader whose approval or decision a live task waits for', () => {
    const approval = waitingOn('web');
    assert.deepEqual(leaderHoldOf(input({ tasks: tasksOf(approval) })), { kind: 'waits', task: approval, reason: { kind: 'approval', who: 'web' } });
    const decision = waitingOn('web', 'decision', { status: 'verifying' });
    assert.deepEqual(leaderHoldOf(input({ tasks: tasksOf(decision) })), { kind: 'waits', task: decision, reason: { kind: 'decision', who: 'web' } });
  });

  it('holds nothing for a wait it answered, one naming another, or a finished task', () => {
    const answered = waitingOn('web', 'approval', { answer: { verdict: 'approved', by: 'web', at: '2030-01-08T09:00:00.000Z', note: null } });
    const decided = waitingOn('web', 'decision', { decided: { by: 'web', at: '2030-01-08T09:00:00.000Z', note: 'go' } });
    const elsewhere = waitingOn('lead');
    const done = waitingOn('web', 'approval', { status: 'done' });
    for (const task of [answered, decided, elsewhere, done]) {
      assert.equal(leaderHoldOf(input({ tasks: tasksOf(task) })), undefined, task.status);
    }
  });

  it("holds the team's lead for the owner's waits it takes the answers to, and a sub-lead never", () => {
    const owner = waitingOn('owner', 'decision');
    assert.equal(leaderHoldOf(input({ tasks: tasksOf(owner) })), undefined);
    assert.deepEqual(leaderHoldOf(input({ leader: 'lead', ownerMarker: 'owner', tasks: tasksOf(owner) })), { kind: 'waits', task: owner, reason: { kind: 'decision', who: 'owner' } });
  });

  it('holds a leader while a session it leads runs, a wait first', () => {
    assert.deepEqual(leaderHoldOf(input({ running: new Set(['api']) })), { kind: 'leads', session: 'api' });
    const approval = waitingOn('web');
    assert.equal(leaderHoldOf(input({ tasks: tasksOf(approval), running: new Set(['api']) }))?.kind, 'waits');
  });
});
