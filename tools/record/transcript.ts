import { isRecord, stringField } from '../lib/guards.ts';
import type { Scrubber } from './scrub.ts';

/**
 * The line types whose text is the recorded session's own: its prompts, its replies, its tool calls and their results.
 * Every other line is Claude Code's bookkeeping, and some of it copies what belongs to the account that recorded: the
 * system prompt, the instructions it loaded, the tool, skill and helper descriptions.
 */
const SESSION_TEXT: ReadonlySet<string> = new Set(['user', 'assistant', 'system', 'queue-operation', 'last-prompt']);
/** The longest string a bookkeeping line keeps: room for a name, a type, an id or a path, not for prose. */
export const MAX_BOOKKEEPING_STRING = 120;

/** What stands for a bookkeeping string of `length` characters that was cut. */
export function cutStandIn(length: number): string {
  return `[recorded: ${length} characters]`;
}

/** A transcript in its fixture form. */
export interface FixtureTranscript {
  readonly text: string;
  /** How many long bookkeeping strings were replaced by a stand-in. */
  readonly cut: number;
}

/**
 * A transcript as a fixture keeps it: each line scrubbed, and in a bookkeeping line every string longer than
 * `MAX_BOOKKEEPING_STRING` replaced by a stand-in that says how long it was. The line's keys, types and short values
 * stay, so a reader meets every line a real transcript has, in its real structure. A line that is no JSON object is an
 * error, as a reader would drop it.
 */
export function fixtureTranscript(name: string, text: string, scrubber: Scrubber): FixtureTranscript {
  let cut = 0;
  const shortened = (value: unknown): unknown => {
    if (typeof value === 'string') {
      if (value.length <= MAX_BOOKKEEPING_STRING) {
        return value;
      }
      cut += 1;
      return cutStandIn(value.length);
    }
    if (Array.isArray(value)) {
      return value.map(shortened);
    }
    return isRecord(value) ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, shortened(item)])) : value;
  };
  const lines = text
    .split('\n')
    .filter((line) => line !== '')
    .map((line, index) => {
      const entry: unknown = JSON.parse(line);
      if (!isRecord(entry)) {
        throw new Error(`${name} line ${index + 1} is not a JSON object`);
      }
      const scrubbed = scrubber.value(entry);
      return `${JSON.stringify(SESSION_TEXT.has(stringField(entry, 'type') ?? '') ? scrubbed : shortened(scrubbed))}\n`;
    });
  return { text: lines.join(''), cut };
}
