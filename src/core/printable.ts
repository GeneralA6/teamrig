/**
 * The characters a terminal may act on or draw out of order: the C0 controls, DEL and the C1 controls (ESC and CSI
 * start escape sequences), and the bidi format marks (ALM, LRM, RLM, the embeddings, overrides and isolates), around
 * which a line is drawn in another order, so it can read as something it does not hold.
 */
const UNPRINTABLE = /[\u0000-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]/gu;

/** The short escapes a reader knows; every other control prints as `\xNN`, a bidi mark as `\uNNNN`. */
const NAMED = new Map<string, string>([
  ['\n', '\\n'],
  ['\r', '\\r'],
  ['\t', '\\t'],
]);

/** Hex digits in a `\xNN` escape, and in a `\uNNNN` one. */
const HEX_WIDTH = 2;
const UNICODE_HEX_WIDTH = 4;

/** The last code point a `\xNN` escape writes. */
const LAST_BYTE = 0xff;

function escapeOf(mark: string): string {
  const named = NAMED.get(mark);
  if (named !== undefined) {
    return named;
  }
  const code = mark.charCodeAt(0);
  return code <= LAST_BYTE ? `\\x${code.toString(16).padStart(HEX_WIDTH, '0')}` : `\\u${code.toString(16).padStart(UNICODE_HEX_WIDTH, '0')}`;
}

/**
 * `text` with every control character and bidi format mark written as an escape (`\n`, `\t`, `\x1b`, `‮`), so
 * text from outside, such as a file name an outside pull request chose, prints on the one line it was given, in the
 * order it was given: it cannot add lines of its own to output a session reads, send escape sequences to the
 * terminal, nor reorder what is drawn around it. Other text is left as it is.
 */
export function printable(text: string): string {
  return text.replace(UNPRINTABLE, escapeOf);
}

/** Text from outside on one plain line: control and format characters (escapes, bidi overrides) become spaces. */
export function plainLine(text: string): string {
  return text.replace(/[\p{Cc}\p{Cf}]+/gu, ' ').replace(/\s+/g, ' ').trim();
}

/** Whether `text` holds a control character or bidi format mark, which `printable` would escape. */
export function hasUnprintable(text: string): boolean {
  return printable(text) !== text;
}
