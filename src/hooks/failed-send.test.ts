import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { failedSendLine, failedSendOf, failedSendOutput } from './failed-send.ts';

function result(toolResponse: unknown, to = 'team-lead', toolName = 'SendMessage'): unknown {
  return { hook_event_name: 'PostToolUse', tool_name: toolName, tool_input: { to, message: 'the ask' }, tool_response: toolResponse };
}

const NOT_REACHABLE = { success: false, message: "No agent named 'team-lead' is reachable.\nUse ListAgents to see everyone you can message." };

describe('failedSendOf', () => {
  it('reads the receiver and the first line of why from a send that was not delivered', () => {
    assert.deepEqual(failedSendOf(result(NOT_REACHABLE)), { to: 'team-lead', reason: "No agent named 'team-lead' is reachable." });
  });

  it('reads the result when Claude Code hands it over as JSON text', () => {
    assert.deepEqual(failedSendOf(result(JSON.stringify(NOT_REACHABLE))), { to: 'team-lead', reason: "No agent named 'team-lead' is reachable." });
  });

  it('drops the [ref] from the receiver and says "not delivered" when no reason is given', () => {
    assert.deepEqual(failedSendOf(result({ success: false }, 'alpha [3fa9c1]')), { to: 'alpha', reason: 'not delivered' });
  });

  it('ignores a delivered message, a result it cannot read and any other tool', () => {
    assert.equal(failedSendOf(result({ success: true, message: 'sent' })), undefined);
    assert.equal(failedSendOf(result('not json')), undefined);
    assert.equal(failedSendOf(result(undefined)), undefined);
    assert.equal(failedSendOf(result(NOT_REACHABLE, 'team-lead', 'Bash')), undefined);
  });
});

describe('failedSendLine', () => {
  const failed = { to: 'team-lead', reason: "No agent named 'team-lead' is reachable." };

  it('gives a team session the inbox line to write instead', () => {
    assert.equal(
      failedSendLine(failed, 'lead', 'teamrig'),
      "teamrig: the message to team-lead was not sent (No agent named 'team-lead' is reachable.); leave it as an inbox line, shown at lead's next prompt: `teamrig inbox add --to lead --text \"...\"`.",
    );
  });

  it('points a name that is no team session to who', () => {
    assert.match(failedSendLine({ to: 'uds:old-pipe', reason: 'not delivered' }, undefined, 'teamrig'), /uds:old-pipe is no team session name \(`teamrig who` prints them\); for a team session, leave it as an inbox line: `teamrig inbox add --to <area>/);
  });

  it('hands the line to the model as PostToolUse context', () => {
    assert.deepEqual(JSON.parse(failedSendOutput('the line')), { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'the line' } });
  });
});
