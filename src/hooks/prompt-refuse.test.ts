import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isRecord, recordField, type JsonRecord } from '../core/guards.ts';
import { SecretScanner } from '../core/secrets.ts';
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
  it('runs a sanctioned route first, before the read-only check and any rerun form', () => {
    assert.deepEqual(promptAnswerOf('Bash', bashRequest('teamrig merge --session alpha'), WRITES, 'merge'), { kind: 'route', route: 'merge' });
    assert.deepEqual(promptAnswerOf('Bash', bashRequest('cd /w && git status'), READS, 'merge'), { kind: 'route', route: 'merge' });
  });

  it('runs a line the read-only check proves reads, before any rerun form', () => {
    assert.deepEqual(promptAnswerOf('Bash', bashRequest('cat f'), READS, undefined), { kind: 'readonly' });
    assert.deepEqual(promptAnswerOf('Bash', bashRequest('cd /w && git status'), READS, undefined), { kind: 'readonly' });
  });

  it('refuses a line with a rerun form quoting it, and anything else plainly', () => {
    assert.deepEqual(promptAnswerOf('Bash', bashRequest('cd /w && git status'), WRITES, undefined), { kind: 'rerun', form: 'git -C /w status' });
    assert.deepEqual(promptAnswerOf('Bash', bashRequest('rm -rf x'), WRITES, undefined), { kind: 'refused' });
    assert.deepEqual(promptAnswerOf('Edit', request('Edit', { tool_input: { file_path: '/w/a.ts' } }), WRITES, undefined), { kind: 'refused' });
  });

  it('hands the check the whole call', () => {
    const seen: JsonRecord[] = [];
    const call = bashRequest('cat f');
    promptAnswerOf('Bash', call, (each) => seen.push(each) > 0, undefined);
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

  it('allows a sanctioned route and a read-only line, which runs it with no prompt', () => {
    assert.deepEqual(decisionOf(promptAnswerOutput('Bash', { kind: 'route', route: 'merge' })), { behavior: 'allow' });
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
  const SCANNER = new SecretScanner();
  /** Secrets are built from parts, so no secret shape sits in the source. */
  const join = (...parts: string[]): string => parts.join('');

  it('keeps who answered, the tool, the answer and the command', () => {
    const record = promptAnswerRecord({ at: AT, session: 'alpha', claudeSession: 'c1', tool: 'Bash', answer: { kind: 'rerun', form: 'git -C /w status' }, payload: bashRequest('cd /w && git status') }, SCANNER);
    assert.deepEqual(record, { v: 1, at: '2030-01-08T10:00:00.000Z', session: 'alpha', claudeSession: 'c1', tool: 'Bash', answer: 'rerun', command: 'cd /w && git status' });
  });

  it("keeps a route's id and never its command, whose commit message is free text", () => {
    const message = join('ship ', 'ghp', '_', 'a1'.repeat(18), ' private words');
    const record = promptAnswerRecord({ at: AT, session: 'alpha', claudeSession: 'c1', tool: 'Bash', answer: { kind: 'route', route: 'git-commit' }, payload: bashRequest(`git commit -s -m "${message}"`) }, SCANNER);
    assert.deepEqual(record, { v: 1, at: '2030-01-08T10:00:00.000Z', session: 'alpha', claudeSession: 'c1', tool: 'Bash', answer: 'route', route: 'git-commit', command: null });
    assert.doesNotMatch(JSON.stringify(record), /private words|ghp_/);
  });

  it(`keeps only the first ${LOGGED_COMMAND_CHARS} characters of the command and none of the rest of the input`, () => {
    const long = `echo ${'x'.repeat(LOGGED_COMMAND_CHARS * 2)}`;
    const record = promptAnswerRecord({ at: AT, session: undefined, claudeSession: null, tool: 'Bash', answer: { kind: 'refused' }, payload: bashRequest(long) }, SCANNER);
    assert.equal(record['command'], long.slice(0, LOGGED_COMMAND_CHARS));
    assert.equal(record['session'], null);
    const write = promptAnswerRecord({ at: AT, session: 'alpha', claudeSession: null, tool: 'Write', answer: { kind: 'refused' }, payload: request('Write', { tool_input: { file_path: '/w/a', content: 'secret text' } }) }, SCANNER);
    assert.equal(write['command'], null);
    assert.doesNotMatch(JSON.stringify(write), /secret text/);
  });

  it("redacts an Authorization header's credential and a URL's user part", () => {
    const command = join('curl -H "Authorization: Bearer ', 'abcdefgh', '12345678" https://', 'token5678', '@api.example.com/x');
    const record = promptAnswerRecord({ at: AT, session: 'alpha', claudeSession: null, tool: 'Bash', answer: { kind: 'refused' }, payload: bashRequest(command) }, SCANNER);
    assert.equal(record['command'], 'curl -H "[redacted credentials in an Authorization header] https://[redacted]@api.example.com/x');
  });

  it('redacts before the cut, so a secret the cut would split leaves none of its start', () => {
    const lead = `echo ${'x'.repeat(LOGGED_COMMAND_CHARS - 15)} `;
    const record = promptAnswerRecord({ at: AT, session: 'alpha', claudeSession: null, tool: 'Bash', answer: { kind: 'refused' }, payload: bashRequest(join(lead, 'ghp', '_', 'a1'.repeat(18))) }, SCANNER);
    assert.equal(lead.length, LOGGED_COMMAND_CHARS - 9);
    assert.equal(record['command'], join(lead, '[redacted GitHub token]').slice(0, LOGGED_COMMAND_CHARS));
    assert.doesNotMatch(String(record['command']), /ghp_/);
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
