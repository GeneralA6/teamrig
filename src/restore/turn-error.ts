import type { TranscriptReader } from '../ports/host/index.ts';

/**
 * The API error a failed turn ended on, as the host names it (`authentication_failed`, `server_error`,
 * `overloaded`, ...). A StopFailure payload carries it as `error`; one that does not leaves only the turn's last
 * transcript entry, the failed reply the host writes in the model's place.
 */

/** How much of a transcript's end is read for the error record of a turn that failed: it is the turn's last record. */
export const TURN_TAIL_BYTES = 64 * 1024;

/** The one entry kind the error is read from; every other line is passed over. */
const REPLY_ONLY = ['reply'] as const;

/**
 * The error a failed turn ended on. `error`, the one its hook event names, decides it; only an event that names none
 * reads the transcript's end (`tailOf`, undefined when there is none) through the host's `reader`, and a host that
 * keeps no transcript (`reader` undefined) leaves it unread. Undefined when neither names one.
 */
export async function turnErrorOf(
  reader: TranscriptReader | undefined,
  error: string | undefined,
  tailOf: () => Promise<string | undefined>,
): Promise<string | undefined> {
  if (error !== undefined || reader === undefined) {
    return error;
  }
  const tail = await tailOf();
  return tail === undefined ? undefined : lastReplyErrorOf(reader, tail);
}

/**
 * The error of the last reply of `text` when the host wrote it for a failed call; undefined when it is a model
 * answer (the turn that failed is an older one) or there is none. A torn first line, as a tail cut mid-entry leaves
 * it, is skipped.
 */
function lastReplyErrorOf(reader: TranscriptReader, text: string): string | undefined {
  const lines = text.split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const entry = reader.entry(lines[index] ?? '', REPLY_ONLY);
    if (entry?.kind === 'reply') {
      return entry.failed ? entry.error : undefined;
    }
  }
  return undefined;
}
