import { isRecord, recordField, stringField, type JsonRecord } from '../core/guards.ts';
import { parseObject } from '../core/jsonl.ts';
import { BLOCK_START_WORDS, isBlockStartLine } from '../core/work-block.ts';
import { usageOf, type Usage } from './weights.ts';

/** A tool the model called in a reply: its id, its name and, for a shell, the command line. */
export interface ToolUse {
  readonly id: string;
  readonly name: string;
  readonly command: string | undefined;
  /** The file or folder the tool works on (Read, Edit, Write, NotebookEdit, Grep, Glob), when it names one. */
  readonly path?: string;
  /** The skill a `Skill` call loads. */
  readonly skill?: string;
  /** The agent type an `Agent` call runs: its `subagent_type`, else Claude Code's default, `general-purpose`. */
  readonly agent?: string;
  /** The address a `WebFetch` call reads. */
  readonly url?: string;
  /** True for a call run in the background (`run_in_background`), whose end a task notification reports. */
  readonly background?: boolean;
}

/** What came back for one tool call: its text, and whether Claude Code marked it an error. */
export interface ToolResult {
  readonly id: string;
  readonly isError: boolean;
  readonly text: string;
}

/**
 * One API call's transcript line. A reply with several content blocks is written as several lines
 * that share the message id and request id (`key`) and repeat the usage, so a reader joins them.
 */
export interface CallLine {
  readonly kind: 'call';
  /** `message.id|requestId`; undefined for a reply with no message id, which nothing can join or dedupe. */
  readonly key: string | undefined;
  /** Epoch ms of the line; undefined when it has no readable timestamp. */
  readonly at: number | undefined;
  /** False for a subagent's reply (a sidechain) and for a line that does not say. */
  readonly mainThread: boolean;
  readonly usage: Usage;
  readonly tools: readonly ToolUse[];
}

/** A user line that carries tool results. */
export interface ResultsLine {
  readonly kind: 'results';
  readonly at: number | undefined;
  readonly results: readonly ToolResult[];
}

/**
 * What started a turn: the owner, a peer's message, a notification (a finished background task or a
 * helper's handback), a scheduled wake, a subagent's own prompt, or anything else.
 */
export const TURN_TRIGGERS = ['owner', 'peer', 'notification', 'scheduled', 'subagent', 'other'] as const;
export type TurnTrigger = (typeof TURN_TRIGGERS)[number];

/** A user line with no tool result: a prompt, a peer message or a notification, so a new turn starts. */
export interface PromptLine {
  readonly kind: 'prompt';
  readonly at: number | undefined;
  /** What started the turn; `continuation` for the summary that resumes a compacted session. */
  readonly trigger: TurnTrigger | 'continuation';
  /** The slash commands the prompt runs (`<command-name>/x</command-name>`), without the slash; a skill typed as `/name` loads it. */
  readonly commands: readonly string[];
  /** For a task notification, the id of the background tool call it reports on (its `<tool-use-id>`), when it names one. */
  readonly answers?: string;
  /** The task ids the prompt names (`T123`), each once in order; absent when it names none. */
  readonly tasks?: readonly string[];
}

/** Claude Code compacted the session's context here. */
export interface CompactLine {
  readonly kind: 'compact';
  readonly at: number | undefined;
}

/**
 * A SessionStart hook's note that is the session's work-block start (core/work-block.ts, T1529): it holds what
 * `teamrig start` prints first, so the meter takes it as the block's `start`.
 */
export interface StartNoteLine {
  readonly kind: 'start-note';
  readonly at: number | undefined;
}

export type TranscriptLine = CallLine | ResultsLine | PromptLine | CompactLine | StartNoteLine;

function timeOf(entry: JsonRecord): number | undefined {
  const text = stringField(entry, 'timestamp');
  const at = text === undefined ? Number.NaN : Date.parse(text);
  return Number.isNaN(at) ? undefined : at;
}

function blocksOf(message: JsonRecord): readonly JsonRecord[] {
  const content = message['content'];
  return Array.isArray(content) ? content.filter(isRecord) : [];
}

