import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { JsonRecord } from '../core/guards.ts';
import { MemoryFiles, normalisePath } from '../testing/memory-files.ts';
import { askOf, formatTabNeed, NEED_TEXT_MAX_CHARS, parseTabNeed, TabNeedStore, tabNeedOf, taskOf, type TabNeed } from './need.ts';

const PATHS = { tabs: join('/', 'team', 'state', 'tabs') };
const SINCE = '2030-01-08T10:00:00.000Z';
const WAITING: TabNeed = { session: 'alpha', state: 'waiting', kind: 'permission', text: 'Bash: npm test', task: null, pid: 6900, since: SINCE };

function event(name: string, fields: JsonRecord = {}): JsonRecord {
  return { hook_event_name: name, ...fields };
}

describe('askOf', () => {
  it('names a permission prompt by its tool and the input field that says most', () => {
    assert.deepEqual(askOf(event('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'git push origin t1', description: 'Push' } })), { kind: 'permission', text: 'Bash: git push origin t1' });
    assert.deepEqual(askOf(event('PermissionRequest', { tool_name: 'Edit', tool_input: { file_path: 'src/a.ts' } })), { kind: 'permission', text: 'Edit: src/a.ts' });
    assert.deepEqual(askOf(event('PermissionRequest', { tool_name: 'mcp__x__y', tool_input: { count: 3 } })), { kind: 'permission', text: 'mcp__x__y' });
  });

  it('names a question by its first question, a plan by its plain words', () => {
    const questions = [{ question: 'Ship T12 now?', options: [] }, { question: 'Second?' }];
    assert.deepEqual(askOf(event('PreToolUse', { tool_name: 'AskUserQuestion', tool_input: { questions } })), { kind: 'question', text: 'Ship T12 now?' });
    assert.deepEqual(askOf(event('PreToolUse', { tool_name: 'AskUserQuestion', tool_input: {} })), { kind: 'question', text: 'a question' });
    assert.deepEqual(askOf(event('PreToolUse', { tool_name: 'ExitPlanMode', tool_input: { plan: '...' } })), { kind: 'question', text: 'a plan to approve' });
  });

  it('asks nothing on a tool that does not stop the turn, nor on a prototype key as a tool name', () => {
    assert.equal(askOf(event('PreToolUse', { tool_name: 'Bash' })), undefined);
    assert.equal(askOf(event('PreToolUse', { tool_name: 'toString' })), undefined);
    assert.equal(askOf(event('PostToolUse', { tool_name: 'AskUserQuestion' })), undefined);
    assert.equal(askOf(event('UserPromptSubmit', { prompt: 'hi' })), undefined);
  });

  it('names an MCP form by its message, else its server', () => {
    assert.deepEqual(askOf(event('Elicitation', { message: 'Sign in to Acme', mcp_server_name: 'acme' })), { kind: 'elicitation', text: 'Sign in to Acme' });
    assert.deepEqual(askOf(event('Elicitation', { mcp_server_name: 'acme' })), { kind: 'elicitation', text: 'acme' });
  });

  it('names a decision by its line without markup, and a plain end asks nothing', () => {
    const message = 'Done.\n```\nDecision needed: shown, not asked\n```\n**Decision needed: merge T7 today?**\nMore.';
    assert.deepEqual(askOf(event('Stop', { last_assistant_message: message })), { kind: 'decision', text: 'Decision needed: merge T7 today?' });
    assert.deepEqual(askOf(event('Stop', { last_assistant_message: '## Decision needed: pick A' })), { kind: 'decision', text: 'Decision needed: pick A' });
    assert.equal(askOf(event('Stop', { last_assistant_message: 'All done.' })), undefined);
  });

  it('names an API error by its code', () => {
    assert.deepEqual(askOf(event('StopFailure', { error: 'overloaded' })), { kind: 'error', text: 'overloaded' });
    assert.deepEqual(askOf(event('StopFailure')), { kind: 'error', text: 'an API error' });
  });

  it('strips controls, folds white space and cuts a long text with an ellipsis', () => {
    const long = 'x'.repeat(NEED_TEXT_MAX_CHARS + 20);
    const asked = askOf(event('PermissionRequest', { tool_name: 'Bash', tool_input: { command: `a\u001b[31m  b\n${long}` } }));
    assert.equal(asked?.text.startsWith('Bash: a [31m b x'), true);
    assert.equal(Array.from(asked?.text ?? '').length, NEED_TEXT_MAX_CHARS);
    assert.equal(asked?.text.endsWith('…'), true);
  });
});

describe('taskOf', () => {
  it('takes the first task id of the first text that names one', () => {
    assert.equal(taskOf('merge T12 and T13'), 'T12');
    assert.equal(taskOf('no id here', undefined, 'for T9'), 'T9');
    assert.equal(taskOf('BT12 or T12x'), null);
    assert.equal(taskOf(undefined), null);
  });
});

describe('tabNeedOf', () => {
  it('records the ask, its task from the text or the whole message, and nothing for an event that asks nothing', () => {
    assert.deepEqual(tabNeedOf('alpha', 'waiting', event('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'npm test' } }), 6900, SINCE), WAITING);
    const decided = tabNeedOf('alpha', 'decision', event('Stop', { last_assistant_message: 'T44 is ready.\nDecision needed: ship it?' }), 6900, SINCE);
    assert.deepEqual(decided, { ...WAITING, state: 'decision', kind: 'decision', text: 'Decision needed: ship it?', task: 'T44' });
    assert.deepEqual(tabNeedOf('alpha', 'working', event('PostToolUse'), null, SINCE), { session: 'alpha', state: 'working', kind: null, text: null, task: null, pid: null, since: SINCE });
  });
});

describe('parseTabNeed', () => {
  it('reads what formatTabNeed wrote, an ask or none', () => {
    assert.deepEqual(parseTabNeed(formatTabNeed(WAITING)), WAITING);
    const clear: TabNeed = { ...WAITING, state: 'ready', kind: null, text: null, pid: null };
    assert.deepEqual(parseTabNeed(formatTabNeed(clear)), clear);
  });

  it('reads a damaged file, another format or a bad field as absent', () => {
    const line = (fields: JsonRecord): string => JSON.stringify({ v: 1, ...WAITING, ...fields });
    const bad = ['{not json', JSON.stringify({ ...WAITING, v: 2 }), line({ session: 3 }), line({ state: 'asleep' }), line({ kind: 'other' }), line({ kind: undefined })];
    for (const text of [...bad, line({ text: 4 }), line({ task: 5 }), line({ pid: 0 }), line({ pid: '6900' }), line({ since: 'today' })]) {
      assert.equal(parseTabNeed(text), undefined, text);
    }
  });
});

describe('TabNeedStore', () => {
  it('writes a change, skips a rewrite that changes only the time, reads all and removes', async () => {
    const files = new MemoryFiles();
    const store = new TabNeedStore(files, PATHS);
    assert.deepEqual(await store.readAll(), []);
    assert.equal(await store.record(WAITING), true);
    assert.equal(await store.record({ ...WAITING, since: '2030-01-08T10:05:00.000Z' }), false);
    assert.deepEqual(await store.read('alpha'), WAITING);
    const bravo: TabNeed = { ...WAITING, session: 'bravo', state: 'working', kind: null, text: null };
    assert.equal(await store.record(bravo), true);
    await files.write(join(PATHS.tabs, 'damaged.json'), '{not json');
    await files.write(join(PATHS.tabs, 'notes.txt'), 'x');
    assert.deepEqual(await store.readAll(), [WAITING, bravo]);
    assert.equal(await store.remove('alpha'), true);
    assert.equal(await store.remove('alpha'), false);
    assert.deepEqual(files.paths().sort(), [join(PATHS.tabs, 'bravo.json'), join(PATHS.tabs, 'damaged.json'), join(PATHS.tabs, 'notes.txt')].map(normalisePath).sort());
  });
});
