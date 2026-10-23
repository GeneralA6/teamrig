import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isRecord, recordField, type JsonRecord } from '../core/guards.ts';
import { ASK_REFUSED_NOTE } from './permission.ts';
import {
  LOGGED_COMMAND_CHARS,
  promptAnswerOf,
  promptAnswerOutput,
  promptAnswerRecord,
  promptRefusedReason,
  promptRefuseOutput,
  refusedTool,
  rerunReason,
} from './prompt-refuse.ts';

function request(tool: string, fields: JsonRecord = {}): JsonRecord {
  return { hook_event_name: 'PermissionRequest', tool_name: tool, tool_input: {}, ...fields };
}

function bashRequest(command: string): JsonRecord {
  return request('Bash', { tool_input: { command } });
}

const READS = (): boolean => true;
const WRITES = (): boolean => false;

describe('refusedTool', () => {
  it('names the tool of a permission prompt when asks are off', () => {
    assert.equal(refusedTool('refuse', request('Bash')), 'Bash');
    assert.equal(refusedTool('refuse', request('mcp__docs__update')), 'mcp__docs__update');
  });

  it('lets the prompt open with asks on, for a question to the person, another event or no tool', () => {
    assert.equal(refusedTool('ask', request('Bash')), undefined);
    for (const tool of ['AskUserQuestion', 'ExitPlanMode']) {
      assert.equal(refusedTool('refuse', request(tool)), undefined, tool);
    }
    assert.equal(refusedTool('refuse', request('Bash', { hook_event_name: 'PreToolUse' })), undefined);
    assert.equal(refusedTool('refuse', { hook_event_name: 'PermissionRequest' }), undefined);
  });
});

describe('promptAnswerOf', () => {
  it('runs a line the read-only check proves reads, before any rerun form', () => {
    assert.deepEqual(promptAnswerOf('Bash', bashRequest('cat f'), READS), { kind: 'readonly' });
    assert.deepEqual(promptAnswerOf('Bash', bashRequest('cd /w && git status'), READS), { kind: 'readonly' });
  });

  it('refuses a line with a rerun form quoting it, and anything else plainly', () => {
    assert.deepEqual(promptAnswerOf('Bash', bashRequest('cd /w && git status'), WRITES), { kind: 'rerun', form: 'git -C /w status' });
    assert.deepEqual(promptAnswerOf('Bash', bashRequest('rm -rf x'), WRITES), { kind: 'refused' });
    assert.deepEqual(promptAnswerOf('Edit', request('Edit', { tool_input: { file_path: '/w/a.ts' } }), WRITES), { kind: 'refused' });
  });

  it('hands the check the whole call', () => {
    const seen: JsonRecord[] = [];
    const call = bashRequest('cat f');
    promptAnswerOf('Bash', call, (each) => seen.push(each) > 0);
    assert.deepEqual(seen, [call]);
  });
});

describe('promptAnswerOutput', () => {
  function decisionOf(output: string): unknown {
    const parsed: unknown = JSON.parse(output);
    assert.ok(isRecord(parsed));
    const hook = recordField(parsed, 'hookSpecificOutput');
    assert.equal(hook?.['hookEventName'], 'PermissionRequest');
    return hook?.['decision'];
  }

  it('allows a read-only line, which runs it with no prompt', () => {
    assert.deepEqual(decisionOf(promptAnswerOutput('Bash', { kind: 'readonly' })), { behavior: 'allow' });
  });

  it('refuses a line with a rerun form quoting the form, and anything else with what to do instead', () => {
    assert.deepEqual(decisionOf(promptAnswerOutput('Bash', { kind: 'rerun', form: 'git -C /w status' })), { behavior: 'deny', message: rerunReason('Bash', 'git -C /w status') });
    assert.match(rerunReason('Bash', 'git -C /w status'), /rerun it as: git -C \/w status$/);
    assert.deepEqual(decisionOf(promptAnswerOutput('Edit', { kind: 'refused' })), { behavior: 'deny', message: promptRefusedReason('Edit') });
  });
});

describe('promptAnswerRecord', () => {
  const AT = new Date('2030-01-08T10:00:00Z');

  it('keeps who answered, the tool, the answer and the command', () => {
    const record = promptAnswerRecord({ at: AT, session: 'alpha', claudeSession: 'c1', tool: 'Bash', answer: { kind: 'rerun', form: 'git -C /w status' }, payload: bashRequest('cd /w && git status') });
    assert.deepEqual(record, { v: 1, at: '2030-01-08T10:00:00.000Z', session: 'alpha', claudeSession: 'c1', tool: 'Bash', answer: 'rerun', command: 'cd /w && git status' });
  });

  it(`keeps only the first ${LOGGED_COMMAND_CHARS} characters of the command and none of the rest of the input`, () => {
    const long = `echo ${'x'.repeat(LOGGED_COMMAND_CHARS * 2)}`;
    const record = promptAnswerRecord({ at: AT, session: undefined, claudeSession: null, tool: 'Bash', answer: { kind: 'refused' }, payload: bashRequest(long) });
    assert.equal(record['command'], long.slice(0, LOGGED_COMMAND_CHARS));
    assert.equal(record['session'], null);
    const write = promptAnswerRecord({ at: AT, session: 'alpha', claudeSession: null, tool: 'Write', answer: { kind: 'refused' }, payload: request('Write', { tool_input: { file_path: '/w/a', content: 'secret text' } }) });
    assert.equal(write['command'], null);
    assert.doesNotMatch(JSON.stringify(write), /secret text/);
  });
});

describe('promptRefuseOutput', () => {
  it('is a PermissionRequest deny whose message names the call and says what to do instead', () => {
    assert.deepEqual(JSON.parse(promptRefuseOutput(promptRefusedReason('Bash'))), {
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'deny', message: `Claude Code would ask a person to allow this Bash call. ${ASK_REFUSED_NOTE}` },
      },
    });
  });
});
