import type { EntryKind, InputEntry, ReplyEntry, TranscriptReader } from '../ports/host/index.ts';

/** Enough of the transcript to hold a busy turn's replies between its tool results. */
export const REPLY_TAIL_BYTES = 1024 * 1024;

/** A turn's reply as the person saw it in the tab. */
export interface Reply {
  /** The text blocks of the model's entries, in order, a blank line apart. */
  readonly text: string;
  /** The id of the last model entry read: the next reply of the same turn starts after it. */
  readonly upTo: string;
  /** The turn began before the tail read, so its first replies are missing. */
  readonly cut: boolean;
}

/** The entries a turn's reply is read from. */
const KINDS: readonly EntryKind[] = ['input', 'reply'];

/**
 * Whether an input starts a turn: a prompt, a notification or a slash command's output. A tool's results are
 * an input too, inside the turn, and so is a meta entry the host adds as context.
 */
function startsTurn(entry: InputEntry): boolean {
  return !entry.meta && entry.results.length === 0;
}

/**
 * The reply of the transcript's last turn: the text the model wrote after the turn's start, or after
 * `after` (the last entry an earlier reply of the same turn took, as at a stop a hook sent back) when that
 * comes later. `whole` says the tail is the whole transcript, so a turn start missing from it is no cut.
 * Undefined when the model wrote no text since.
 */
export function replyOf(reader: TranscriptReader, tail: string, after: string | undefined, whole: boolean): Reply | undefined {
  const entries = tail.split('\n').flatMap((line): (InputEntry | ReplyEntry)[] => {
    const entry = reader.entry(line, KINDS);
    return entry?.kind === 'input' || entry?.kind === 'reply' ? [entry] : [];
  });
  let start = -1;
  entries.forEach((entry, index) => {
    if ((entry.kind === 'input' && startsTurn(entry)) || (after !== undefined && entry.id === after)) {
      start = index;
    }
  });
  const texts: string[] = [];
  let upTo: string | undefined;
  for (const entry of entries.slice(start + 1)) {
    if (entry.kind !== 'reply') {
      continue;
    }
    texts.push(...entry.texts.filter((text) => text.trim() !== ''));
    upTo = entry.id ?? upTo;
  }
  if (texts.length === 0 || upTo === undefined) {
    return undefined;
  }
  return { text: texts.join('\n\n'), upTo, cut: start === -1 && !whole };
}
