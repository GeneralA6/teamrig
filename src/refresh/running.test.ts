import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryFiles } from '../testing/memory-files.ts';
import { readRunningKinds, readRunningWork, RUNNING_MAX_AGE_MS, RUNNING_TAIL_BYTES, runningKindsOf, runningWorkOf } from './running.ts';

const NOW = Date.parse('2030-01-08T10:00:00Z');
const TRANSCRIPT = '/t/session.jsonl';

/** An assistant entry calling `name` as the way Claude Code writes it. */
function call(id: string, name: string): string {
  return JSON.stringify({ type: 'assistant', isSidechain: false, message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input: {} }] } });
}

/** The tool-result entry answering `id`, with Claude Code's structured `toolUseResult`. */
function result(id: string, toolUseResult: Readonly<Record<string, unknown>>, at = NOW - 60_000): string {
  return JSON.stringify({
    type: 'user',
    timestamp: new Date(at).toISOString(),
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'started' }] },
    toolUseResult,
  });
}

/** A notification as Claude Code queues it when background work ends. */
function notification(id: string, status: string): string {
  const text = `<task-notification>\n<task-id>b1</task-id>\n<tool-use-id>${id}</tool-use-id>\n<status>${status}</status>\n</task-notification>`;
  return JSON.stringify({ type: 'queue-operation', operation: 'enqueue', content: text });
}

/** A TaskStop call and its result as Claude Code writes them when it stopped `task`. */
function stop(id: string, task: string, taskType = 'local_bash'): readonly string[] {
  return [call(id, 'TaskStop'), result(id, { message: `Successfully stopped task: ${task} (npm test)`, task_id: task, task_type: taskType, command: 'npm test' })];
}

const BASH = [call('toolu_bash', 'Bash'), result('toolu_bash', { stdout: '', backgroundTaskId: 'b1' })];
const AGENT = [call('toolu_agent', 'Agent'), result('toolu_agent', { isAsync: true, status: 'async_launched', agentId: 'a1' })];
const MONITOR = [call('toolu_monitor', 'Monitor'), result('toolu_monitor', { taskId: 'm1', timeoutMs: 900_000, persistent: false })];
const WORKFLOW = [call('toolu_flow', 'Workflow'), result('toolu_flow', { taskId: 'w1' })];

function text(lines: readonly string[]): string {
  return `${lines.join('\n')}\n`;
}

