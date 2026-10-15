import { callOf } from '../budget/line.ts';
import { contextTokens } from '../budget/weights.ts';
import type { Files } from '../core/files.ts';
import type { JsonRecord } from '../core/guards.ts';
import { parseObject } from '../core/jsonl.ts';
import { TRANSCRIPT_TAIL_BYTES } from '../names/title.ts';

/**
 * The context of one transcript entry: a main-thread assistant reply's input, cache-creation and
 * cache-read tokens. Undefined for any other entry, a sidechain (subagent) reply, damaged usage, and
 * a reply that read nothing, such as one Claude Code made up itself. The usage parsing is the
 * meter's (`callOf`), so both read a reply the same way.
 */
function contextOf(entry: JsonRecord): number | undefined {
  const call = callOf(entry);
  const total = call === undefined || !call.mainThread ? 0 : contextTokens(call.usage);
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
