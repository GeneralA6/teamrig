import {
  instantField,
  isNonNegativeInteger,
  isRecord,
  recordField,
  stringField,
  type BackgroundMark,
  type CallUsage,
  type EntryKind,
  type EnvironmentEntry,
  type HookNoteEntry,
  type InputEntry,
  type InputOrigin,
  type JsonRecord,
  type ModelSwitchEntry,
  type QueuedPromptEntry,
  type ReplyCall,
  type ReplyEntry,
  type ScheduledCarryEntry,
  type ScheduledJob,
  type TitleEntry,
  type ToolOutcome,
  type TranscriptEntry,
  type TranscriptReader,
  type UnreadLine,
} from '../../../plugin-api/index.ts';

/**
 * Claude Code's transcript, a JSONL file with one entry per line, as the entries teamrig's readers share. This file
 * is the only place that names a field of that format: a field Claude Code renames or drops is fixed here, and the
 * recorded session's lines (src/testing/recorded/claude-code) show when it did.
 */

/**
 * The text every line of a kind holds, tested before the line is parsed: Claude Code writes each line as compact
 * JSON, so an entry's own `type` reads `"type":"user"`, while a copy quoted inside another line is escaped. A turn's
 * end has three marks, so its words are the type they share, and a title has two types, so its words are the end
 * they share. `other` has none: any line can be one.
 */
const KIND_WORDS = {
  input: '"type":"user"',
  reply: '"type":"assistant"',
  compact: '"compact_boundary"',
  'turn-end': '"type":"system"',
  continued: '"type":"continued-in"',
  'hook-note': '"hook_additional_context"',
  'scheduled-carry': '"session_cron_carry"',
  environment: '"type":"environment"',
  'queued-prompt': '"type":"queue-operation"',
  'model-switch': '"fallbackModel"',
  title: '-title"',
  other: undefined,
} as const satisfies Readonly<Record<EntryKind, string | undefined>>;

/**
 * The `system` lines Claude Code writes once nothing more is coming: `stop_hook_summary` and `turn_duration` after
 * the model stopped, `local_command` after a slash command that started no turn.
 */
const TURN_END_MARKS: ReadonlySet<string> = new Set(['stop_hook_summary', 'turn_duration', 'local_command']);

/** The model name of a reply Claude Code wrote itself, such as the text of a failed API call. */
const SYNTHETIC_MODEL = '<synthetic>';

/**
 * Claude Code's names for where an input came from. `origin.kind` writes a notification as `task-notification` and
 * `turnOrigin` as `task_notification`; both spellings are read in both fields.
 */
const ORIGIN_NAMES: ReadonlyMap<string, InputOrigin> = new Map<string, InputOrigin>([
  ['human', 'person'],
  ['peer', 'peer'],
  ['task-notification', 'notification'],
  ['task_notification', 'notification'],
  ['scheduled', 'scheduled'],
]);

const DAMAGED: UnreadLine = { kind: 'unread', reason: 'damaged' };
const NOT_AN_OBJECT: UnreadLine = { kind: 'unread', reason: 'not-an-object' };

type Base = Pick<TranscriptEntry, 'at' | 'id' | 'parent' | 'session' | 'thread' | 'meta' | 'job'>;

function threadOf(entry: JsonRecord): Base['thread'] {
  const sidechain = entry['isSidechain'];
  if (sidechain === true) {
    return 'helper';
  }
  return sidechain === false ? 'main' : undefined;
}

/**
 * Claude Code stamps each line of a turn with its `entrypoint`, and a background job's (a daemon job, a session sent
 * to the background) with `sessionKind: "bg"` too; a line with no `entrypoint` says nothing of where it ran.
 */
function jobOf(entry: JsonRecord): Base['job'] {
  return stringField(entry, 'entrypoint') === undefined ? undefined : stringField(entry, 'sessionKind') === 'bg';
}

function baseOf(entry: JsonRecord): Base {
  return {
    at: instantField(entry, 'timestamp'),
    id: stringField(entry, 'uuid'),
    parent: stringField(entry, 'parentUuid'),
    session: stringField(entry, 'sessionId'),
    thread: threadOf(entry),
    meta: entry['isMeta'] === true,
    job: jobOf(entry),
  };
}

function blocksOf(message: JsonRecord): readonly JsonRecord[] {
  const content = message['content'];
  return Array.isArray(content) ? content.filter(isRecord) : [];
}

