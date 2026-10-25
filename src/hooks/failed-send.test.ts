import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { failedSendLine, failedSendOf } from './failed-send.ts';

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
  const failed = { to: 'captain', reason: "No agent named 'captain' is reachable." };

  it('gives a team session the inbox line to write instead, with wakes off', () => {
    assert.equal(
      failedSendLine(failed, 'lead', 'teamrig', false),
      "teamrig: the message to captain was not sent (No agent named 'captain' is reachable.); leave it as an inbox line, shown at lead's next prompt: `teamrig inbox add --to lead --text \"...\"`.",
    );
  });

  it('offers --wake now for a receiver that must act now, with wakes on', () => {
    assert.equal(
      failedSendLine(failed, 'lead', 'teamrig', true),
      "teamrig: the message to captain was not sent (No agent named 'captain' is reachable.); leave it as an inbox line, shown at lead's next prompt: `teamrig inbox add --to lead --text \"...\"`, or with `--wake now` if lead must act on it now.",
    );
  });

  it('says why no message to a name Claude Code reserves ever arrives', () => {
    assert.equal(
      failedSendLine({ to: 'team-lead', reason: "No agent named 'team-lead' is reachable." }, 'lead', 'teamrig', false),
      "teamrig: the message to team-lead was not sent (No agent named 'team-lead' is reachable.); leave it as an inbox line, shown at lead's next prompt: `teamrig inbox add --to lead --text \"...\"`. team-lead is a name Claude Code keeps for itself, so a message sent to it never reaches a session.",
    );
  });

  it('points a name that is no team session to who', () => {
    assert.match(failedSendLine({ to: 'uds:old-pipe', reason: 'not delivered' }, undefined, 'teamrig', false), /uds:old-pipe is no team session name \(`teamrig who` prints them\); for a team session, leave it as an inbox line: `teamrig inbox add --to <area> --text "\.\.\."`\.$/);
    assert.match(failedSendLine({ to: 'uds:old-pipe', reason: 'not delivered' }, undefined, 'teamrig', true), /`teamrig inbox add --to <area> --text "\.\.\."`, or with `--wake now` if it must act on it now\.$/);
  });
});
