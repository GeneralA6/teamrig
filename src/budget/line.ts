import { stringField, type JsonRecord } from '../core/guards.ts';
import { BLOCK_START_WORDS, isBlockStartLine } from '../core/work-block.ts';
import type { CallUsage, EntryKind, HookNoteEntry, InputEntry, ReplyEntry, TranscriptReader } from '../ports/host/index.ts';
import { isPushedPrompt, isStopFeedback } from './turn-origin.ts';

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
  readonly usage: CallUsage;
  readonly tools: readonly ToolUse[];
  /** The model that wrote the reply, when the line names it. */
  readonly model?: string;
  /** The reasoning effort the reply ran at, when the line names it. */
  readonly effort?: string;
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
  /** True when the team's own machinery started the turn (`turn-origin.ts`), not a person or a finished task. */
  readonly pushed?: true;
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

const TOOL_USE_ID = /<tool-use-id>([^<\s]+)<\/tool-use-id>/;

/** A reply entry as a call; undefined for a reply without readable usage. */
export function callLineOf(entry: ReplyEntry): CallLine | undefined {
  const { usage, model, effort } = entry;
  if (usage === undefined || usage === 'unreadable') {
    return undefined;
  }
  return {
    kind: 'call',
    key: entry.key,
    at: entry.at,
    mainThread: entry.thread === 'main',
    usage,
    tools: entry.calls.map((call) => toolUseFrom(call.id, call.name, call.input)),
    ...(model === undefined ? {} : { model }),
    ...(effort === undefined ? {} : { effort }),
  };
}

/** An input's text: the plain content, else its text parts joined. */
function inputText(entry: InputEntry): string {
  return entry.text ?? entry.parts.join('');
}

/**
 * What started the turn an input begins, from the two origin marks the host writes, else from the text a peer
 * message or a notification starts with.
 */
function inputTrigger(entry: InputEntry, text: string): TurnTrigger | 'continuation' {
  if (entry.continuation) {
    return 'continuation';
  }
  if (entry.thread === 'helper') {
    return 'subagent';
  }
  const { origin, turnOrigin } = entry;
  if (turnOrigin === 'scheduled') {
    return 'scheduled';
  }
  if (origin === 'handback') {
    return 'notification';
  }
  if (origin === 'peer') {
    return 'peer';
  }
  if (origin === 'notification' || turnOrigin === 'notification' || text.includes('<task-notification')) {
    return 'notification';
  }
  if (origin === 'person' || turnOrigin === 'person') {
    return 'owner';
  }
  return turnOrigin === 'peer' || text.startsWith('<cross-session-message') ? 'peer' : 'other';
}

/** A prompt line; only a notification's own `<tool-use-id>` names the call it answers, never one a message quotes. */
function promptLineOf(entry: InputEntry): PromptLine {
  const text = inputText(entry);
  const trigger = inputTrigger(entry, text);
  const answers = trigger === 'notification' ? TOOL_USE_ID.exec(text)?.[1] : undefined;
  const tasks = tasksIn(text);
  return {
    kind: 'prompt',
    at: entry.at,
    trigger,
    commands: commandsIn(text),
    ...(answers === undefined ? {} : { answers }),
    ...(tasks.length === 0 ? {} : { tasks }),
    ...(isPushedPrompt(text) ? { pushed: true } : {}),
  };
}

/** An input as results or a prompt; undefined for text the host adds itself. A result naming no call is left out. */
function inputLineOf(entry: InputEntry): ResultsLine | PromptLine | undefined {
  if (entry.meta) {
    return undefined;
  }
  const results = entry.results.flatMap((result) => (result.call === undefined ? [] : [{ id: result.call, isError: result.isError, text: result.text }]));
  return results.length > 0 ? { kind: 'results', at: entry.at, results } : promptLineOf(entry);
}

/**
 * A hook's note written as the session started, whose text holds a work-block start line (core/work-block.ts);
 * undefined for any other note.
 */
function startNoteLineOf(entry: HookNoteEntry): StartNoteLine | undefined {
  return entry.atStart && entry.texts.some((text) => text.split('\n').some(isBlockStartLine)) ? { kind: 'start-note', at: entry.at } : undefined;
}

/** The entry kinds the meter counts; a hook's note is asked for only on a line that can hold a work-block start. */
const COUNTED_KINDS = ['reply', 'input', 'compact'] as const satisfies readonly EntryKind[];
const COUNTED_KINDS_AND_NOTES = [...COUNTED_KINDS, 'hook-note'] as const satisfies readonly EntryKind[];

/**
 * One transcript line as what the meter counts; undefined for the many lines it ignores (notes other than a
 * work-block start, a reply without readable usage, text the host adds itself, every other kind) and for a damaged
 * or torn line. The reader is asked for the few kinds counted, so most other lines are never parsed.
 */
export function transcriptLineOf(reader: TranscriptReader, raw: string): TranscriptLine | undefined {
  const entry = reader.entry(raw, raw.includes(BLOCK_START_WORDS) ? COUNTED_KINDS_AND_NOTES : COUNTED_KINDS);
  switch (entry?.kind) {
    case 'reply':
      return callLineOf(entry);
    case 'input':
      return inputLineOf(entry);
    case 'compact':
      return { kind: 'compact', at: entry.at };
    case 'hook-note':
      return startNoteLineOf(entry);
    default:
      return undefined;
  }
}

/**
 * A Stop hook's push, which the host writes as its own text. `transcriptLineOf` skips such lines and must go on
 * skipping them, or the meter's turn counts move: only the rollup, which needs to see the turn start, reads this.
 */
export function stopFeedbackOf(reader: TranscriptReader, raw: string): PromptLine | undefined {
  const entry = reader.entry(raw, ['input']);
  return entry?.kind === 'input' && entry.meta && isStopFeedback(inputText(entry)) ? promptLineOf(entry) : undefined;
}
