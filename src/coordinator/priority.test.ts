import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { constants } from 'node:os';
import { lowerStep, STEP_PRIORITY, type Priorities } from './priority.ts';

/** Priorities held in a map, each `set` recorded; `fail` makes a read or a set throw as the system does. */
class FakePriorities implements Priorities {
  readonly sets: Array<readonly [number, number]> = [];
  failing: 'of' | 'set' | undefined;
  private readonly held: Map<number, number>;

  constructor(held: Map<number, number>) {
    this.held = held;
  }

  of(pid: number): number {
    if (this.failing === 'of') {
      throw new Error('ESRCH: no such process');
    }
    return this.held.get(pid) ?? constants.priority.PRIORITY_NORMAL;
  }

  set(pid: number, priority: number): void {
    if (this.failing === 'set') {
      throw new Error('EACCES: permission denied');
    }
    this.sets.push([pid, priority]);
    this.held.set(pid, priority);
  }
}

describe('lowerStep', () => {
  it('is below normal priority, so the owner’s apps win the CPU', () => {
    assert.equal(STEP_PRIORITY, constants.priority.PRIORITY_BELOW_NORMAL);
  });

  it('lowers a step that runs at normal priority', () => {
    const priorities = new FakePriorities(new Map());
    lowerStep(priorities, 41);
    assert.deepEqual(priorities.sets, [[41, STEP_PRIORITY]]);
  });

  it('never raises a step that runs lower already', () => {
    const priorities = new FakePriorities(new Map([[41, constants.priority.PRIORITY_LOW]]));
    lowerStep(priorities, 41);
    assert.deepEqual(priorities.sets, []);
  });

  it('leaves a step at its priority, without failing it, when the system cannot read or set it', () => {
    for (const failing of ['of', 'set'] as const) {
      const priorities = new FakePriorities(new Map());
      priorities.failing = failing;
      assert.doesNotThrow(() => lowerStep(priorities, 41));
      assert.deepEqual(priorities.sets, []);
    }
  });
});
