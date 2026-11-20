import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { StopDecision } from '../refresh/decide.ts';
import type { RefreshState } from '../refresh/state.ts';
import { replyText } from '../testing/host.ts';
import { blockReply, stopReply } from './stop.ts';

const STATE: RefreshState = { phase: 'ready', task: 'T12', at: '2030-01-08T10:00:00.000Z', tokens: null, noticed: true, transcript: null, claudePid: null };

/** What the shipped host reads on the hook's standard output for the reply at a turn's end. */
function stopOutput(decision: StopDecision, notices?: readonly string[], tabTitle?: string): string {
  return replyText('stop', stopReply(decision, notices, tabTitle));
}

/** The same for a block with any reason. */
function blockOutput(reason: string, notices?: readonly string[]): string {
  return replyText('stop', blockReply(reason, notices));
}

describe('stopReply', () => {
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
    assert.deepEqual(stopReply({ kind: 'none' }), { notice: undefined, tabTitle: undefined });
    assert.equal(stopOutput({ kind: 'none' }), '');
    assert.equal(stopOutput({ kind: 'measure' }), '');
    assert.equal(stopOutput({ kind: 'write', state: STATE }), '');
  });

  it("sets the tab status title at any end but a block's, over a notice's own title", () => {
    const sequence = '\u001b]0;ready api\u0007';
    assert.deepEqual(JSON.parse(stopOutput({ kind: 'none' }, [], 'ready api')), { terminalSequence: sequence });
    assert.deepEqual(JSON.parse(stopOutput({ kind: 'measure' }, ['BUDGET x'], 'ready api')), { systemMessage: 'BUDGET x', terminalSequence: sequence });
    assert.deepEqual(JSON.parse(stopOutput({ kind: 'notice', state: STATE, message: 'type /clear', title: 'api: type /clear', restart: false }, [], 'ready api')), {
      systemMessage: 'type /clear',
      terminalSequence: sequence,
    });
    assert.deepEqual(JSON.parse(stopOutput({ kind: 'block', state: STATE, reason: 'Write your handover.' }, [], 'ready api')), {
      decision: 'block',
      reason: 'Write your handover.',
    });
  });

  it('blocks with any reason, the notices shown with it', () => {
    assert.deepEqual(blockReply('Retire now.', ['BUDGET x', 'MODEL y']), { verdict: { kind: 'block', reason: 'Retire now.' }, notice: 'BUDGET x\nMODEL y' });
    assert.deepEqual(JSON.parse(blockOutput('Retire now.')), { decision: 'block', reason: 'Retire now.' });
    assert.deepEqual(JSON.parse(blockOutput('Retire now.', ['BUDGET x'])), { decision: 'block', reason: 'Retire now.', systemMessage: 'BUDGET x' });
  });
});
