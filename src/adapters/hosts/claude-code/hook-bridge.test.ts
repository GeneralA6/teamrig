import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { HOOK_EVENTS, type HookEvent } from '../../../plugin-api/index.ts';
import { hookBridge } from './hook-bridge.ts';
import { toolCallShape } from './tool-call.ts';

const SESSION = '0a1b2c3d-4e5f-4a6b-8c7d-0123456789ab';
const TAB_TITLE = '\u001b]0;T12 build\u0007';

const bridge = hookBridge(toolCallShape('linux'));

/** The event every field of which is unset: what a payload of `{}` parses to. */
const BARE: HookEvent = {
  name: 'other',
  hostName: undefined,
  session: undefined,
  cwd: undefined,
  transcript: undefined,
  title: undefined,
  helper: undefined,
  call: undefined,
  prompt: undefined,
  lastReply: undefined,
  stopActive: false,
  source: undefined,
  trigger: undefined,
  model: undefined,
  effort: undefined,
  message: undefined,
  error: undefined,
};

function parse(payload: object): HookEvent | undefined {
  return bridge.parse(JSON.stringify(payload));
}

/** The answer a hook may replace, of a call of this tool that ended with this answer. */
function replaceableOf(tool_name: string, tool_response: unknown): unknown {
  return parse({ hook_event_name: 'PostToolUse', tool_name, tool_response })?.call?.replaceable;
}

