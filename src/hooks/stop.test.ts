import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { RefreshState } from '../refresh/state.ts';
import { stopOutput, tabTitleSequence } from './stop.ts';

const STATE: RefreshState = { phase: 'ready', task: 'T12', at: '2030-01-08T10:00:00.000Z', noticed: true };

describe('stopOutput', () => {
  it('keeps the session going with the reason when it blocks', () => {
    assert.deepEqual(JSON.parse(stopOutput({ kind: 'block', state: STATE, reason: 'Write your handover.' })), {
      decision: 'block',
      reason: 'Write your handover.',
    });
  });

  it('shows the notice, and marks the tab only when there is a title', () => {
    assert.deepEqual(JSON.parse(stopOutput({ kind: 'notice', state: STATE, message: 'type /clear', title: 'api: type /clear' })), {
      systemMessage: 'type /clear',
      terminalSequence: '\u001b]0;api: type /clear\u0007',
    });
    assert.deepEqual(JSON.parse(stopOutput({ kind: 'notice', state: STATE, message: 'type /clear', title: undefined })), { systemMessage: 'type /clear' });
  });

  it('prints nothing for every other decision', () => {
    assert.equal(stopOutput({ kind: 'none' }), '');
    assert.equal(stopOutput({ kind: 'measure' }), '');
    assert.equal(stopOutput({ kind: 'write', state: STATE }), '');
  });

  it('sets the tab title with OSC 0', () => {
    assert.equal(tabTitleSequence('x'), '\u001b]0;x\u0007');
  });
});
