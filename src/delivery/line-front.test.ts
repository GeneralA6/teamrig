import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isLineFront } from './line-front.ts';

const FRONT = { task: 'T5', at: '2026-11-08T11:50:00.000Z', by: 'lead' };

describe('isLineFront', () => {
  it('reads a front, ignoring a field another kit adds, and refuses a task, time or lead it cannot read', () => {
    assert.equal(isLineFront({ ...FRONT, extra: 1 }), true);
    const bad: readonly unknown[] = [null, 'T5', { ...FRONT, task: 5 }, { ...FRONT, at: 'soon' }, { ...FRONT, by: undefined }];
    assert.deepEqual(bad.filter(isLineFront), []);
  });
});
