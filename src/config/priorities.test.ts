import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_REGISTER } from './defaults.ts';
import { priorityName, topPriority } from './priorities.ts';

describe('priorityName', () => {
  it('names a configured level, above 5 included', () => {
    const priorities = [...DEFAULT_REGISTER.priorities, { id: 7, name: 'someday' }];
    assert.equal(priorityName(priorities, 1), DEFAULT_REGISTER.priorities[0]?.name);
    assert.equal(priorityName(priorities, 7), 'someday');
  });

  it('gives undefined for a level the config does not name', () => {
    assert.equal(priorityName(DEFAULT_REGISTER.priorities, 42), undefined);
    assert.equal(priorityName([], 1), undefined);
  });
});

describe('topPriority', () => {
  it('is the lowest configured id, in any order, and undefined for none', () => {
    assert.equal(topPriority(DEFAULT_REGISTER.priorities), 1);
    assert.equal(topPriority([{ id: 4, name: 'later' }, { id: 2, name: 'now' }, { id: 3, name: 'soon' }]), 2);
    assert.equal(topPriority([]), undefined);
  });
});