function toolUseOf(block: JsonRecord): ToolUse | undefined {
  const id = stringField(block, 'id');
  const name = stringField(block, 'name');
  if (block['type'] !== 'tool_use' || id === undefined || name === undefined) {
    return undefined;
  }
  return toolUseFrom(id, name, recordField(block, 'input'));
}

/** A tool call from its id, name and input, as a transcript line or a hook payload carries them. */
export function toolUseFrom(id: string, name: string, input: JsonRecord | undefined): ToolUse {
  const path = input === undefined ? undefined : toolPathOf(input);
  const skill = name === SKILL_TOOL && input !== undefined ? stringField(input, 'skill') : undefined;
  const url = name === WEB_FETCH_TOOL && input !== undefined ? stringField(input, 'url') : undefined;
  const agent = name === AGENT_TOOL ? ((input === undefined ? undefined : stringField(input, 'subagent_type')) ?? DEFAULT_AGENT) : undefined;
  return {
    id,
    name,
    command: input === undefined ? undefined : stringField(input, 'command'),
    ...(path === undefined ? {} : { path }),
    ...(skill === undefined ? {} : { skill }),
    ...(agent === undefined ? {} : { agent }),
    ...(url === undefined ? {} : { url }),
    ...(input?.['run_in_background'] === true ? { background: true } : {}),
  };
}

/** The tool that loads a skill: its input's `skill` names it. */
export const SKILL_TOOL = 'Skill';
/** The tool that starts a subagent: its input's `subagent_type` names the agent type. */
export const AGENT_TOOL = 'Agent';
/** The agent type an `Agent` call with no `subagent_type` runs. */
const DEFAULT_AGENT = 'general-purpose';
/** The tool that reads a web page: its input's `url` names it. */
export const WEB_FETCH_TOOL = 'WebFetch';

const COMMAND_NAME = /<command-name>\/?([^<\s]+)<\/command-name>/g;
/** A register task id as a word: `T` and a number with no leading zero. */
const TASK_MENTION = /\bT[1-9]\d*\b/g;

/** The slash commands a prompt's text runs, without the slash, in order. */
export function commandsIn(text: string): string[] {
  return Array.from(text.matchAll(COMMAND_NAME), (match) => match[1] ?? '').filter((name) => name !== '');
}

/** The task ids a prompt's text names, each once, in order. */
export function tasksIn(text: string): string[] {
  return [...new Set(text.match(TASK_MENTION) ?? [])];
}

/** The file or folder a tool's input names: `file_path`, `notebook_path` or a search's `path`. */
export function toolPathOf(input: JsonRecord): string | undefined {
  return stringField(input, 'file_path') ?? stringField(input, 'notebook_path') ?? stringField(input, 'path');
}

/** A tool result's text: the string itself, or its text blocks joined by newlines. */
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

function toolResultOf(block: JsonRecord): ToolResult | undefined {
  const id = stringField(block, 'tool_use_id');
  if (block['type'] !== 'tool_result' || id === undefined) {
    return undefined;
  }
  return { id, isError: block['is_error'] === true, text: resultText(block) };
}

/** An assistant entry as a call; undefined for any other entry and for a reply without readable usage. */
export function callOf(entry: JsonRecord): CallLine | undefined {
  const message = entry['type'] === 'assistant' ? recordField(entry, 'message') : undefined;
  const usage = message === undefined ? undefined : usageOf(message);
  if (message === undefined || usage === undefined) {
    return undefined;
  }
  const id = stringField(message, 'id');
  const tools = blocksOf(message).flatMap((block) => toolUseOf(block) ?? []);
  return {
    kind: 'call',
    key: id === undefined ? undefined : `${id}|${stringField(entry, 'requestId') ?? ''}`,
    at: timeOf(entry),
    mainThread: entry['isSidechain'] === false,
    usage,
    tools,
  };
}

function promptText(message: JsonRecord): string {
  const content = message['content'];
  return typeof content === 'string' ? content : blocksOf(message).map((block) => stringField(block, 'text') ?? '').join('');
}

/**
 * What started the turn a user entry begins, from the `origin` and `turnOrigin` Claude Code writes, else
 * from the text a peer message or a notification starts with.
 */
