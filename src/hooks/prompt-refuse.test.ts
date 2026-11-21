import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { JsonRecord } from '../core/guards.ts';
import { toJsonlLine } from '../core/jsonl.ts';
import { SecretScanner } from '../core/secrets.ts';
import type { ToolCall } from '../ports/host/index.ts';
import { hookEventOf, replyText, shellCallOf } from '../testing/host.ts';
import { ASK_REFUSED_NOTE } from './permission.ts';
import {
  LOGGED_COMMAND_CHARS,
  promptAnswerOf,
  promptAnswerRecord,
  promptAnswerReply,
  promptRefusedReason,
  refusedCall,
  rerunReason,
  type PromptAnswer,
} from './prompt-refuse.ts';

function request(tool: string, fields: JsonRecord = {}): JsonRecord {
  return { hook_event_name: 'PermissionRequest', tool_name: tool, tool_input: {}, ...fields };
}

/** The call the shipped host reads out of the permission prompt of `tool` with `input`. */
function callOf(tool: string, input: JsonRecord): ToolCall {
  const { call } = hookEventOf(request(tool, { tool_input: input }));
  assert.ok(call !== undefined);
  return call;
}

function bashCall(command: string): ToolCall {
  return shellCallOf('Bash', command);
}

/** What the shipped host reads for the hook's answer to the prompt of a `tool` call. */
function answerText(tool: string, answer: PromptAnswer): string {
  return replyText('permission-prompt', promptAnswerReply(tool, answer));
}

const READS = (): boolean => true;
const WRITES = (): boolean => false;

describe('refusedCall', () => {
  it('names the call of a permission prompt when asks are off', () => {
    assert.equal(refusedCall('refuse', hookEventOf(request('Bash')))?.name, 'Bash');
    assert.equal(refusedCall('refuse', hookEventOf(request('mcp__docs__update')))?.name, 'mcp__docs__update');
  });

  it('lets the prompt open with asks on, for a question to the person, another event or no tool', () => {
    assert.equal(refusedCall('ask', hookEventOf(request('Bash'))), undefined);
    for (const tool of ['AskUserQuestion', 'ExitPlanMode']) {
      assert.equal(refusedCall('refuse', hookEventOf(request(tool))), undefined, tool);
    }
    assert.equal(refusedCall('refuse', hookEventOf(request('Bash', { hook_event_name: 'PreToolUse' }))), undefined);
    assert.equal(refusedCall('refuse', hookEventOf({ hook_event_name: 'PermissionRequest' })), undefined);
  });
});

describe('promptAnswerOf', () => {
  it('runs a sanctioned route first, before the read-only check and any rerun form', () => {
    assert.deepEqual(promptAnswerOf(bashCall('teamrig merge --session alpha'), WRITES, 'merge'), { kind: 'route', route: 'merge' });
    assert.deepEqual(promptAnswerOf(bashCall('cd /w && git status'), READS, 'merge'), { kind: 'route', route: 'merge' });
  });

  it('runs a line the read-only check proves reads, before any rerun form', () => {
    assert.deepEqual(promptAnswerOf(bashCall('cat f'), READS, undefined), { kind: 'readonly' });
    assert.deepEqual(promptAnswerOf(bashCall('cd /w && git status'), READS, undefined), { kind: 'readonly' });
  });

  it('refuses a line with a rerun form quoting it, and anything else plainly', () => {
    assert.deepEqual(promptAnswerOf(bashCall('cd /w && git status'), WRITES, undefined), { kind: 'rerun', form: 'git -C /w status' });
    assert.deepEqual(promptAnswerOf(bashCall('rm -rf x'), WRITES, undefined), { kind: 'refused' });
    assert.deepEqual(promptAnswerOf(callOf('Edit', { file_path: '/w/a.ts' }), WRITES, undefined), { kind: 'refused' });
  });

  it('gives a rerun form only to a bash line: no other shell and no other tool that carries a command', () => {
    assert.deepEqual(promptAnswerOf(shellCallOf('PowerShell', 'cd /w && git status'), WRITES, undefined), { kind: 'refused' });
    assert.deepEqual(promptAnswerOf(callOf('mcp__box__run', { command: 'cd /w && git status' }), WRITES, undefined), { kind: 'refused' });
  });

  it('asks the read-only check only when no route answers', () => {
    let asked = 0;
    const counted = (): boolean => {
      asked += 1;
      return true;
    };
    promptAnswerOf(bashCall('cat f'), counted, 'merge');
    assert.equal(asked, 0);
    promptAnswerOf(bashCall('cat f'), counted, undefined);
    assert.equal(asked, 1);
  });
});

describe('promptAnswerReply', () => {
  function denial(reason: string): string {
    return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: reason } } });
  }

  it('allows a sanctioned route and a read-only line, which runs it with no prompt', () => {
    const allow = JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
    assert.equal(answerText('Bash', { kind: 'route', route: 'merge' }), allow);
    assert.equal(answerText('Bash', { kind: 'readonly' }), allow);
  });

  it('refuses a line with a rerun form quoting the form, and anything else with what to do instead', () => {
    assert.equal(answerText('Bash', { kind: 'rerun', form: 'git -C /w status' }), denial(rerunReason('Bash', 'git -C /w status')));
    assert.match(rerunReason('Bash', 'git -C /w status'), /rerun it as: git -C \/w status$/);
    assert.equal(answerText('Edit', { kind: 'refused' }), denial(promptRefusedReason('Edit')));
  });

  it('is a deny on the permission prompt whose message names the call and says what to do instead', () => {
    assert.deepEqual(JSON.parse(answerText('Bash', { kind: 'refused' })), {
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'deny', message: `Claude Code would ask a person to allow this Bash call. ${ASK_REFUSED_NOTE}` },
      },
    });
  });
});