/** The texts of a content's `text` blocks, in order. */
function textsOf(blocks: readonly JsonRecord[]): readonly string[] {
  return blocks.flatMap((block) => (block['type'] === 'text' ? (stringField(block, 'text') ?? []) : []));
}

function originNamed(name: string | undefined): InputOrigin {
  return (name === undefined ? undefined : ORIGIN_NAMES.get(name)) ?? 'unknown';
}

/** The entry's `origin` mark; a peer's message that hands a helper's work back is a `handback`. */
function originOf(entry: JsonRecord): InputOrigin | undefined {
  const origin = entry['origin'];
  if (origin === undefined) {
    return undefined;
  }
  if (!isRecord(origin)) {
    return 'unknown';
  }
  const named = originNamed(stringField(origin, 'kind'));
  return named === 'peer' && origin['handback'] === true ? 'handback' : named;
}

function turnOriginOf(entry: JsonRecord): InputOrigin | undefined {
  const name = stringField(entry, 'turnOrigin');
  return name === undefined ? undefined : originNamed(name);
}

/** A tool result's text: the string itself, or its parts' texts joined by newlines. */
function resultText(block: JsonRecord): string {
  const content = block['content'];
  if (typeof content === 'string') {
    return content;
  }
  return Array.isArray(content)
    ? content
        .filter(isRecord)
        .map((part) => stringField(part, 'text') ?? '')
        .join('\n')
    : '';
}

/**
 * The line's tool results. Claude Code keeps a tool's structured answer once per line, as `toolUseResult`, and
 * writes one result per line, so each result of the line carries it as its `data`.
 */
function outcomesOf(blocks: readonly JsonRecord[], data: JsonRecord | undefined): readonly ToolOutcome[] {
  return blocks.flatMap((block) =>
    block['type'] === 'tool_result' ? [{ call: stringField(block, 'tool_use_id'), isError: block['is_error'] === true, text: resultText(block), data }] : [],
  );
}

/** What a `toolUseResult` says it started: a background shell names `backgroundTaskId`, a helper `async_launched`, a task tool `taskId`. */
function startedOf(result: JsonRecord): BackgroundMark['started'] {
  if (typeof result['backgroundTaskId'] === 'string') {
    return 'command';
  }
  if (result['status'] === 'async_launched') {
    return 'helper';
  }
  return typeof result['taskId'] === 'string' ? 'task' : undefined;
}

/** The background work a tool's `toolUseResult` names; undefined when it names none, or is plain text. */
function backgroundOf(result: unknown): BackgroundMark | undefined {
  if (!isRecord(result)) {
    return undefined;
  }
  const mark: BackgroundMark = {
    started: startedOf(result),
    task: stringField(result, 'backgroundTaskId') ?? stringField(result, 'agentId') ?? stringField(result, 'taskId'),
    stopped: stringField(result, 'task_id'),
  };
  return mark.started === undefined && mark.task === undefined && mark.stopped === undefined ? undefined : mark;
}

function inputOf(base: Base, entry: JsonRecord, message: JsonRecord): InputEntry {
  const content = message['content'];
  const blocks = blocksOf(message);
  const result = entry['toolUseResult'];
  return {
    ...base,
    kind: 'input',
    text: typeof content === 'string' ? content : undefined,
    parts: textsOf(blocks),
    results: outcomesOf(blocks, isRecord(result) ? result : undefined),
    origin: originOf(entry),
    turnOrigin: turnOriginOf(entry),
    continuation: entry['isCompactSummary'] === true,
    fromTool: result !== undefined,
    background: backgroundOf(result),
  };
}

/** A count that may be missing (0) but, when present, must be a whole number of tokens. */
function countOf(record: JsonRecord, key: string): number | undefined {
  const value = record[key] ?? 0;
  return isNonNegativeInteger(value) ? value : undefined;
}

/**
 * A message's `usage` as counts: undefined when it has none, `unreadable` when it is no object or any count is
 * damaged (negative, a fraction, not a number). A missing count is 0. The cache-write split by lifetime is taken
 * from `cache_creation` when it is there; whatever it leaves out of the total is unsplit.
 */
