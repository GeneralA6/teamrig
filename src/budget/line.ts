import { isRecord, recordField, stringField, type JsonRecord } from '../core/guards.ts';
import { parseObject } from '../core/jsonl.ts';
import { usageOf, type Usage } from './weights.ts';

/** A tool the model called in a reply: its id, its name and, for a shell, the command line. */
export interface ToolUse {
  readonly id: string;
  readonly name: string;
  readonly command: string | undefined;
  /** The file or folder the tool works on (Read, Edit, Write, NotebookEdit, Grep, Glob), when it names one. */
  readonly path?: string;
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

/** A user line with no tool result: a prompt, a peer message or a notification, so a new turn starts. */
export interface PromptLine {
  readonly kind: 'prompt';
  readonly at: number | undefined;
}

export type TranscriptLine = CallLine | ResultsLine | PromptLine;

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
  return { id, name, command: input === undefined ? undefined : stringField(input, 'command'), ...(path === undefined ? {} : { path }) };
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

/** A user entry as results or a prompt; undefined for any other entry and for text Claude Code adds itself. */
function userLineOf(entry: JsonRecord): ResultsLine | PromptLine | undefined {
  const message = entry['type'] === 'user' && entry['isMeta'] !== true ? recordField(entry, 'message') : undefined;
  if (message === undefined) {
    return undefined;
  }
  const results = blocksOf(message).flatMap((block) => toolResultOf(block) ?? []);
  const at = timeOf(entry);
  return results.length > 0 ? { kind: 'results', at, results } : { kind: 'prompt', at };
}

/**
 * One transcript line as what the meter counts; undefined for the many lines it ignores (system
 * notes, attachments, snapshots) and for a damaged or torn line. A cheap text test runs first, so
 * only a line that can be a reply or a user line is parsed.
 */
export function parseTranscriptLine(raw: string): TranscriptLine | undefined {
  if (!raw.includes('"usage"') && !raw.includes('"type":"user"')) {
    return undefined;
  }
  const entry = parseObject(raw);
  if (entry === undefined) {
    return undefined;
  }
  return callOf(entry) ?? userLineOf(entry);
}
