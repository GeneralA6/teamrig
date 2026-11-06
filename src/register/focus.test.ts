import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_FOCUS } from '../config/defaults.ts';
import { testTask } from '../testing/task.ts';
import { classOf } from './focus.ts';

describe('classOf (T2076)', () => {
  it("reads a task's own class, and one with none as the team's default class", () => {
    assert.equal(classOf(testTask({ workClass: 'Roadmap' }), DEFAULT_FOCUS), 'Roadmap');
    assert.equal(classOf(testTask({ workClass: null }), DEFAULT_FOCUS), 'Improvements');
    assert.equal(classOf(testTask(), { defaultClass: 'Chores' }), 'Chores');
  });

  it('keeps a class the team has since renamed out of focus.classes, as written', () => {
    assert.equal(classOf(testTask({ workClass: 'Tech debt' }), DEFAULT_FOCUS), 'Tech debt');
  });
});
