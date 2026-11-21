import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { toolCallShape } from './tool-call.ts';

describe("Antigravity's tool calls", () => {
  const win = toolCallShape('win32');
  const linux = toolCallShape('linux');

  it('normalizes run_command with platform-appropriate shell dialect', () => {
    assert.deepEqual(win.normalize('run_command', { CommandLine: 'git status' }), {
      kind: 'shell',
      name: 'run_command',
      input: { CommandLine: 'git status' },
      dialect: 'powershell',
      command: 'git status',
      readings: ['git status'],
    });
    assert.deepEqual(linux.normalize('run_command', { CommandLine: 'git status' }), {
      kind: 'shell',
      name: 'run_command',
      input: { CommandLine: 'git status' },
      dialect: 'bash',
      command: 'git status',
      readings: ['git status'],
    });
  });

  it('normalizes read_file, write_file, and edit_file', () => {
    assert.deepEqual(linux.normalize('read_file', { Path: '/a/b.ts' }), {
      kind: 'read',
      name: 'read_file',
      input: { Path: '/a/b.ts' },
      path: '/a/b.ts',
    });
    assert.deepEqual(linux.normalize('write_file', { Path: '/a/b.ts', Content: 'hello' }), {
      kind: 'edit',
      name: 'write_file',
      input: { Path: '/a/b.ts', Content: 'hello' },
      path: '/a/b.ts',
      texts: ['hello'],
      change: { kind: 'whole', text: 'hello' },
    });
    assert.deepEqual(linux.normalize('edit_file', { Path: '/a/b.ts', Target: 'old', Replacement: 'new' }), {
      kind: 'edit',
      name: 'edit_file',
      input: { Path: '/a/b.ts', Target: 'old', Replacement: 'new' },
      path: '/a/b.ts',
      texts: ['new'],
      change: { kind: 'replacements', replacements: [{ from: 'old', to: 'new', all: true }] },
    });
  });

  it('normalizes search, web, helper, message, ask, schedule, and unknown tools', () => {
    assert.equal(linux.normalize('grep_search', { SearchPath: '/src' }).kind, 'search');
    assert.equal(linux.normalize('find_by_name', { SearchDirectory: '/src', Pattern: '*.ts' }).kind, 'search');
    assert.equal(linux.normalize('list_dir', { DirectoryPath: '/src' }).kind, 'search');
    assert.equal(linux.normalize('read_url_content', { Url: 'https://example.com' }).kind, 'web');
    assert.equal(linux.normalize('search_web', { query: 'teamrig' }).kind, 'web');
    assert.deepEqual(linux.normalize('invoke_subagent', { TypeName: 'research' }), {
      kind: 'helper',
      name: 'invoke_subagent',
      input: { TypeName: 'research' },
      type: 'research',
    });
    assert.deepEqual(linux.normalize('send_message', { Recipient: 'agent-1', Message: 'done' }), {
      kind: 'message',
      name: 'send_message',
      input: { Recipient: 'agent-1', Message: 'done' },
      to: 'agent-1',
      text: 'done',
    });
    assert.deepEqual(linux.normalize('ask_question', { questions: [{ question: 'Proceed?' }] }), {
      kind: 'ask',
      name: 'ask_question',
      input: { questions: [{ question: 'Proceed?' }] },
      asks: 'question',
      question: 'Proceed?',
    });
    assert.equal(linux.normalize('schedule', { Prompt: 'check' }).kind, 'schedule');
    assert.equal(linux.normalize('manage_task', { Action: 'list' }).kind, 'other');
  });
});
