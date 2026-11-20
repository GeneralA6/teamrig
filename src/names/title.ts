import type { Files } from '../core/files.ts';
import type { EntryKind, HookEvent, TitleEntry, TranscriptReader } from '../ports/host/index.ts';

/**
 * How much of a transcript's end is searched for the session's title, and for its context size at a
 * task boundary (`refresh/usage.ts`): many turns' worth, while a long session's transcript is never
 * read whole on every prompt.
 */
export const TRANSCRIPT_TAIL_BYTES = 256 * 1024;

/** Most lines are turns; only a line that can be a title is worth reading. */
const KINDS: readonly EntryKind[] = ['title'];

/** The newest non-blank title `by` gave in transcript lines, trimmed. A torn first line of a tail is skipped. */
function newestTitleOf(reader: TranscriptReader, text: string, by: TitleEntry['by']): string | undefined {
  const lines = text.split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const entry = reader.entry(lines[index] ?? '', KINDS);
    const title = entry?.kind === 'title' && entry.by === by ? entry.text.trim() : '';
    if (title !== '') {
      return title;
    }
  }
  return undefined;
}

/**
 * The newest title the user gave the session (`--name`, `/rename`), from transcript lines: never a
 * title the host made up. A torn first line of a tail is skipped.
 */
export function customTitleOf(reader: TranscriptReader, text: string): string | undefined {
  return newestTitleOf(reader, text, 'person');
}

/**
 * The newest title the host made up for the session from the conversation, from transcript lines. It
 * only describes the conversation, as a tab's topic (tabs/status.ts): it never names the session.
 */
export function aiTitleOf(reader: TranscriptReader, text: string): string | undefined {
  return newestTitleOf(reader, text, 'host');
}

/** What a hook event says of its session's title: the title itself, and the transcript that may hold one. */
export type TitleSource = Pick<HookEvent, 'title' | 'transcript'>;

/**
 * The title of the host session a hook runs for: the one its event carries, else the newest title the
 * user gave near the end of its transcript. Undefined when the user never named it, and with no
 * `reader` (a host that keeps no transcript teamrig can read) when the event carries none.
 */
export async function sessionTitleOf(reader: TranscriptReader | undefined, { title, transcript }: TitleSource, files: Files): Promise<string | undefined> {
  if (title !== undefined) {
    return title;
  }
  const text = reader === undefined || transcript === undefined || transcript === '' ? undefined : await files.readTail(transcript, TRANSCRIPT_TAIL_BYTES);
  return reader === undefined || text === undefined ? undefined : customTitleOf(reader, text);
}
