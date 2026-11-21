import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TOOL_KINDS, type JsonRecord, type ToolCall } from '../../../plugin-api/index.ts';
import { toolCallShape } from './tool-call.ts';

function call(name: string, input: JsonRecord, platform: NodeJS.Platform = 'linux'): ToolCall {
  return toolCallShape(platform).normalize(name, input);
}

describe("Claude Code's shell tools", () => {
  it('are shell calls in their dialect, the command as written its one reading', () => {
    const input = { command: 'git status', description: 'status' };
    assert.deepEqual(call('Bash', input), { kind: 'shell', name: 'Bash', input, dialect: 'bash', command: 'git status', readings: ['git status'] });
    assert.deepEqual(call('PowerShell', input), { kind: 'shell', name: 'PowerShell', input, dialect: 'powershell', command: 'git status', readings: ['git status'] });
  });

  it('give a Bash command its halved reading on Windows, and a PowerShell command none', () => {
    const input = { command: 'ls a\\\\\\; rm -f x' };
    assert.deepEqual(call('Bash', input, 'win32'), { kind: 'shell', name: 'Bash', input, dialect: 'bash', command: 'ls a\\\\\\; rm -f x', readings: ['ls a\\\\\\; rm -f x', 'ls a\\\\; rm -f x'] });
    assert.deepEqual(call('PowerShell', input, 'win32'), { kind: 'shell', name: 'PowerShell', input, dialect: 'powershell', command: 'ls a\\\\\\; rm -f x', readings: ['ls a\\\\\\; rm -f x'] });
  });

  it('have no reading when the call carries no command', () => {
    assert.deepEqual(call('Bash', { command: 7 }, 'win32'), { kind: 'shell', name: 'Bash', input: { command: 7 }, dialect: 'bash', command: undefined, readings: [] });
  });
});

describe("Claude Code's file tools", () => {
  it('read one path', () => {
    const input = { file_path: '/repo/a.ts', limit: 5 };
    assert.deepEqual(call('Read', input), { kind: 'read', name: 'Read', input, path: '/repo/a.ts' });
  });

  it('write the texts of a Write, an Edit, each MultiEdit edit and a NotebookEdit', () => {
    const write = { file_path: '/repo/a.ts', content: 'whole' };
    assert.deepEqual(call('Write', write), { kind: 'edit', name: 'Write', input: write, path: '/repo/a.ts', texts: ['whole'], change: { kind: 'whole', text: 'whole' } });
    const edit = { file_path: '/repo/a.ts', old_string: 'x', new_string: 'y' };
    const replaces = { kind: 'replacements', replacements: [{ from: 'x', to: 'y', all: false }] };
    assert.deepEqual(call('Edit', edit), { kind: 'edit', name: 'Edit', input: edit, path: '/repo/a.ts', texts: ['y'], change: replaces });
    const multi = { file_path: '/repo/a.ts', edits: [{ old_string: 'a', new_string: 'one' }, 'not an edit', { old_string: 'b', new_string: 'two' }] };
    assert.deepEqual(call('MultiEdit', multi), { kind: 'edit', name: 'MultiEdit', input: multi, path: '/repo/a.ts', texts: ['one', 'two'], change: undefined });
    const notebook = { notebook_path: '/repo/n.ipynb', new_source: 'cell' };
    assert.deepEqual(call('NotebookEdit', notebook), { kind: 'edit', name: 'NotebookEdit', input: notebook, path: '/repo/n.ipynb', texts: ['cell'], change: undefined });
  });

  it("say the change an edit makes to its file's text, and none where the input does not read as one", () => {
    const changeOf = (name: string, input: JsonRecord): unknown => {
      const made = call(name, input);
      return made.kind === 'edit' ? made.change : 'not an edit';
    };
    assert.deepEqual(changeOf('Edit', { file_path: 'a', old_string: 'x', new_string: 'y', replace_all: true }), { kind: 'replacements', replacements: [{ from: 'x', to: 'y', all: true }] });
    const edits = [{ old_string: 'a', new_string: 'one' }, { old_string: 'b', new_string: 'two', replace_all: true }];
    assert.deepEqual(changeOf('MultiEdit', { file_path: 'a', edits }), { kind: 'replacements', replacements: [{ from: 'a', to: 'one', all: false }, { from: 'b', to: 'two', all: true }] });
    assert.deepEqual(changeOf('MultiEdit', { file_path: 'a', edits: [] }), { kind: 'replacements', replacements: [] });
    assert.equal(changeOf('Write', { file_path: 'a' }), undefined);
    assert.equal(changeOf('Edit', { file_path: 'a', new_string: 'y' }), undefined);
    assert.equal(changeOf('MultiEdit', { file_path: 'a', edits: 'all of it' }), undefined);
    assert.equal(changeOf('MultiEdit', { file_path: 'a', edits: [{ old_string: 'a', new_string: 'one' }, { new_string: 'two' }] }), undefined);
  });

  it('search by content or by name', () => {
    const grep = { pattern: 'key', path: '/repo', glob: '*.env', output_mode: 'content' };
    assert.deepEqual(call('Grep', grep), { kind: 'search', name: 'Grep', input: grep, path: '/repo', glob: '*.env', showsContent: true });
    const names = { pattern: 'key' };
    assert.deepEqual(call('Grep', names), { kind: 'search', name: 'Grep', input: names, path: undefined, glob: undefined, showsContent: false });
    const glob = { pattern: '**/*.ts', path: '/repo' };
    assert.deepEqual(call('Glob', glob), { kind: 'search', name: 'Glob', input: glob, path: '/repo', glob: '**/*.ts', showsContent: false });
  });
});