function usageOf(message: JsonRecord): CallUsage | 'unreadable' | undefined {
  const usage = message['usage'];
  if (usage === undefined) {
    return undefined;
  }
  if (!isRecord(usage)) {
    return 'unreadable';
  }
  const split = recordField(usage, 'cache_creation') ?? {};
  const input = countOf(usage, 'input_tokens');
  const cacheWrite = countOf(usage, 'cache_creation_input_tokens');
  const cacheRead = countOf(usage, 'cache_read_input_tokens');
  const output = countOf(usage, 'output_tokens');
  const cacheWrite5m = countOf(split, 'ephemeral_5m_input_tokens');
  const cacheWrite1h = countOf(split, 'ephemeral_1h_input_tokens');
  if (input === undefined || cacheWrite === undefined || cacheRead === undefined || output === undefined || cacheWrite5m === undefined || cacheWrite1h === undefined) {
    return 'unreadable';
  }
  return { input, cacheWrite5m, cacheWrite1h, cacheWriteUnsplit: Math.max(0, cacheWrite - cacheWrite5m - cacheWrite1h), cacheRead, output };
}

function callsOf(blocks: readonly JsonRecord[]): readonly ReplyCall[] {
  return blocks.flatMap((block) => {
    const id = block['type'] === 'tool_use' ? stringField(block, 'id') : undefined;
    const name = stringField(block, 'name');
    return id === undefined || name === undefined ? [] : [{ id, name, input: recordField(block, 'input') }];
  });
}

function replyOf(base: Base, entry: JsonRecord, message: JsonRecord): ReplyEntry {
  const id = stringField(message, 'id');
  const model = stringField(message, 'model');
  const blocks = blocksOf(message);
  return {
    ...base,
    kind: 'reply',
    // Several lines of one API call share its message id and request id.
    key: id === undefined ? undefined : `${id}|${stringField(entry, 'requestId') ?? ''}`,
    model,
    effort: stringField(entry, 'effort'),
    usage: usageOf(message),
    texts: textsOf(blocks),
    calls: callsOf(blocks),
    synthetic: model === SYNTHETIC_MODEL,
    failed: entry['isApiErrorMessage'] === true,
    error: stringField(entry, 'error'),
  };
}

/** A hook's added context, which Claude Code writes as a `hook_additional_context` attachment. */
function hookNoteOf(base: Base, attachment: JsonRecord): HookNoteEntry {
  const content = attachment['content'];
  const texts = Array.isArray(content) ? content.filter((part): part is string => typeof part === 'string') : [];
  return { ...base, kind: 'hook-note', atStart: attachment['hookEvent'] === 'SessionStart', texts };
}

/** One job of a snapshot's list; undefined for one without its id, schedule, prompt or time. Only `recurring: false` runs once. */
function scheduledJobOf(task: JsonRecord): ScheduledJob | undefined {
  const id = stringField(task, 'id');
  const cron = stringField(task, 'cron');
  const prompt = stringField(task, 'prompt');
  const createdAt = task['createdAt'];
  if (id === undefined || cron === undefined || prompt === undefined || typeof createdAt !== 'number') {
    return undefined;
  }
  return { id, cron, prompt, recurring: task['recurring'] !== false, createdAt };
}

function scheduledJobsOf(tasks: unknown): readonly ScheduledJob[] {
  return Array.isArray(tasks) ? tasks.filter(isRecord).flatMap((task) => scheduledJobOf(task) ?? []) : [];
}

/**
 * The jobs live in the process when Claude Code compacted, which it writes as a `session_cron_carry` attachment: the
 * session's own (`tasks`) and those an earlier session in the process armed (`otherArmed`, Claude Code 2.1.310).
 */
function scheduledCarryOf(base: Base, attachment: JsonRecord): ScheduledCarryEntry {
  return { ...base, kind: 'scheduled-carry', jobs: [...scheduledJobsOf(attachment['tasks']), ...scheduledJobsOf(attachment['otherArmed'])] };
}

/** What Claude Code told the session of its machine, an `environment` attachment: its `snapshot` names the scratchpad folder. */
function environmentOf(base: Base, attachment: JsonRecord): EnvironmentEntry {
  const snapshot = recordField(attachment, 'snapshot');
  return { ...base, kind: 'environment', scratchpad: snapshot === undefined ? undefined : stringField(snapshot, 'scratchpadDirectory') };
}

/**
 * An `attachment` line teamrig has a kind for: a hook's added context, the scheduled jobs live at a compaction, or
 * what the session was told of its machine; undefined for any other.
 */
