import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_REGISTER } from './defaults.ts';
import { BLOCKER_PRIORITY, isRightNow, NOW_PRIORITY, priorityLevels, priorityName, topPriority } from './priorities.ts';

describe('priorityLevels', () => {
  it('puts the blocker, then p0, ahead of the configured levels, a team with its own levels included', () => {
    assert.deepEqual(priorityLevels(DEFAULT_REGISTER.priorities).map((priority) => priority.id), [-1, 0, 1, 2, 3, 4, 5]);
    assert.deepEqual(priorityLevels([{ id: 2, name: 'soon' }, { id: 4, name: 'later' }]), [BLOCKER_PRIORITY, NOW_PRIORITY, { id: 2, name: 'soon' }, { id: 4, name: 'later' }]);
    assert.deepEqual(priorityLevels([]), [BLOCKER_PRIORITY, NOW_PRIORITY]);
  });
});

describe('priorityName', () => {
  it('names a configured level, above 5 included', () => {
    const priorities = [...DEFAULT_REGISTER.priorities, { id: 7, name: 'someday' }];
    assert.equal(priorityName(priorities, 1), DEFAULT_REGISTER.priorities[0]?.name);
    assert.equal(priorityName(priorities, 7), 'someday');
  });

  it('names p0 and the blocker whatever levels the config lists', () => {
    assert.equal(priorityName(DEFAULT_REGISTER.priorities, 0), NOW_PRIORITY.name);
    assert.equal(priorityName([], 0), NOW_PRIORITY.name);
    assert.equal(priorityName([], -1), BLOCKER_PRIORITY.name);
  });

  it('gives undefined for a level the config does not name', () => {
    assert.equal(priorityName(DEFAULT_REGISTER.priorities, 42), undefined);
    assert.equal(priorityName([], 1), undefined);
    assert.equal(priorityName([], -2), undefined);
  });
});

describe('topPriority', () => {
  it('is the lowest configured id, in any order, and undefined for none', () => {
    assert.equal(topPriority(DEFAULT_REGISTER.priorities), 1);
    assert.equal(topPriority([{ id: 4, name: 'later' }, { id: 2, name: 'now' }, { id: 3, name: 'soon' }]), 2);
    assert.equal(topPriority([]), undefined);
  });
});

describe('isRightNow', () => {
  it('takes p0 and the blocker above it, and no configured level (T4414, T4329)', () => {
    assert.deepEqual([BLOCKER_PRIORITY.id, NOW_PRIORITY.id, 1, 2].map(isRightNow), [true, true, false, false]);
  });
});
