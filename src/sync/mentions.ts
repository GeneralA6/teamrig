import type { OurLogins } from './trust.ts';

/**
 * Which of our users a GitHub comment or body names with an `@`, kept pure. A mention counts only where GitHub
 * itself would notify for it: not inside a code fence, inline code or a `>` quote (so quoting an old mention never
 * routes it again), and not inside an e-mail address, a path or a longer login.
 */

/** The longest excerpt around a mention a session is shown: comment text is outside input, so it stays short. */
export const MENTION_EXCERPT_MAX = 300;

/** How much of the excerpt comes before the mention, so the line shows what led to it. */
const EXCERPT_BEFORE = 100;

/** One of our users a text mentions: the login lowercased, and the text around its first mention. */
export interface Mention {
  readonly login: string;
  readonly excerpt: string;
}

/**
 * An `@login` where the `@` starts the text or follows a character that is not a letter, digit, `-`, `_`, `.` or `/`
 * (so an address such as `name@login` and `path/@login` are none), the login ending at a character that is not a letter, digit or
 * `-` (so `@login-bot` is that longer login). GitHub logins are at most 39 characters.
 */
const MENTION = /(?<![A-Za-z0-9\-_./])@([A-Za-z0-9][A-Za-z0-9-]{0,38})(?![A-Za-z0-9-])/g;

/** A fence line: up to 3 spaces, then 3 or more backticks or tildes (CommonMark). */
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/** A quoted line: up to 3 spaces, then `>`. */
const QUOTE = /^ {0,3}>/;

/** The text with every fenced block, quoted line and inline code span blanked to spaces, each position kept. */
export function visibleText(text: string): string {
  const lines = text.split('\n');
  let fence: string | undefined;
  const kept = lines.map((line) => {
    const open = FENCE.exec(line)?.[1];
    if (fence !== undefined) {
      // A fence closes on a line of the same character, at least as long, and nothing else after it.
      if (open !== undefined && open[0] === fence[0] && open.length >= fence.length && line.trim() === open) {
        fence = undefined;
      }
      return blank(line);
    }
    if (open !== undefined) {
      fence = open;
      return blank(line);
    }
    return QUOTE.test(line) ? blank(line) : line;
  });
  return withoutInlineCode(kept.join('\n'));
}

/**
 * Inline code blanked: a run of n backticks opens a span that the next run of exactly n closes; a run with no closer
 * is plain text (CommonMark).
 */
function withoutInlineCode(text: string): string {
  let out = '';
  let at = 0;
  while (at < text.length) {
    const open = text.indexOf('`', at);
    if (open < 0) {
      break;
    }
    const length = runLength(text, open);
    const close = closingRun(text, open + length, length);
    if (close < 0) {
      out += text.slice(at, open + length);
      at = open + length;
      continue;
    }
    out += text.slice(at, open) + blank(text.slice(open, close + length));
    at = close + length;
  }
  return out + text.slice(at);
}

function runLength(text: string, from: number): number {
  let end = from;
  while (text[end] === '`') {
    end += 1;
  }
  return end - from;
}

/** Where the next run of exactly `length` backticks from `from` starts; -1 when none. */
function closingRun(text: string, from: number, length: number): number {
  let at = text.indexOf('`', from);
  while (at >= 0) {
    const run = runLength(text, at);
    if (run === length) {
      return at;
    }
    at = text.indexOf('`', at + run);
  }
  return -1;
}

/** Spaces in place of every character but a line break, so positions and lines stay where they were. */
function blank(text: string): string {
  return text.replace(/[^\n]/g, ' ');
}

/**
 * The logins of ours a text mentions where GitHub would notify, each once, in the order of its first mention, with the
 * text around that first mention. A text of any length is scanned whole; only the excerpt is capped.
 */
export function mentionsOf(text: string, ours: OurLogins): Mention[] {
  const visible = visibleText(text);
  const found = new Map<string, Mention>();
  for (const match of visible.matchAll(MENTION)) {
    const login = (match[1] ?? '').toLowerCase();
    if (ours.has(login) && !found.has(login)) {
      found.set(login, { login, excerpt: excerptAt(text, match.index) });
    }
  }
  return [...found.values()];
}

/** At most MENTION_EXCERPT_MAX characters of the text around `index`, on one line, `…` where it was cut. */
export function excerptAt(text: string, index: number): string {
  // Two characters are kept for the cut marks, so the excerpt with them stays within the cap.
  const room = MENTION_EXCERPT_MAX - 2;
  const start = Math.max(0, Math.min(index - EXCERPT_BEFORE, text.length - room));
  const end = Math.min(text.length, start + room);
  // Outside text: control and format characters go with the line breaks, and half of a cut character goes too.
  const body = text
    .slice(start, end)
    .replace(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/g, '')
    .replace(/[\s\p{Cc}\p{Cf}]+/gu, ' ')
    .trim();
  return `${start > 0 ? '…' : ''}${body}${end < text.length ? '…' : ''}`;
}