function attachmentOf(base: Base, entry: JsonRecord): TranscriptEntry | undefined {
  const attachment = recordField(entry, 'attachment');
  switch (attachment?.['type']) {
    case 'hook_additional_context':
      return hookNoteOf(base, attachment);
    case 'session_cron_carry':
      return scheduledCarryOf(base, attachment);
    case 'environment':
      return environmentOf(base, attachment);
    default:
      return undefined;
  }
}

/**
 * A model switch Claude Code made on its own: a `system` line naming the `fallbackModel` it answers on from then,
 * with the `originalModel` and the `apiRefusalCategory` of the safeguard that stopped the reply (2.1.300 writes it
 * with subtype `model_refusal_fallback`); undefined for a line naming no fallback model.
 */
function modelSwitchOf(base: Base, entry: JsonRecord): ModelSwitchEntry | undefined {
  const to = stringField(entry, 'fallbackModel');
  return to === undefined ? undefined : { ...base, kind: 'model-switch', from: stringField(entry, 'originalModel'), to, reason: stringField(entry, 'apiRefusalCategory') };
}

/** A `system` line teamrig has a kind for: a compaction boundary, a turn's end, or a model switch; undefined for any other. */
function systemOf(base: Base, entry: JsonRecord): TranscriptEntry | undefined {
  const subtype = stringField(entry, 'subtype');
  if (subtype === 'compact_boundary') {
    return { ...base, kind: 'compact' };
  }
  return subtype !== undefined && TURN_END_MARKS.has(subtype) ? { ...base, kind: 'turn-end' } : modelSwitchOf(base, entry);
}

/**
 * A prompt Claude Code put in the session's queue, which it writes as a `queue-operation` line of the `enqueue`
 * operation; undefined for the queue's other operations, which take a prompt out.
 */
function queuedPromptOf(base: Base, entry: JsonRecord): QueuedPromptEntry | undefined {
  return entry['operation'] === 'enqueue' ? { ...base, kind: 'queued-prompt', text: stringField(entry, 'content') } : undefined;
}

/**
 * The session's title: a `custom-title` line holds in `customTitle` the name the person gave it (`--name`,
 * `/rename`), an `ai-title` line in `aiTitle` the one Claude Code made up from the conversation; undefined for a
 * line whose title is no text.
 */
function titleOf(base: Base, entry: JsonRecord, by: TitleEntry['by']): TitleEntry | undefined {
  const text = stringField(entry, by === 'person' ? 'customTitle' : 'aiTitle');
  return text === undefined ? undefined : { ...base, kind: 'title', by, text };
}

/** A line that carries no message, as the kind its type and marks make it; undefined for a line of no known kind. */
function markedOf(base: Base, entry: JsonRecord, type: string | undefined): TranscriptEntry | undefined {
  if (type === 'custom-title' || type === 'ai-title') {
    return titleOf(base, entry, type === 'custom-title' ? 'person' : 'host');
  }
  if (type === 'system') {
    return systemOf(base, entry);
  }
  if (type === 'queue-operation') {
    return queuedPromptOf(base, entry);
  }
  if (type === 'continued-in') {
    return { ...base, kind: 'continued', into: stringField(entry, 'continuedInSessionId') };
  }
  return type === 'attachment' ? attachmentOf(base, entry) : undefined;
}

function entryOf(entry: JsonRecord): TranscriptEntry {
  const base = baseOf(entry);
  const type = stringField(entry, 'type');
  const message = recordField(entry, 'message');
  if (type === 'user' && message !== undefined) {
    return inputOf(base, entry, message);
  }
  if (type === 'assistant' && message !== undefined) {
    return replyOf(base, entry, message);
  }
  return markedOf(base, entry, type) ?? { ...base, kind: 'other', type };
}

function entryOfLine(line: string): TranscriptEntry | UnreadLine {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return DAMAGED;
  }
  return isRecord(value) ? entryOf(value) : NOT_AN_OBJECT;
}

function canBe(line: string, only: readonly EntryKind[]): boolean {
  return only.some((kind) => {
    const words = KIND_WORDS[kind];
    return words === undefined || line.includes(words);
  });
}

const NOT_BLANK = /\S/;

/** Claude Code's transcript lines as teamrig's entries. */
export const transcriptReader: TranscriptReader = {
  entry(line, only) {
    if ((only !== undefined && !canBe(line, only)) || !NOT_BLANK.test(line)) {
      return undefined;
    }
    const found = entryOfLine(line);
    return found.kind === 'unread' || only === undefined || only.includes(found.kind) ? found : undefined;
  },
};
