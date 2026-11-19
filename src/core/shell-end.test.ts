import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { endOf } from './shell-end.ts';

describe('endOf', () => {
  it('reads an exit code, or the signal when there is none', () => {
    assert.deepEqual(endOf(3, null), { kind: 'exited', code: 3 });
    assert.deepEqual(endOf(null, 'SIGTERM'), { kind: 'signal', signal: 'SIGTERM' });
    assert.deepEqual(endOf(null, null), { kind: 'signal', signal: 'an unknown signal' });
  });
});
