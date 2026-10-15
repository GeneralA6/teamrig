import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_REGISTER } from './defaults.ts';
import { priorityName } from './priorities.ts';

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