describe("Claude Code's hook input", () => {
  it('is no event when it is not a JSON object', () => {
    assert.equal(bridge.parse(''), undefined);
    assert.equal(bridge.parse('{"session_id":'), undefined);
    assert.equal(bridge.parse('[1, 2]'), undefined);
    assert.equal(bridge.parse('"text"'), undefined);
    assert.equal(bridge.parse('null'), undefined);
  });

  it('has every field unset for an empty object', () => {
    assert.deepEqual(parse({}), BARE);
  });

  it('names each of its events as the core does', () => {
    const names = ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'PostToolUseFailure', 'Stop', 'StopFailure', 'SubagentStart', 'SubagentStop', 'PreCompact', 'PostCompact', 'Elicitation', 'ElicitationResult'];
    assert.deepEqual(
      names.map((hook_event_name) => parse({ hook_event_name })?.name),
      HOOK_EVENTS,
    );
  });

  it('keeps an event the core has no name for as other, under its own name', () => {
    assert.deepEqual(parse({ hook_event_name: 'Notification', message: 'idle' }), { ...BARE, hostName: 'Notification', message: 'idle' });
  });

  it('reads a tool call before it runs', () => {
    const tool_input = { command: 'git push', description: 'push' };
    const payload = { session_id: SESSION, transcript_path: '/logs/t.jsonl', cwd: '/repo', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input, tool_use_id: 'toolu_01' };
    assert.deepEqual(parse(payload), {
      ...BARE,
      name: 'tool-start',
      hostName: 'PreToolUse',
      session: SESSION,
      cwd: '/repo',
      transcript: '/logs/t.jsonl',
      call: { kind: 'shell', name: 'Bash', input: tool_input, dialect: 'bash', command: 'git push', readings: ['git push'], id: 'toolu_01' },
    });
  });

  it('reads a tool call after it ran, with what the tool answered', () => {
    const tool_response = { stdout: 'ok', stderr: '' };
    const event = parse({ hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: '/repo/a.ts' }, tool_response });
    assert.equal(event?.name, 'tool-end');
    assert.deepEqual(event?.call, { kind: 'read', name: 'Read', input: { file_path: '/repo/a.ts' }, path: '/repo/a.ts', response: tool_response });
  });

  it('names the answer a hook may replace: a Bash, PowerShell or Grep result object, and a Read of a text file', () => {
    const result = { stdout: 'ok', stderr: '', interrupted: false };
    for (const tool of ['Bash', 'PowerShell', 'Grep']) {
      assert.deepEqual(replaceableOf(tool, result), result, tool);
    }
    const text = { type: 'text', file: { filePath: 'a.txt', content: 'ok' } };
    assert.deepEqual(replaceableOf('Read', text), text);
  });

  it('names none for a tool not probed, a Read of an image, a result that is no object and a call with no result', () => {
    assert.equal(replaceableOf('WebFetch', { result: 'ok' }), undefined);
    assert.equal(replaceableOf('Glob', { filenames: ['a.ts'] }), undefined);
    assert.equal(replaceableOf('Read', { type: 'image', file: { base64: 'ok' } }), undefined);
    assert.equal(replaceableOf('Bash', JSON.stringify({ stdout: 'ok' })), undefined);
    assert.equal(replaceableOf('Bash', undefined), undefined);
    const before = parse({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } });
    assert.equal(before?.call !== undefined && Object.hasOwn(before.call, 'replaceable'), false);
  });

  it('reads a tool call with no input as one with an empty input', () => {
    assert.deepEqual(parse({ tool_name: 'Bash' })?.call, { kind: 'shell', name: 'Bash', input: {}, dialect: 'bash', command: undefined, readings: [] });
    assert.deepEqual(parse({ tool_name: 'Bash', tool_input: 'git status' })?.call, { kind: 'shell', name: 'Bash', input: {}, dialect: 'bash', command: undefined, readings: [] });
  });

  it("gives a Bash command its Windows reading from the adapter's platform", () => {
    const windows = hookBridge(toolCallShape('win32'));
    const event = windows.parse(JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls a\\\\\\; rm -f x' } }));
    assert.deepEqual(event?.call?.kind === 'shell' && event.call.readings, ['ls a\\\\\\; rm -f x', 'ls a\\\\; rm -f x']);
  });

  it('takes no session from an id that is not shaped as one', () => {
    assert.equal(parse({ session_id: SESSION })?.session, SESSION);
    assert.equal(parse({ session_id: '../../etc' })?.session, undefined);
    assert.equal(parse({ session_id: SESSION.toUpperCase() })?.session, undefined);
    assert.equal(parse({ session_id: 12 })?.session, undefined);
  });

  it('reads the helper a call came from, and a session that runs as an agent', () => {
    assert.deepEqual(parse({ hook_event_name: 'SubagentStop', agent_id: 'a1', agent_type: 'Explore', agent_transcript_path: '/logs/a1.jsonl' })?.helper, { id: 'a1', type: 'Explore', transcript: '/logs/a1.jsonl' });
    assert.deepEqual(parse({ agent_type: 'reviewer' })?.helper, { id: undefined, type: 'reviewer', transcript: undefined });
    assert.equal(parse({ agent_id: 7 })?.helper, undefined);
  });

  it('reads the title the human gave the session, and no blank one', () => {
    assert.equal(parse({ session_title: ' ranger ' })?.title, 'ranger');
    assert.equal(parse({ session_title: '  ' })?.title, undefined);
    assert.equal(parse({ session_title: 7 })?.title, undefined);
  });

  it('reads the effort level, and none from an effort that is no object', () => {
    assert.equal(parse({ hook_event_name: 'Stop', effort: { level: 'high' } })?.effort, 'high');
    assert.equal(parse({ effort: 'high' })?.effort, undefined);
    assert.equal(parse({ effort: { level: 3 } })?.effort, undefined);
  });

  it('reads a prompt, a start and a compaction', () => {
    assert.deepEqual(parse({ hook_event_name: 'UserPromptSubmit', prompt: 'go on' }), { ...BARE, name: 'prompt', hostName: 'UserPromptSubmit', prompt: 'go on' });
    assert.deepEqual(parse({ hook_event_name: 'SessionStart', source: 'clear', model: 'some-model' }), { ...BARE, name: 'session-start', hostName: 'SessionStart', source: 'clear', model: 'some-model' });
    assert.deepEqual(parse({ hook_event_name: 'PreCompact', trigger: 'auto' }), { ...BARE, name: 'compact-start', hostName: 'PreCompact', trigger: 'auto' });
  });

  it('reads a stop, one that follows a blocked stop, and one that failed', () => {
    assert.deepEqual(parse({ hook_event_name: 'Stop', last_assistant_message: 'done', stop_hook_active: true }), { ...BARE, name: 'stop', hostName: 'Stop', lastReply: 'done', stopActive: true });
    assert.equal(parse({ hook_event_name: 'Stop', stop_hook_active: 'true' })?.stopActive, false);
    assert.deepEqual(parse({ hook_event_name: 'StopFailure', error: 'overloaded' }), { ...BARE, name: 'stop-failed', hostName: 'StopFailure', error: 'overloaded' });
  });

  it('names a form by its text, else by the server that asks', () => {
    assert.equal(parse({ hook_event_name: 'Elicitation', message: 'Pick one', mcp_server_name: 'forms' })?.message, 'Pick one');
    assert.equal(parse({ hook_event_name: 'Elicitation', mcp_server_name: 'forms' })?.message, 'forms');
    assert.equal(parse({ hook_event_name: 'Stop', mcp_server_name: 'forms' })?.message, undefined);
  });
});

