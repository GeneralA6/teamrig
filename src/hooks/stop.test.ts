import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { RefreshState } from '../refresh/state.ts';
import { stopOutput, tabTitleSequence } from './stop.ts';

const STATE: RefreshState = { phase: 'ready', task: 'T12', at: '2030-01-08T10:00:00.000Z', noticed: true, transcript: null };

describe('stopOutput', () => {
  it('keeps the session going with the reason when it blocks', () => {
    assert.deepEqual(JSON.parse(stopOutput({ kind: 'block', state: STATE, reason: 'Write your handover.' })), {
      decision: 'block',
      reason: 'Write your handover.',
    });
  });

  it('shows the notice, and marks the tab only when there is a title', () => {
    assert.deepEqual(JSON.parse(stopOutput({ kind: 'notice', state: STATE, message: 'type /clear', title: 'api: type /clear', restart: false })), {
      systemMessage: 'type /clear',
      terminalSequence: '\u001b]0;api: type /clear\u0007',
    });
    assert.deepEqual(JSON.parse(stopOutput({ kind: 'notice', state: STATE, message: 'type /clear', title: undefined, restart: false })), { systemMessage: 'type /clear' });
  });

  it('shows the model notices with a block, after a notice, or alone', () => {
    const notices = ['MODEL api runs at low effort', 'MODEL api now runs model claude-opus-4-8'];
    assert.deepEqual(JSON.parse(stopOutput({ kind: 'block', state: STATE, reason: 'Write your handover.' }, notices)), {
      decision: 'block',
      reason: 'Write your handover.',
      systemMessage: 'MODEL api runs at low effort\nMODEL api now runs model claude-opus-4-8',
    });
    assert.deepEqual(JSON.parse(stopOutput({ kind: 'notice', state: STATE, message: 'type /clear', title: 'api: type /clear', restart: false }, notices.slice(0, 1))), {
      systemMessage: 'type /clear\nMODEL api runs at low effort',
      terminalSequence: '\u001b]0;api: type /clear\u0007',
    });
    assert.deepEqual(JSON.parse(stopOutput({ kind: 'none' }, notices.slice(1))), { systemMessage: 'MODEL api now runs model claude-opus-4-8' });
    assert.deepEqual(JSON.parse(stopOutput({ kind: 'write', state: STATE }, notices.slice(1))), { systemMessage: 'MODEL api now runs model claude-opus-4-8' });
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