function triggerOf(entry: JsonRecord, message: JsonRecord): TurnTrigger | 'continuation' {
  if (entry['isCompactSummary'] === true) {
    return 'continuation';
  }
  if (entry['isSidechain'] === true) {
    return 'subagent';
  }
  const origin = recordField(entry, 'origin');
  const kind = origin === undefined ? undefined : stringField(origin, 'kind');
  const turnOrigin = stringField(entry, 'turnOrigin');
  const text = promptText(message);
  if (turnOrigin === 'scheduled') {
    return 'scheduled';
  }
  if (kind === 'peer') {
    return origin?.['handback'] === true ? 'notification' : 'peer';
  }
  if (kind === 'task-notification' || turnOrigin === 'task_notification' || text.includes('<task-notification')) {
    return 'notification';
  }
  if (kind === 'human' || turnOrigin === 'human') {
    return 'owner';
  }
  return turnOrigin === 'peer' || text.startsWith('<cross-session-message') ? 'peer' : 'other';
}

/** A user entry as results or a prompt; undefined for any other entry and for text Claude Code adds itself. */
function userLineOf(entry: JsonRecord): ResultsLine | PromptLine | undefined {
  const message = entry['type'] === 'user' && entry['isMeta'] !== true ? recordField(entry, 'message') : undefined;
  if (message === undefined) {
    return undefined;
  }
  const results = blocksOf(message).flatMap((block) => toolResultOf(block) ?? []);
  const at = timeOf(entry);
  return results.length > 0 ? { kind: 'results', at, results } : promptOf(entry, message, at);
}

const TOOL_USE_ID = /<tool-use-id>([^<\s]+)<\/tool-use-id>/;

/** A prompt line; only a notification's own `<tool-use-id>` names the call it answers, never one a message quotes. */
function promptOf(entry: JsonRecord, message: JsonRecord, at: number | undefined): PromptLine {
  const text = promptText(message);
  const trigger = triggerOf(entry, message);
  const answers = trigger === 'notification' ? TOOL_USE_ID.exec(text)?.[1] : undefined;
  const tasks = tasksIn(text);
  return { kind: 'prompt', at, trigger, commands: commandsIn(text), ...(answers === undefined ? {} : { answers }), ...(tasks.length === 0 ? {} : { tasks }) };
}

/** A compaction's boundary line; undefined for any other entry. */
function compactOf(entry: JsonRecord): CompactLine | undefined {
  return entry['type'] === 'system' && entry['subtype'] === 'compact_boundary' ? { kind: 'compact', at: timeOf(entry) } : undefined;
}

/**
 * A SessionStart hook's note whose text holds a work-block start line (core/work-block.ts); undefined for any other
 * entry, a prompt or a tool result that only quotes one among them.
 */
function startNoteOf(entry: JsonRecord): StartNoteLine | undefined {
  const attachment = entry['type'] === 'attachment' ? recordField(entry, 'attachment') : undefined;
  if (attachment === undefined || attachment['type'] !== 'hook_additional_context' || attachment['hookEvent'] !== 'SessionStart') {
    return undefined;
  }
  const content = attachment['content'];
  const texts = Array.isArray(content) ? content.filter((part): part is string => typeof part === 'string') : [];
  return texts.some((text) => text.split('\n').some(isBlockStartLine)) ? { kind: 'start-note', at: timeOf(entry) } : undefined;
}

/**
 * One transcript line as what the meter counts; undefined for the many lines it ignores (system
 * notes other than a compaction, attachments other than a work-block start note, snapshots) and for a damaged or torn
 * line. A cheap text test runs first, so only a line that can be a reply, a user line or such a note is parsed.
 */
export function parseTranscriptLine(raw: string): TranscriptLine | undefined {
  if (!raw.includes('"usage"') && !raw.includes('"type":"user"') && !raw.includes('"compact_boundary"') && !raw.includes(BLOCK_START_WORDS)) {
    return undefined;
  }
  const entry = parseObject(raw);
  if (entry === undefined) {
    return undefined;
  }
  return callOf(entry) ?? userLineOf(entry) ?? compactOf(entry) ?? startNoteOf(entry);
}
