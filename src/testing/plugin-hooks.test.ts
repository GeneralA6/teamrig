import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { hookMatches, pluginHooks, wiredHooks, type WiredHook } from './plugin-hooks.ts';

function command(...words: readonly string[]): Readonly<Record<string, unknown>> {
  return { type: 'command', command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/dist/cli/main.js', ...words], timeout: 15 };
}

function hook(event: string, matcher?: string): WiredHook {
  return { event, matcher, argv: ['hook', 'x'] };
}

describe('wiredHooks', () => {
  it('gives every hook in the manifest order with its event, its group matcher and the words after the script', () => {
    const manifest = {
      description: 'd',
      hooks: {
        SessionStart: [{ hooks: [command('hook', 'session-start'), command('hook', 'tab-status')] }, { matcher: 'clear', hooks: [command('hook', 'refresh-wake')] }],
        PreToolUse: [{ matcher: 'Bash|PowerShell', hooks: [command('hook', 'push-guard')] }],
      },
    };
    assert.deepEqual(wiredHooks(manifest), [
      { event: 'SessionStart', matcher: undefined, argv: ['hook', 'session-start'] },
      { event: 'SessionStart', matcher: undefined, argv: ['hook', 'tab-status'] },
      { event: 'SessionStart', matcher: 'clear', argv: ['hook', 'refresh-wake'] },
      { event: 'PreToolUse', matcher: 'Bash|PowerShell', argv: ['hook', 'push-guard'] },
    ]);
  });

  it('refuses a manifest of another shape, naming the event', () => {
    assert.throws(() => wiredHooks([]), /hooks\.json has no "hooks" object/);
    assert.throws(() => wiredHooks({ hooks: [] }), /hooks\.json has no "hooks" object/);
    assert.throws(() => wiredHooks({ hooks: { Stop: {} } }), /hooks\.json: Stop is not a list/);
    assert.throws(() => wiredHooks({ hooks: { Stop: ['x'] } }), /hooks\.json: a Stop entry is not an object/);
    assert.throws(() => wiredHooks({ hooks: { Stop: [{ matcher: 1, hooks: [] }] } }), /hooks\.json: a Stop matcher is not a text/);
    assert.throws(() => wiredHooks({ hooks: { Stop: [{}] } }), /hooks\.json: the "hooks" of a Stop entry is not a list/);
  });

  it('refuses a hook a replay could not run as the teamrig CLI', () => {
    const refused = /hooks\.json: a Stop hook is not a node command with a script and its words/;
    const wired = (one: unknown): unknown => ({ hooks: { Stop: [{ hooks: [one] }] } });
    assert.throws(() => wiredHooks(wired('x')), refused);
    assert.throws(() => wiredHooks(wired({ ...command('hook', 'stop'), type: 'prompt' })), refused);
    assert.throws(() => wiredHooks(wired({ ...command('hook', 'stop'), command: 'bash' })), refused);
    assert.throws(() => wiredHooks(wired({ type: 'command', command: 'node' })), refused);
    assert.throws(() => wiredHooks(wired({ type: 'command', command: 'node', args: ['script.js'] })), refused);
    assert.throws(() => wiredHooks(wired({ type: 'command', command: 'node', args: ['script.js', 1] })), refused);
  });
});

describe('hookMatches', () => {
  it('runs a hook with no matcher, an empty one or * for every input of its event, and for no other event', () => {
    for (const matcher of [undefined, '', '*']) {
      assert.equal(hookMatches(hook('Stop', matcher), { hook_event_name: 'Stop' }), true);
      assert.equal(hookMatches(hook('PreToolUse', matcher), { hook_event_name: 'PreToolUse', tool_name: 'Bash' }), true);
      assert.equal(hookMatches(hook('Stop', matcher), { hook_event_name: 'SessionEnd' }), false);
      assert.equal(hookMatches(hook('Stop', matcher), {}), false);
    }
  });

  it('runs a tool hook for the tools its matcher lists by their exact names', () => {
    for (const event of ['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest']) {
      const listed = hook(event, 'Bash|PowerShell');
      assert.equal(hookMatches(listed, { hook_event_name: event, tool_name: 'Bash' }), true, event);
      assert.equal(hookMatches(listed, { hook_event_name: event, tool_name: 'PowerShell' }), true, event);
      assert.equal(hookMatches(listed, { hook_event_name: event, tool_name: 'BashOutput' }), false, event);
      assert.equal(hookMatches(listed, { hook_event_name: event, tool_name: 'bash' }), false, event);
      assert.equal(hookMatches(listed, { hook_event_name: event }), false, event);
      assert.equal(hookMatches(listed, { hook_event_name: 'Stop', tool_name: 'Bash' }), false, event);
    }
    assert.equal(hookMatches(hook('PreToolUse', 'mcp__docs__search'), { hook_event_name: 'PreToolUse', tool_name: 'mcp__docs__search' }), true);
  });

  it('runs a SessionStart hook by the source and a compaction hook by the trigger', () => {
    assert.equal(hookMatches(hook('SessionStart', 'clear'), { hook_event_name: 'SessionStart', source: 'clear' }), true);
    assert.equal(hookMatches(hook('SessionStart', 'clear'), { hook_event_name: 'SessionStart', source: 'startup' }), false);
    for (const event of ['PreCompact', 'PostCompact']) {
      assert.equal(hookMatches(hook(event, 'manual'), { hook_event_name: event, trigger: 'manual' }), true, event);
      assert.equal(hookMatches(hook(event, 'manual'), { hook_event_name: event, trigger: 'auto' }), false, event);
    }
  });

  it('refuses a matcher that is no list of exact names, whatever the input', () => {
    for (const matcher of ['Bash.*', '^Bash$', 'mcp__.*__write', 'Bash|', 'Bash(git *)', 'Read, Grep']) {
      assert.throws(() => hookMatches(hook('PreToolUse', matcher), { hook_event_name: 'Stop' }), /the PreToolUse matcher ".*" is no list of exact names/, matcher);
    }
  });

  it('refuses a matcher at an event that takes none', () => {
    assert.throws(() => hookMatches(hook('Stop', 'Bash'), { hook_event_name: 'Stop' }), /hooks\.json: Stop takes no matcher, and has "Bash"/);
    assert.throws(() => hookMatches(hook('UserPromptSubmit', 'x'), { hook_event_name: 'SessionEnd' }), /UserPromptSubmit takes no matcher/);
  });
});

describe('pluginHooks', () => {
  const hooks = pluginHooks();

  it('reads the manifest the plugin ships, each hook a teamrig hook command', () => {
    assert.ok(hooks.length > 0);
    for (const { event, argv } of hooks) {
      assert.equal(argv.length, 2, event);
      assert.equal(argv[0], 'hook', event);
      assert.match(argv[1] ?? '', /^[a-z][a-z-]+$/, event);
    }
  });

  it('holds only matchers it can decide', () => {
    for (const wired of hooks) {
      assert.equal(hookMatches(wired, { hook_event_name: 'no such event' }), false, `${wired.event} ${wired.matcher ?? ''}`);
    }
  });
});