describe("a reply to Claude Code's hook", () => {
  it('is nothing when it has no part, or none the event takes', () => {
    assert.equal(bridge.reply('stop', {}), '');
    assert.equal(bridge.reply('stop', { context: 'for the model' }), '');
    assert.equal(bridge.reply('session-end', { verdict: { kind: 'deny', reason: 'no' }, sessionTitle: 'T12', toolOutput: { stdout: '' } }), '');
    assert.equal(bridge.reply('tool-start', { verdict: undefined, context: undefined, notice: undefined }), '');
  });

  it('refuses or allows a tool call before it runs', () => {
    assert.equal(bridge.reply('tool-start', { verdict: { kind: 'deny', reason: 'no push to main' } }), '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"no push to main"}}');
    assert.equal(bridge.reply('tool-start', { verdict: { kind: 'block', reason: 'no push to main' } }), '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"no push to main"}}');
    assert.equal(bridge.reply('tool-start', { verdict: { kind: 'allow', reason: 'read-only' } }), '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","permissionDecisionReason":"read-only"}}');
    assert.equal(bridge.reply('tool-start', { verdict: { kind: 'allow' } }), '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}');
  });

  it('gives the model context before a tool call, and the human a notice alone', () => {
    assert.equal(bridge.reply('tool-start', { context: 'the route is api' }), '{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"the route is api"}}');
    assert.equal(bridge.reply('tool-start', { notice: 'teamrig is not installed' }), '{"systemMessage":"teamrig is not installed"}');
  });

  it('answers a permission prompt', () => {
    assert.equal(bridge.reply('permission-prompt', { verdict: { kind: 'deny', reason: 'not this role' } }), '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"not this role"}}}');
    assert.equal(bridge.reply('permission-prompt', { verdict: { kind: 'allow', reason: 'unused' } }), '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}');
  });

  it("writes a prompt's context alone as plain text, which Claude Code adds as it is", () => {
    assert.equal(bridge.reply('prompt', { context: 'line one\nline two' }), 'line one\nline two');
    assert.equal(bridge.reply('prompt', { context: '' }), '');
  });

  it('sets the session title on a prompt, with or without context', () => {
    assert.equal(bridge.reply('prompt', { context: 'line one\nline two', sessionTitle: 'T12 build' }), '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"line one\\nline two","sessionTitle":"T12 build"}}');
    assert.equal(bridge.reply('prompt', { sessionTitle: 'T12 build' }), '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","sessionTitle":"T12 build"}}');
  });

  it('blocks a prompt, and hides it when asked', () => {
    assert.equal(bridge.reply('prompt', { verdict: { kind: 'block', reason: 'it holds a secret', hidePrompt: true } }), '{"decision":"block","reason":"it holds a secret","hookSpecificOutput":{"hookEventName":"UserPromptSubmit","suppressOriginalPrompt":true}}');
    assert.equal(bridge.reply('prompt', { verdict: { kind: 'block', reason: 'not now' } }), '{"decision":"block","reason":"not now"}');
  });

  it("gives context after a tool call, replaces the tool's answer and sets the tab's title", () => {
    assert.equal(bridge.reply('tool-end', { context: 'inbox: 1 new' }), '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"inbox: 1 new"}}');
    assert.equal(bridge.reply('tool-end', { toolOutput: { stdout: '[redacted]' }, context: 'a secret was hidden' }), '{"hookSpecificOutput":{"hookEventName":"PostToolUse","updatedToolOutput":{"stdout":"[redacted]"},"additionalContext":"a secret was hidden"}}');
    assert.equal(bridge.reply('tool-end', { tabTitle: 'T12 build', context: 'inbox: 1 new' }), JSON.stringify({ terminalSequence: TAB_TITLE, hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'inbox: 1 new' } }));
    assert.equal(bridge.reply('tool-failed', { context: 'the send failed' }), '{"hookSpecificOutput":{"hookEventName":"PostToolUseFailure","additionalContext":"the send failed"}}');
    assert.equal(bridge.reply('tool-failed', { toolOutput: { stdout: '' } }), '');
  });

  it('gives a starting session and a starting helper their context', () => {
    assert.equal(bridge.reply('session-start', { notice: 'teamrig 1.2.3', context: 'the rules' }), '{"systemMessage":"teamrig 1.2.3","hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"the rules"}}');
    assert.equal(bridge.reply('session-start', { context: 'the rules' }), '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"the rules"}}');
    assert.equal(bridge.reply('helper-start', { context: 'the rules' }), '{"hookSpecificOutput":{"hookEventName":"SubagentStart","additionalContext":"the rules"}}');
  });

  it('blocks a stop, a helper stop and a compaction at the top level', () => {
    for (const on of ['stop', 'helper-stop', 'compact-start'] as const) {
      assert.equal(bridge.reply(on, { verdict: { kind: 'block', reason: 'read your inbox' }, notice: 'held' }), '{"decision":"block","reason":"read your inbox","systemMessage":"held"}', on);
      assert.equal(bridge.reply(on, { verdict: { kind: 'block', reason: 'read your inbox' } }), '{"decision":"block","reason":"read your inbox"}', on);
      assert.equal(bridge.reply(on, { verdict: { kind: 'allow' } }), '', on);
    }
  });

  it("tells the human at a stop, and sets the tab's title", () => {
    assert.equal(bridge.reply('stop', { notice: 'refresh due', tabTitle: 'T12 build' }), JSON.stringify({ systemMessage: 'refresh due', terminalSequence: TAB_TITLE }));
    assert.equal(bridge.reply('stop', { tabTitle: 'T12 build' }), JSON.stringify({ terminalSequence: TAB_TITLE }));
    assert.equal(bridge.reply('stop', { notice: 'refresh due' }), '{"systemMessage":"refresh due"}');
  });

  it('lets the moment go on when a hook fails', () => {
    assert.equal(bridge.failureRule, 'passes');
  });
});
