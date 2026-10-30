import type { Files } from '../core/files.ts';
import { isRecord, recordField, stringField, type JsonRecord } from '../core/guards.ts';
import { parseObject } from '../core/jsonl.ts';

/**
 * Background work a session started and that has not reported back yet: subagents, background
 * commands, monitors and workflows. A refresh then would cut it off, so the Stop hook waits for it.
 * Claude Code records each start as a tool result and each end either as a `<task-notification>`
 * naming the starting call's `<tool-use-id>` and a final `<status>`, or, for work stopped with
 * TaskStop (which gets no notification), as TaskStop's result naming the stopped `task_id`.
 */

/**
 * How much of the transcript's end is read: work started before it is not seen. Far more than the
 * context tail, since a long subagent or a queued command may run while the session writes megabytes.
 */
export const RUNNING_TAIL_BYTES = 8 * 1024 * 1024;

/**
 * Work started longer ago than this is taken as gone: a restarted session loses its background work
 * without a notification, which would otherwise hold the refresh until the start leaves the tail.
 */
export const RUNNING_MAX_AGE_MS = 6 * 60 * 60 * 1000;

/** What a start is: a background command, an async subagent (a helper), a Monitor or a Workflow. */
export type BackgroundKind = 'command' | 'helper' | 'monitor' | 'workflow';

/** Tools whose result's `taskId` names work they started, by kind; TaskStop's and TaskOutput's name one they did not. */
const TASK_TOOLS: ReadonlyMap<string, BackgroundKind> = new Map([
  ['Monitor', 'monitor'],
  ['Workflow', 'workflow'],
]);

/** The tool that stops background work; its result's `task_id` names the work it ended. */
const STOP_TOOL = 'TaskStop';

/** The notification statuses that end the work; any other leaves it running. */
const FINAL_STATUSES: ReadonlySet<string> = new Set(['completed', 'failed', 'killed', 'stopped']);

const NOTIFICATION = '<task-notification>';
const TOOL_USE_ID = /<tool-use-id>([^<]+)<\/tool-use-id>/;
const STATUS = /<status>([a-z_]+)<\/status>/;

/** The content blocks of a transcript entry's message; none for a string or a missing message. */
function blocksOf(entry: JsonRecord): readonly JsonRecord[] {
  const content = recordField(entry, 'message')?.['content'];
  return Array.isArray(content) ? content.filter(isRecord) : [];
}

/** The tool calls in an assistant entry, each id with the tool's name. */
function toolCallsOf(entry: JsonRecord): readonly (readonly [string, string])[] {
  return blocksOf(entry).flatMap((block) => {
    const id = block['type'] === 'tool_use' ? stringField(block, 'id') : undefined;
    const name = stringField(block, 'name');
    return id === undefined || name === undefined ? [] : [[id, name] as const];
  });
}

/** The kind of background work a tool's result says it started; undefined when it started none. `call` is the call it answers. */
function startedKindOf(result: JsonRecord, call: string, taskCalls: ReadonlyMap<string, BackgroundKind>): BackgroundKind | undefined {
  if (typeof result['backgroundTaskId'] === 'string') {
    return 'command';
  }
  if (result['status'] === 'async_launched') {
    return 'helper';
  }
  return typeof result['taskId'] === 'string' ? taskCalls.get(call) : undefined;
}

/** The task id of the work a start result names, which TaskStop names when it stops that work. */
function startedTaskOf(result: JsonRecord): string | undefined {
  return stringField(result, 'backgroundTaskId') ?? stringField(result, 'agentId') ?? stringField(result, 'taskId');
}

/** The call a tool-result entry answers; undefined for any other entry. */
function answeredCallOf(entry: JsonRecord): string | undefined {
  const block = blocksOf(entry).find((candidate) => candidate['type'] === 'tool_result');
  return block === undefined ? undefined : stringField(block, 'tool_use_id');
}

