import type { ConnectorName } from './connector.ts';
import { ServedText, type Cut, type MarkedText, type SecretShapes } from './text.ts';

/**
 * A stored line as `inboxLineOf` (src/inbox/inbox.ts) writes it: `- YYYY-MM-DD HH:MM <from>: <text>`, the minute in
 * UTC. The sender is an id, or `<team>/<id>` from another team of the tree; a line may have none.
 */
const LINE = /^- (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})(?: ([a-z][a-z0-9-]*(?:\/[a-z][a-z0-9-]*)?):)?(?: (.*))?$/;

/** One line of a session's inbox, as the `inbox` document serves it. */
export interface ServedLine {
  /**
   * Stable for a line while the file keeps it, and unlike any other served line's: the line's fingerprint, as the
   * read marks hold it, with `-2`, `-3` and so on for a line the file holds again word for word.
   */
  readonly key: string;
  /** When it was posted, to the minute; null for a line that carries no date. */
  readonly at: string | null;
  /**
   * The sender as the line names it: a session's id, `<team>/<id>` from another team of the tree, a connector's id,
   * or teamrig itself; null when the line names none.
   */
  readonly from: string | null;
  /** The line's words, without its date and sender; a line with no date is served whole. */
  readonly text: MarkedText;
  readonly unread: boolean;
}

/** The `inbox` document's own fields. */
export interface InboxBody {
  readonly session: { readonly id: string; readonly name: string };
  /** How many lines the session has not read; null when it never read its inbox, and then every line counts as unread. */
  readonly unread: number | null;
  readonly lines: readonly ServedLine[];
  readonly cuts: readonly Cut[];
}

/** What the `inbox` document is built from. */
export interface InboxInput {
  readonly session: { readonly id: string; readonly name: string };
  /** The inbox file's lines, in file order. */
  readonly lines: readonly string[];
  /** How many lines at the file's end the session has not read; null when it never read its inbox. */
  readonly unread: number | null;
  /** A read line posted before this moment (milliseconds) is left out, and one with no date too. */
  readonly readSince: number;
  /** A line's fingerprint (`lineHash`, src/inbox/line-hash.ts), handed in since it needs a hash this folder may not import. */
  readonly keyOf: (line: string) => string;
  /** A line a connector's import posted carries an outside author's words. */
  readonly connectors: readonly ConnectorName[];
  readonly shapes: SecretShapes;
}

interface ParsedLine {
  readonly at: string | null;
  readonly from: string | null;
  readonly text: string;
}

/** A line's date, sender and words. A line with no date, or one no calendar holds, is all words. */
function parsedLine(line: string): ParsedLine {
  const [, day, minute, from, text] = LINE.exec(line) ?? [];
  const at = `${day}T${minute}:00.000Z`;
  if (day === undefined || minute === undefined || Number.isNaN(Date.parse(at))) {
    return { at: null, from: null, text: line };
  }
  return { at, from: from ?? null, text: text ?? '' };
}

/**
 * The `inbox` document's body: every unread line, and the read ones posted since `readSince`, in file order. It
 * makes its own `ServedText`, so `cuts` lists this document's cuts and no other's; a line left out is never scanned.
 */
export function inboxBody(input: InboxInput): InboxBody {
  const served = new ServedText(input.shapes);
  const firstUnread = input.unread === null ? 0 : input.lines.length - input.unread;
  const copies = new Map<string, number>();
  const lines: ServedLine[] = [];
  input.lines.forEach((line, index) => {
    // Counted over the whole file, not the served lines, so a key does not change as the window moves.
    const copy = (copies.get(line) ?? 0) + 1;
    copies.set(line, copy);
    const unread = index >= firstUnread;
    const parsed = parsedLine(line);
    if (unread || (parsed.at !== null && Date.parse(parsed.at) >= input.readSince)) {
      const key = copy === 1 ? input.keyOf(line) : `${input.keyOf(line)}-${copy}`;
      const wrote = input.connectors.some((connector) => connector.id === parsed.from) ? 'outside' : 'team';
      lines.push({ key, at: parsed.at, from: parsed.from, text: served.marked(key, 'text', parsed.text, wrote), unread });
    }
  });
  return { session: input.session, unread: input.unread, lines, cuts: served.cuts };
}