describe('runningWorkOf', () => {
  it('counts each background command, async subagent, monitor and workflow that has not reported back', () => {
    assert.equal(runningWorkOf(text([...BASH, ...AGENT, ...MONITOR, ...WORKFLOW]), false, NOW), 4);
  });

  it('drops work that a notification ended with a final status, in any of the forms Claude Code writes it', () => {
    const attachment = JSON.stringify({ type: 'attachment', attachment: { type: 'queued_command', prompt: '<task-notification>\n<tool-use-id>toolu_agent</tool-use-id>\n<status>failed</status>' } });
    const lines = [...BASH, ...AGENT, ...MONITOR, ...WORKFLOW, notification('toolu_bash', 'completed'), attachment, notification('toolu_monitor', 'killed'), notification('toolu_flow', 'stopped')];
    assert.equal(runningWorkOf(text(lines), false, NOW), 0);
  });

  it('reads two notifications in one line', () => {
    const both = JSON.stringify({ type: 'user', message: { role: 'user', content: `<task-notification><tool-use-id>toolu_bash</tool-use-id><status>completed</status></task-notification>\n<task-notification><tool-use-id>toolu_agent</tool-use-id><status>completed</status></task-notification>` } });
    assert.equal(runningWorkOf(text([...BASH, ...AGENT, both]), false, NOW), 0);
  });

  it('keeps work running after a notification without a final status', () => {
    assert.equal(runningWorkOf(text([...MONITOR, notification('toolu_monitor', 'running')]), false, NOW), 1);
  });

  it("does not count a result that names a task it did not start, such as TaskStop's, or a foreground call", () => {
    const stop = [call('toolu_stop', 'TaskStop'), result('toolu_stop', { taskId: 'b1', message: 'stopped' })];
    const foreground = [call('toolu_ls', 'Bash'), result('toolu_ls', { stdout: 'a\nb', interrupted: false })];
    assert.equal(runningWorkOf(text([...stop, ...foreground]), false, NOW), 0);
  });

  it('drops work that TaskStop stopped, which gets no notification', () => {
    const lines = [...BASH, ...AGENT, ...MONITOR, ...WORKFLOW, ...stop('toolu_s1', 'b1'), ...stop('toolu_s2', 'a1', 'local_agent'), ...stop('toolu_s3', 'm1')];
    assert.deepEqual(runningKindsOf(text(lines), false, NOW), ['workflow']);
  });

  it('keeps work running after a TaskStop that failed or stopped another task', () => {
    const failed = JSON.stringify({
      type: 'user',
      timestamp: new Date(NOW - 30_000).toISOString(),
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_s1', content: 'Error: No task found with ID: b1', is_error: true }] },
      toolUseResult: 'Error: No task found with ID: b1',
    });
    const lines = [...BASH, call('toolu_s1', 'TaskStop'), failed, ...stop('toolu_s2', 'b7')];
    assert.equal(runningWorkOf(text(lines), false, NOW), 1);
  });

  it('ends nothing on a result naming a task_id that does not answer a TaskStop', () => {
    const output = [call('toolu_out', 'TaskOutput'), result('toolu_out', { task_id: 'b1', status: 'running' })];
    assert.equal(runningWorkOf(text([...BASH, ...output]), false, NOW), 1);
  });

  it('takes work started longer ago than the age limit as gone', () => {
    const old = [call('toolu_old', 'Bash'), result('toolu_old', { backgroundTaskId: 'b0' }, NOW - RUNNING_MAX_AGE_MS - 1)];
    const edge = [call('toolu_edge', 'Bash'), result('toolu_edge', { backgroundTaskId: 'b2' }, NOW - RUNNING_MAX_AGE_MS)];
    assert.equal(runningWorkOf(text([...old, ...edge]), false, NOW), 1);
  });

  it('skips damaged lines and the first line of a cut tail', () => {
    const damaged = `${result('toolu_x', { backgroundTaskId: 'b9' }).slice(0, 40)}`;
    assert.equal(runningWorkOf(text([damaged, ...AGENT]), false, NOW), 1);
    assert.equal(runningWorkOf(text([result('toolu_cut', { backgroundTaskId: 'b8' }), ...AGENT]), true, NOW), 1);
  });

  it('reads Windows line ends', () => {
    assert.equal(runningWorkOf(`${[...BASH, ...AGENT].join('\r\n')}\r\n`, false, NOW), 2);
  });
});

describe('runningKindsOf', () => {
  it('names the kind of each work still running', () => {
    assert.deepEqual(runningKindsOf(text([...BASH, ...AGENT, ...MONITOR, ...WORKFLOW]), false, NOW), ['command', 'helper', 'monitor', 'workflow']);
  });

  it('leaves out the work that ended', () => {
    assert.deepEqual(runningKindsOf(text([...BASH, ...AGENT, ...WORKFLOW, notification('toolu_agent', 'completed')]), false, NOW), ['command', 'workflow']);
  });
});

describe('readRunningKinds', () => {
  it('reads the transcript, and finds nothing in a missing one', async () => {
    const files = new MemoryFiles();
    await files.write(TRANSCRIPT, text([...BASH, ...AGENT, notification('toolu_bash', 'completed')]));
    assert.deepEqual(await readRunningKinds(files, TRANSCRIPT, NOW), ['helper']);
    assert.deepEqual(await readRunningKinds(new MemoryFiles(), TRANSCRIPT, NOW), []);
  });
});

describe('readRunningWork', () => {
  it('reads the transcript, and counts nothing for a missing one', async () => {
    const files = new MemoryFiles();
    await files.write(TRANSCRIPT, text([...BASH, ...AGENT, notification('toolu_bash', 'completed')]));
    assert.equal(await readRunningWork(files, TRANSCRIPT, NOW), 1);
    assert.equal(await readRunningWork(new MemoryFiles(), TRANSCRIPT, NOW), 0);
  });

  it('reads only the tail of a long transcript, its first line taken as cut', async () => {
    const files = new MemoryFiles();
    const filler = `${JSON.stringify({ type: 'user', message: { content: 'x'.repeat(RUNNING_TAIL_BYTES) } })}\n`;
    await files.write(TRANSCRIPT, `${text(BASH)}${filler}${text(AGENT)}`);
    assert.equal(await readRunningWork(files, TRANSCRIPT, NOW), 1, 'the command started before the tail is not seen');
  });
});
