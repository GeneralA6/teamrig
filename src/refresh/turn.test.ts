import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { turnRunning } from './turn.ts';

const tail = (...entries: readonly object[]): string => `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`;

const TOOL_USE = { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {} }] } };
const TOOL_RESULT = { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] } };
const REPLY = { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] } };
const STOP_SUMMARY = { type: 'system', subtype: 'stop_hook_summary' };
const TURN_END = { type: 'system', subtype: 'turn_duration' };

describe('turnRunning', () => {
  it('reads a turn that ended as idle, with later bookkeeping entries after it', () => {
    assert.equal(turnRunning(tail(TOOL_USE, TOOL_RESULT, REPLY, STOP_SUMMARY, TURN_END, { type: 'attachment', attachment: { type: 'hook_success' } })), false);
  });

  it('reads a tool call with no result yet, or a result with no reply yet, as running', () => {
    assert.equal(turnRunning(tail(REPLY, TURN_END, TOOL_USE)), true);
    assert.equal(turnRunning(tail(TOOL_USE, TOOL_RESULT)), true);
  });

  it('reads a turn a notification started as running, as there is no prompt hook to see it', () => {
    const notice = { type: 'user', isMeta: true, message: { role: 'user', content: 'Another Claude session sent a message: ...' } };
    assert.equal(turnRunning(tail(REPLY, TURN_END, { type: 'queue-operation', operation: 'enqueue', content: 'x' }, notice)), true);
  });

  it('reads a slash command that started no turn as idle', () => {
    const command = { type: 'user', message: { role: 'user', content: '<command-name>/reload-plugins</command-name>' } };
    assert.equal(turnRunning(tail(REPLY, TURN_END, command, { type: 'system', subtype: 'local_command' })), false);
  });

  it('reads a turn the user stopped with Escape as idle', () => {
    const stopped = { type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] } };
    assert.equal(turnRunning(tail(TOOL_USE, stopped)), false);
  });

  it('skips other system entries and lines it cannot read, such as the cut first line of a tail', () => {
    assert.equal(turnRunning(`{"type":"user","mess\n${tail(REPLY, { type: 'system', subtype: 'api_error' })}`), true);
    assert.equal(turnRunning(`ge":"cut"}\n${tail(TURN_END)}`), false);
  });

  it('reads a tail with no turn entry at all as idle', () => {
    assert.equal(turnRunning(''), false);
    assert.equal(turnRunning(tail({ type: 'file-history-snapshot' })), false);
  });
});