describe('promptAnswerRecord', () => {
  const AT = new Date('2030-01-08T10:00:00Z');
  const SCANNER = new SecretScanner();
  /** Secrets are built from parts, so no secret shape sits in the source. */
  const join = (...parts: string[]): string => parts.join('');

  it('keeps who answered, the tool, the answer and the command', () => {
    const record = promptAnswerRecord({ at: AT, session: 'alpha', claudeSession: 'c1', answer: { kind: 'rerun', form: 'git -C /w status' }, call: bashCall('cd /w && git status') }, SCANNER);
    assert.deepEqual(record, { v: 1, at: '2030-01-08T10:00:00.000Z', session: 'alpha', claudeSession: 'c1', tool: 'Bash', answer: 'rerun', command: 'cd /w && git status' });
  });

  it('writes the line as it does today, naming the tab claudeSession: no code reads the id back, so the rename moves it in one release (T4762)', () => {
    const record = promptAnswerRecord({ at: AT, session: 'alpha', claudeSession: 'c1', answer: { kind: 'route', route: 'merge' }, call: bashCall('teamrig merge') }, SCANNER);
    assert.equal(
      toJsonlLine(record),
      '{"v":1,"at":"2030-01-08T10:00:00.000Z","session":"alpha","claudeSession":"c1","tool":"Bash","answer":"route","route":"merge","command":null}\n',
    );
  });

  it("keeps a route's id and never its command, whose commit message is free text", () => {
    const message = join('ship ', 'ghp', '_', 'a1'.repeat(18), ' private words');
    const record = promptAnswerRecord({ at: AT, session: 'alpha', claudeSession: 'c1', answer: { kind: 'route', route: 'git-commit' }, call: bashCall(`git commit -s -m "${message}"`) }, SCANNER);
    assert.deepEqual(record, { v: 1, at: '2030-01-08T10:00:00.000Z', session: 'alpha', claudeSession: 'c1', tool: 'Bash', answer: 'route', route: 'git-commit', command: null });
    assert.doesNotMatch(JSON.stringify(record), /private words|ghp_/);
  });

  it(`keeps only the first ${LOGGED_COMMAND_CHARS} characters of the command and none of the rest of the input`, () => {
    const long = `echo ${'x'.repeat(LOGGED_COMMAND_CHARS * 2)}`;
    const record = promptAnswerRecord({ at: AT, session: undefined, claudeSession: null, answer: { kind: 'refused' }, call: bashCall(long) }, SCANNER);
    assert.equal(record['command'], long.slice(0, LOGGED_COMMAND_CHARS));
    assert.equal(record['session'], null);
    const write = promptAnswerRecord({ at: AT, session: 'alpha', claudeSession: null, answer: { kind: 'refused' }, call: callOf('Write', { file_path: '/w/a', content: 'secret text' }) }, SCANNER);
    assert.equal(write['tool'], 'Write');
    assert.equal(write['command'], null);
    assert.doesNotMatch(JSON.stringify(write), /secret text/);
  });

  it('keeps the command a tool of no shell kind carries, masked and cut like a shell line', () => {
    const command = join('run --pass', 'word ', 'Qx7mRt', '9wLp4Zn');
    const record = promptAnswerRecord({ at: AT, session: 'alpha', claudeSession: null, answer: { kind: 'refused' }, call: callOf('mcp__box__run', { command, note: 'kept out' }) }, SCANNER);
    assert.equal(record['tool'], 'mcp__box__run');
    assert.equal(record['command'], 'run --password [redacted]');
    assert.doesNotMatch(JSON.stringify(record), /kept out/);
  });

  it("redacts an Authorization header's credential and a URL's user part", () => {
    const command = join('curl -H "Authorization: Bearer ', 'abcdefgh', '12345678" https://', 'token5678', '@api.example.com/x');
    const record = promptAnswerRecord({ at: AT, session: 'alpha', claudeSession: null, answer: { kind: 'refused' }, call: bashCall(command) }, SCANNER);
    assert.equal(record['command'], 'curl -H "[redacted credentials in an Authorization header] https://[redacted]@api.example.com/x');
  });

  it("masks the forms the scanner misses: a secret flag's value, a secret env name's, a login's password (T1986)", () => {
    const value = join('Qx7mRt', '9wLp4Zn');
    const command = join('API_TO', 'KEN=', value, ' tool --pass', 'word ', value, ' && curl -u app:', value, ' https://api.local');
    const record = promptAnswerRecord({ at: AT, session: 'alpha', claudeSession: null, answer: { kind: 'refused' }, call: bashCall(command) }, SCANNER);
    assert.equal(record['command'], 'API_TOKEN=[redacted] tool --password [redacted] && curl -u app:[redacted] https://api.local');
  });

  it('redacts before the cut, so a secret the cut would split leaves none of its start', () => {
    const lead = `echo ${'x'.repeat(LOGGED_COMMAND_CHARS - 15)} `;
    const record = promptAnswerRecord({ at: AT, session: 'alpha', claudeSession: null, answer: { kind: 'refused' }, call: bashCall(join(lead, 'ghp', '_', 'a1'.repeat(18))) }, SCANNER);
    assert.equal(lead.length, LOGGED_COMMAND_CHARS - 9);
    assert.equal(record['command'], join(lead, '[redacted GitHub token]').slice(0, LOGGED_COMMAND_CHARS));
    assert.doesNotMatch(String(record['command']), /ghp_/);
  });
});