describe("Claude Code's other tools", () => {
  it('fetch a page or search the web', () => {
    const fetch = { url: 'https://example.com/a', prompt: 'read' };
    assert.deepEqual(call('WebFetch', fetch), { kind: 'web', name: 'WebFetch', input: fetch, url: 'https://example.com/a' });
    assert.deepEqual(call('WebSearch', { query: 'q' }), { kind: 'web', name: 'WebSearch', input: { query: 'q' }, url: undefined });
  });

  it('start a helper under either of its names', () => {
    const input = { subagent_type: 'Explore', prompt: 'find' };
    assert.deepEqual(call('Agent', input), { kind: 'helper', name: 'Agent', input, type: 'Explore' });
    assert.deepEqual(call('Task', input), { kind: 'helper', name: 'Task', input, type: 'Explore' });
  });

  it('load a skill, ask the human, schedule and message', () => {
    assert.deepEqual(call('Skill', { skill: 'dev-ship-change' }), { kind: 'skill', name: 'Skill', input: { skill: 'dev-ship-change' }, skill: 'dev-ship-change' });
    assert.deepEqual(call('AskUserQuestion', { questions: [] }), { kind: 'ask', name: 'AskUserQuestion', input: { questions: [] }, asks: 'question', question: undefined });
    assert.deepEqual(call('ExitPlanMode', {}), { kind: 'ask', name: 'ExitPlanMode', input: {}, asks: 'plan', question: undefined });
    assert.deepEqual(call('CronCreate', { cron: '* * * * *' }), { kind: 'schedule', name: 'CronCreate', input: { cron: '* * * * *' } });
    assert.deepEqual(call('ScheduleWakeup', { delaySeconds: 60 }), { kind: 'schedule', name: 'ScheduleWakeup', input: { delaySeconds: 60 } });
    const message = { to: 'lead', message: 'done' };
    assert.deepEqual(call('SendMessage', message), { kind: 'message', name: 'SendMessage', input: message, to: 'lead', text: 'done' });
  });

  it('give an ask its first question as written, and none where the input lists no question', () => {
    const questionOf = (name: string, input: JsonRecord): unknown => {
      const asked = call(name, input);
      return asked.kind === 'ask' ? asked.question : 'not an ask';
    };
    assert.equal(questionOf('AskUserQuestion', { questions: ['not a question', { question: 'Which base? ' }, { question: 'And then?' }] }), 'Which base? ');
    assert.equal(questionOf('AskUserQuestion', { questions: [{ header: 'Base' }, { question: 'And then?' }] }), undefined, 'only the first question is read');
    assert.equal(questionOf('AskUserQuestion', { questions: 'Which base?' }), undefined);
    assert.equal(questionOf('ExitPlanMode', { plan: 'the plan' }), undefined);
    assert.equal(questionOf('Bash', { questions: [{ question: 'Which base?' }] }), 'not an ask');
  });

  it("name a message's receiver without the [ref] that tells two sessions of one name apart, and none for a blank name", () => {
    const receiverOf = (to: unknown): unknown => {
      const sent = call('SendMessage', { to });
      return sent.kind === 'message' ? sent.to : 'no message';
    };
    assert.equal(receiverOf('app-alpha [uds:4f2a]'), 'app-alpha');
    assert.equal(receiverOf(' app-alpha '), 'app-alpha');
    assert.equal(receiverOf(' '), undefined);
    assert.equal(receiverOf('[3fa9c1]'), undefined);
    assert.equal(receiverOf(7), undefined);
    assert.equal(call('SendMessage', { to: 'lead', notify_when_idle: true }).input['message'], undefined);
  });

  it('are `other` when no row names them, a name every object has too', () => {
    assert.deepEqual(call('mcp__server__tool', { a: 1 }), { kind: 'other', name: 'mcp__server__tool', input: { a: 1 } });
    assert.deepEqual(call('toString', {}), { kind: 'other', name: 'toString', input: {} });
    assert.deepEqual(call('constructor', {}), { kind: 'other', name: 'constructor', input: {} });
  });

  it('are only of kinds the port names', () => {
    for (const name of ['Bash', 'Read', 'Write', 'Grep', 'WebFetch', 'Agent', 'Skill', 'AskUserQuestion', 'CronCreate', 'SendMessage', 'Unknown']) {
      assert.ok(TOOL_KINDS.includes(call(name, {}).kind), name);
    }
  });
});