/** The calls whose work a line's notifications end: those with a final status. */
function endedCallsOf(line: string): readonly string[] {
  return line
    .split(NOTIFICATION)
    .slice(1)
    .flatMap((part) => {
      const call = TOOL_USE_ID.exec(part)?.[1];
      const status = STATUS.exec(part)?.[1];
      return call !== undefined && status !== undefined && FINAL_STATUSES.has(status) ? [call] : [];
    });
}

/** When an entry was written, in ms; undefined without a readable timestamp. */
function timeOf(entry: JsonRecord): number | undefined {
  const stamp = stringField(entry, 'timestamp');
  const ms = stamp === undefined ? Number.NaN : Date.parse(stamp);
  return Number.isNaN(ms) ? undefined : ms;
}

/**
 * The kind of each background work still running in transcript lines at `now`: started (a background
 * command's id, an async subagent, a Monitor or Workflow task) within `RUNNING_MAX_AGE_MS`, not ended
 * by a notification and not stopped by a TaskStop whose result names its task (an error result, a
 * failed stop, ends nothing). A `cut` text, the tail of a longer file, may start mid-line, so its first
 * line is skipped; damaged lines are skipped too. Only lines naming a start or a notification are parsed.
 */
export function runningKindsOf(text: string, cut: boolean, now: number): readonly BackgroundKind[] {
  const started = new Map<string, { readonly kind: BackgroundKind; readonly task: string | undefined; readonly at: number | undefined }>();
  const ended = new Set<string>();
  const stopped = new Set<string>();
  const taskCalls = new Map<string, BackgroundKind>();
  const stopCalls = new Set<string>();
  const lines = text.split('\n').slice(cut ? 1 : 0);
  for (const line of lines) {
    if (line.includes(NOTIFICATION)) {
      endedCallsOf(line).forEach((call) => ended.add(call));
    }
    const entry = line.includes('"toolUseResult"') || line.includes('"tool_use"') ? parseObject(line) : undefined;
    if (entry === undefined) {
      continue;
    }
    for (const [call, name] of toolCallsOf(entry)) {
      const kind = TASK_TOOLS.get(name);
      if (kind !== undefined) {
        taskCalls.set(call, kind);
      } else if (name === STOP_TOOL) {
        stopCalls.add(call);
      }
    }
    const result = recordField(entry, 'toolUseResult');
    const call = answeredCallOf(entry);
    if (result === undefined || call === undefined) {
      continue;
    }
    const stoppedTask = stopCalls.has(call) ? stringField(result, 'task_id') : undefined;
    if (stoppedTask !== undefined) {
      stopped.add(stoppedTask);
    }
    const kind = startedKindOf(result, call, taskCalls);
    if (kind !== undefined) {
      started.set(call, { kind, task: startedTaskOf(result), at: timeOf(entry) });
    }
  }
  return [...started]
    .filter(([call, { task, at }]) => !ended.has(call) && (task === undefined || !stopped.has(task)) && (at === undefined || now - at <= RUNNING_MAX_AGE_MS))
    .map(([, { kind }]) => kind);
}

/** How many background works are still running in transcript lines at `now` (`runningKindsOf`). */
export function runningWorkOf(text: string, cut: boolean, now: number): number {
  return runningKindsOf(text, cut, now).length;
}

/**
 * The kind of each background work still running, from the transcript's last `RUNNING_TAIL_BYTES`;
 * none when the transcript is missing. A tail as long as the limit is taken as cut.
 */
export async function readRunningKinds(files: Files, transcript: string, now: number): Promise<readonly BackgroundKind[]> {
  const text = await files.readTail(transcript, RUNNING_TAIL_BYTES);
  return text === undefined ? [] : runningKindsOf(text, Buffer.byteLength(text, 'utf8') >= RUNNING_TAIL_BYTES, now);
}

/** How many background works are still running, from the transcript's tail (`readRunningKinds`); 0 when it is missing. */
export async function readRunningWork(files: Files, transcript: string, now: number): Promise<number> {
  return (await readRunningKinds(files, transcript, now)).length;
}
