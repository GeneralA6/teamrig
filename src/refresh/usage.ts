import type { Files } from '../core/files.ts';
import { isNonNegativeInteger, recordField, type JsonRecord } from '../core/guards.ts';
import { parseObject } from '../core/jsonl.ts';
import { TRANSCRIPT_TAIL_BYTES } from '../names/title.ts';

/** The usage numbers that together are the context the model read for one reply; a missing one counts 0. */
const CONTEXT_FIELDS = ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'] as const;

/**
 * The context of one transcript entry: a main-thread assistant reply's input, cache-creation and
 * cache-read tokens. Undefined for any other entry, a sidechain (subagent) reply, damaged usage, and
 * a reply that read nothing, such as one Claude Code made up itself.
 */
function contextOf(entry: JsonRecord): number | undefined {
  if (entry['type'] !== 'assistant' || entry['isSidechain'] !== false) {
    return undefined;
  }
  const message = recordField(entry, 'message');
  const usage = message === undefined ? undefined : recordField(message, 'usage');
  if (usage === undefined) {
    return undefined;
  }
  let total = 0;
  for (const field of CONTEXT_FIELDS) {
    const value = usage[field] ?? 0;
    if (!isNonNegativeInteger(value)) {
      return undefined;
    }
    total += value;
  }
  return total > 0 ? total : undefined;
}

/**
 * The session's context size from transcript lines: that of the last main-thread reply. A `cut`
 * text, the tail of a longer file, may start mid-line, so its first line is skipped; damaged lines
 * are skipped too. Undefined when no line tells, which never asks for a refresh.
 */
export function contextTokensOf(text: string, cut: boolean): number | undefined {
  const lines = text.split('\n');
  const first = cut ? 1 : 0;
  for (let index = lines.length - 1; index >= first; index -= 1) {
    const line = lines[index] ?? '';
    // Most lines are prompts and tool results; only a line carrying usage numbers is worth parsing.
    const entry = line.includes('"usage"') ? parseObject(line) : undefined;
    const tokens = entry === undefined ? undefined : contextOf(entry);
    if (tokens !== undefined) {
      return tokens;
    }
  }
  return undefined;
}

/**
 * The context size from the transcript's last `TRANSCRIPT_TAIL_BYTES`, never the whole file;
 * undefined when the transcript is missing or no reply there has usage. A tail as long as the
 * limit is taken as cut (a file of exactly that size only loses its first line).
 */
export async function readContextTokens(files: Files, transcript: string): Promise<number | undefined> {
  const text = await files.readTail(transcript, TRANSCRIPT_TAIL_BYTES);
  return text === undefined ? undefined : contextTokensOf(text, Buffer.byteLength(text, 'utf8') >= TRANSCRIPT_TAIL_BYTES);
}
