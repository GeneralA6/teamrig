import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { deliveredSendOf } from './route-reminder.ts';

function result(toolResponse: unknown, to = 'app-bravo', toolName = 'SendMessage'): unknown {
  return { hook_event_name: 'PostToolUse', tool_name: toolName, tool_input: { to, message: 'take T1' }, tool_response: toolResponse };
}

const SENT = { success: true, message: "Message sent to app-bravo's inbox" };

describe('deliveredSendOf', () => {
  it('reads the receiver and the text of a delivered send', () => {
    assert.deepEqual(deliveredSendOf(result(SENT)), { to: 'app-bravo', text: 'take T1' });
  });

  it('reads the result when Claude Code hands it over as JSON text, and drops the [ref] from the receiver', () => {
    assert.deepEqual(deliveredSendOf(result(JSON.stringify(SENT), 'app-bravo [3fa9c1]')), { to: 'app-bravo', text: 'take T1' });
  });

  it('ignores a send that failed, a result it cannot read and any other tool', () => {
    assert.equal(deliveredSendOf(result({ success: false, message: 'No agent named app-bravo is reachable.' })), undefined);
    assert.equal(deliveredSendOf(result({ message: 'sent' })), undefined);
    assert.equal(deliveredSendOf(result('not json')), undefined);
    assert.equal(deliveredSendOf(result(SENT, 'app-bravo', 'Bash')), undefined);
  });
});
