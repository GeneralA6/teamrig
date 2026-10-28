import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { hookCommandLine, hookCommandsOf } from './settings-hooks.ts';

const SETTINGS = {
  hooks: {
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node guard.js' }] }],
    SessionStart: [
      { hooks: [{ type: 'command', command: 'node', args: ['tracker.cjs', 'start', 7] }, { type: 'prompt', prompt: 'not a command' }] },
      { hooks: [{ type: 'command', command: 'echo hi', args: 'not a list' }] },
      'not a group',
    ],
    UserPromptSubmit: 'not a list',
  },
};

describe('hookCommandsOf', () => {
  it("reads every event's command hooks in file order, the exec form's text args with them, and skips what is not a command hook", () => {
    assert.deepEqual(hookCommandsOf(SETTINGS), [
      { event: 'PreToolUse', command: 'node guard.js', args: [] },
      { event: 'SessionStart', command: 'node', args: ['tracker.cjs', 'start'] },
      { event: 'SessionStart', command: 'echo hi', args: [] },
    ]);
  });

  it('reads only the events asked for, in the order asked', () => {
    assert.deepEqual(
      hookCommandsOf(SETTINGS, ['UserPromptSubmit', 'SessionStart', 'Stop']).map((hook) => hook.command),
      ['node', 'echo hi'],
    );
  });

  it('finds none in settings without a hooks object', () => {
    assert.deepEqual(hookCommandsOf({}), []);
    assert.deepEqual(hookCommandsOf({ hooks: ['not an object'] }), []);
  });
});

describe('hookCommandLine', () => {
  it('joins the command and its args, quoting an arg that holds a space', () => {
    assert.equal(hookCommandLine({ event: 'SessionStart', command: 'node', args: ['C:/Program Files/hook.js', 'start'] }), 'node "C:/Program Files/hook.js" start');
    assert.equal(hookCommandLine({ event: 'SessionStart', command: 'node hook.js', args: [] }), 'node hook.js');
  });
});
