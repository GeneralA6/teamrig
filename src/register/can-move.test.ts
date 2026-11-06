import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TimeZone } from '../core/zone.ts';
import { canMove } from './can-move.ts';
import type { TaskStatus } from './model.ts';
import { waitContext, type WaitReason } from './waits.ts';

const NOW = new Date('2030-01-10T12:00:00.000Z');
const TASKS = new Map<string, { readonly status: TaskStatus }>([
  ['T1', { status: 'done' }],
  ['T2', { status: 'dropped' }],
  ['T3', { status: 'in-progress' }],
  ['T4', { status: 'waiting' }],
]);
const CONTEXT = waitContext(TASKS, NOW, TimeZone.UTC);

const DECISION: WaitReason = { kind: 'decision', who: 'owner' };
const APPROVAL: WaitReason = { kind: 'approval', who: 'lead' };

describe('canMove', () => {
  const on = (...waits: readonly WaitReason[]): boolean => canMove({ after: [], waits }, CONTEXT);

  it('is true with no wait and nothing to come after', () => {
    assert.equal(on(), true);
  });

  it('is false while any wait stands: a person, a time to come, a task not finished', () => {
    assert.equal(on(DECISION), false);
    assert.equal(on(APPROVAL), false);
    assert.equal(on({ kind: 'time', at: '2030-01-11 12:00' }), false);
    assert.equal(on({ kind: 'task', id: 'T3' }), false);
  });

  it('is true once every wait has cleared, and false while one of several stands', () => {
    assert.equal(on({ kind: 'task', id: 'T1' }, { kind: 'time', at: '2030-01-09 12:00' }), true);
    assert.equal(on({ kind: 'task', id: 'T1' }, DECISION), false);
  });

  it('reads the tasks it comes after, finished or not', () => {
    assert.equal(canMove({ after: ['T1', 'T2'], waits: [] }, CONTEXT), true);
    assert.equal(canMove({ after: ['T1', 'T4'], waits: [] }, CONTEXT), false);
  });
});
