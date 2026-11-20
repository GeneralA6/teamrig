import type { Files } from '../core/files.ts';
import type { BackgroundMark, InputEntry, ReplyEntry, TranscriptReader } from '../ports/host/index.ts';

/**
 * Background work a session started and that has not reported back yet: subagents, background
 * commands, monitors and workflows. A refresh then would cut it off, so the Stop hook waits for it.
 * The host records each start as a tool result and each end either as a `<task-notification>`
 * naming the starting call's `<tool-use-id>` and a final `<status>`, or, for work stopped with
 * TaskStop (which gets no notification), as TaskStop's result naming the stopped task.
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

/** Tools whose result names as a task the work they started, by kind; TaskStop's and TaskOutput's name one they did not. */
const TASK_TOOLS: ReadonlyMap<string, BackgroundKind> = new Map([
  ['Monitor', 'monitor'],
  ['Workflow', 'workflow'],
]);

/** The tool that stops background work; its result names the work it ended. */
const STOP_TOOL = 'TaskStop';

/** The notification statuses that end the work; any other leaves it running. */
const FINAL_STATUSES: ReadonlySet<string> = new Set(['completed', 'failed', 'killed', 'stopped']);

const NOTIFICATION = '<task-notification>';
const TOOL_USE_ID = /<tool-use-id>([^<]+)<\/tool-use-id>/;
const STATUS = /<status>([a-z_]+)<\/status>/;

/**
 * The words a line holds when it carries a tool's structured answer, or a tool call: only such a line is read as
 * an entry, since the tail is megabytes long and most of its lines name neither.
 */
const ANSWER_WORDS = '"toolUseResult"';
const CALL_WORDS = '"tool_use"';

/** One start: its kind, the task it named (which a stop names back) and when it was written, in ms. */
interface Started {
  readonly kind: BackgroundKind;
  readonly task: string | undefined;
  readonly at: number | undefined;
}

/** What the lines read so far say: the starts by their call, the calls a notification ended, the tasks stopped, and the calls of the task tools and of the stop tool. */
interface Scan {
  readonly started: Map<string, Started>;
  readonly ended: Set<string>;
  readonly stopped: Set<string>;
  readonly taskCalls: Map<string, BackgroundKind>;
  readonly stopCalls: Set<string>;
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

/** Keeps a reply's calls of the task tools and of the stop tool, whose answers are told apart by the call they answer. */
function noteCalls(scan: Scan, reply: ReplyEntry): void {
  for (const { id, name } of reply.calls) {
    const kind = TASK_TOOLS.get(name);
    if (kind !== undefined) {
      scan.taskCalls.set(id, kind);
    } else if (name === STOP_TOOL) {
      scan.stopCalls.add(id);
    }
  }
}

/** The kind of background work a tool's answer says it started; undefined when it started none. `call` is the call it answers. */
function startedKindOf(mark: BackgroundMark, call: string, taskCalls: ReadonlyMap<string, BackgroundKind>): BackgroundKind | undefined {
  return mark.started === 'task' ? taskCalls.get(call) : mark.started;
}

/** Keeps the work a tool's answer started, and the task it stopped when it answers the stop tool. */
function noteAnswer(scan: Scan, input: InputEntry): void {
  const mark = input.background;
  const call = input.results[0]?.call;
  if (mark === undefined || call === undefined) {
    return;
  }
  if (mark.stopped !== undefined && scan.stopCalls.has(call)) {
    scan.stopped.add(mark.stopped);
  }
  const kind = startedKindOf(mark, call, scan.taskCalls);
  if (kind !== undefined) {
    scan.started.set(call, { kind, task: mark.task, at: input.at });
  }
}

/**
 * The kind of each background work still running in transcript lines at `now`: started (a background
 * command's id, an async subagent, a Monitor or Workflow task) within `RUNNING_MAX_AGE_MS`, not ended
 * by a notification and not stopped by a TaskStop whose result names its task (an error result, a
 * failed stop, ends nothing). A `cut` text, the tail of a longer file, may start mid-line, so its first
 * line is skipped; damaged lines are skipped too. Only lines naming a start or a call are read as
 * entries; a notification is matched in the line's own text, since it may sit in a line queued as no
 * input yet.
 */
export function runningKindsOf(reader: TranscriptReader, text: string, cut: boolean, now: number): readonly BackgroundKind[] {
  const scan: Scan = { started: new Map(), ended: new Set(), stopped: new Set(), taskCalls: new Map(), stopCalls: new Set() };
  for (const line of text.split('\n').slice(cut ? 1 : 0)) {
    if (line.includes(NOTIFICATION)) {
      endedCallsOf(line).forEach((call) => scan.ended.add(call));
    }
    const entry = line.includes(ANSWER_WORDS) || line.includes(CALL_WORDS) ? reader.entry(line, ['input', 'reply']) : undefined;
    if (entry?.kind === 'reply') {
      noteCalls(scan, entry);
    } else if (entry?.kind === 'input') {
      noteAnswer(scan, entry);
    }
  }
  return [...scan.started]
    .filter(([call, { task, at }]) => !scan.ended.has(call) && (task === undefined || !scan.stopped.has(task)) && (at === undefined || now - at <= RUNNING_MAX_AGE_MS))
    .map(([, { kind }]) => kind);
}

/** How many background works are still running in transcript lines at `now` (`runningKindsOf`). */
export function runningWorkOf(reader: TranscriptReader, text: string, cut: boolean, now: number): number {
  return runningKindsOf(reader, text, cut, now).length;
}

/**
 * The kind of each background work still running, from the transcript's last `RUNNING_TAIL_BYTES`;
 * none when the transcript is missing. A tail as long as the limit is taken as cut.
 */
export async function readRunningKinds(reader: TranscriptReader, files: Files, transcript: string, now: number): Promise<readonly BackgroundKind[]> {
  const text = await files.readTail(transcript, RUNNING_TAIL_BYTES);
  return text === undefined ? [] : runningKindsOf(reader, text, Buffer.byteLength(text, 'utf8') >= RUNNING_TAIL_BYTES, now);
}

/** How many background works are still running, from the transcript's tail (`readRunningKinds`); 0 when it is missing. */
export async function readRunningWork(reader: TranscriptReader, files: Files, transcript: string, now: number): Promise<number> {
  return (await readRunningKinds(reader, files, transcript, now)).length;
}
