import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isPushedPrompt, isStopFeedback } from './turn-origin.ts';

describe('isPushedPrompt', () => {
  it('takes the wakes and the reopen', () => {
    assert.equal(isPushedPrompt('The day started at 02:00 IST: read your list'), true);
    assert.equal(isPushedPrompt('The lead started a burst'), true);
    assert.equal(isPushedPrompt('Urgent lines were posted to your inbox'), true);
    assert.equal(isPushedPrompt('This tab closed while idle and reopened'), true);
    assert.equal(isPushedPrompt('T1 was handed to you while this tab was idle'), true);
  });

  it('takes a refresh, a compaction, a Stop hook and a plugin message', () => {
    assert.equal(isPushedPrompt('You were started fresh after your context refresh'), true);
    assert.equal(isPushedPrompt('read your handover now'), true);
    assert.equal(isPushedPrompt('This session is being continued from a previous conversation'), true);
    assert.equal(isPushedPrompt('  Stop hook feedback:\nkeep going'), true);
    assert.equal(isPushedPrompt('a Stop hook said to go on'), true);
    assert.equal(isPushedPrompt('A plugin sent a message'), true);
  });

  it('takes a Stop hook or a refresh that comes as a task notification, in either shape', () => {
    assert.equal(isPushedPrompt('<task-notification><summary>Stop hook feedback</summary></task-notification>'), true);
    assert.equal(isPushedPrompt('<task-notification>You were started fresh</task-notification>'), true);
  });

  it('leaves any other task notification, whatever it quotes', () => {
    assert.equal(isPushedPrompt('<task-notification><summary>Build done</summary></task-notification>'), false);
    assert.equal(isPushedPrompt('<task-notification><summary>Build done</summary>the handover file</task-notification>'), false);
  });

  it('leaves what the owner typed, a slash command and a local command', () => {
    assert.equal(isPushedPrompt('please fix the budget table'), false);
    assert.equal(isPushedPrompt('<command-name>/clear</command-name> handover'), false);
    assert.equal(isPushedPrompt('<local-command-stdout>ok</local-command-stdout>'), false);
    assert.equal(isPushedPrompt(''), false);
  });

  it('reads only the head of a long message', () => {
    assert.equal(isPushedPrompt(`${'x'.repeat(1_200)} The day started at`), false);
    assert.equal(isPushedPrompt(`${'x'.repeat(1_100)} The day started at`), true);
  });
});

describe('isStopFeedback', () => {
  it('takes only a text that starts with it', () => {
    assert.equal(isStopFeedback('Stop hook feedback: go on'), true);
    assert.equal(isStopFeedback('the Stop hook feedback'), false);
  });
});
