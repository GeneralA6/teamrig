import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { taskIdIn } from './posted.ts';

describe('taskIdIn', () => {
  it('finds a task id alone or after a team, and nothing in a word or a pull request number', () => {
    assert.equal(taskIdIn('Fixed in T12.'), 'T12');
    assert.equal(taskIdIn('see bravo/T7 first'), 'T7');
    assert.equal(taskIdIn('Merged as #624 (plugin 0.353.2); TTL and AT9x stay'), undefined);
  });
});
