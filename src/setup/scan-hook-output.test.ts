import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { addHookRun, hookOutputKey, hookRunOf, mayRecordHookRun, type HookOutput } from './scan-hook-output.ts';

interface RunFixture {
  readonly event: string;
  readonly command: string;
  readonly stdout: string;
  readonly content?: string;
  readonly type?: string;
}

function hookLine(run: RunFixture): string {
  const attachment = { type: run.type ?? 'hook_success', hookName: `${run.event}:startup`, hookEvent: run.event, content: run.content ?? '', stdout: run.stdout, stderr: '', exitCode: 0, command: run.command };
  return JSON.stringify({ type: 'attachment', attachment, timestamp: '2030-01-08T10:00:00Z' });
}

function contextReply(text: string): string {
  return `${JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } })}\n`;
}

describe('hookRunOf', () => {
  it("counts a JSON stdout's additional context, a plain output's trimmed text, and nothing for a JSON reply without context", () => {
    assert.deepEqual(hookRunOf(hookLine({ event: 'SessionStart', command: 'node start.js', stdout: contextReply('r'.repeat(120)) })), { event: 'SessionStart', command: 'node start.js', chars: 120 });
    assert.deepEqual(hookRunOf(hookLine({ event: 'UserPromptSubmit', command: 'node inbox.js', stdout: '  two lines\nof news \n', content: '  two lines\nof news \n' })), { event: 'UserPromptSubmit', command: 'node inbox.js', chars: 17 });
    assert.deepEqual(hookRunOf(hookLine({ event: 'SessionStart', command: 'node title.js', stdout: '{"terminalSequence":"title"}\n' })), { event: 'SessionStart', command: 'node title.js', chars: 0 });
  });

  it('falls back to the stdout when a plain run records no content', () => {
    const line = JSON.stringify({ type: 'attachment', attachment: { type: 'hook_success', hookEvent: 'UserPromptSubmit', stdout: 'news\n', command: 'node inbox.js' } });
    assert.deepEqual(hookRunOf(line), { event: 'UserPromptSubmit', command: 'node inbox.js', chars: 4 });
  });

  it("reads no run from another event's hook, a failed run, a line without event or command, or a line that is not JSON", () => {
    assert.equal(hookRunOf(hookLine({ event: 'PostToolUse', command: 'node after.js', stdout: 'printed' })), undefined);
    assert.equal(hookRunOf(hookLine({ event: 'SessionStart', command: 'node start.js', stdout: 'printed', type: 'hook_error' })), undefined);
    assert.equal(hookRunOf(JSON.stringify({ type: 'attachment', attachment: { type: 'hook_success', stdout: 'x' } })), undefined);
    assert.equal(hookRunOf('{"type":"attachment","attachment":"hook_success"}'), undefined);
    assert.equal(hookRunOf('not json "hook_success"'), undefined);
  });
});

describe('mayRecordHookRun', () => {
  it('passes only a line naming a successful hook run', () => {
    assert.equal(mayRecordHookRun(hookLine({ event: 'SessionStart', command: 'node start.js', stdout: '' })), true);
    assert.equal(mayRecordHookRun(hookLine({ event: 'SessionStart', command: 'node start.js', stdout: '', type: 'hook_error' })), false);
  });
});

describe('addHookRun', () => {
  it("sums each hook's runs, the runs that printed something and their characters, keyed by event and command", () => {
    const outputs = new Map<string, HookOutput>();
    addHookRun(outputs, { event: 'SessionStart', command: 'node start.js', chars: 100 });
    addHookRun(outputs, { event: 'SessionStart', command: 'node start.js', chars: 0 });
    addHookRun(outputs, { event: 'SessionStart', command: 'node start.js', chars: 50 });
    addHookRun(outputs, { event: 'UserPromptSubmit', command: 'node start.js', chars: 7 });
    assert.deepEqual(
      outputs,
      new Map([
        [hookOutputKey('SessionStart', 'node start.js'), { runs: 3, printed: 2, chars: 150 }],
        [hookOutputKey('UserPromptSubmit', 'node start.js'), { runs: 1, printed: 1, chars: 7 }],
      ]),
    );
  });
});
