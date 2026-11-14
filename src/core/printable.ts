/** The C0 controls, DEL and the C1 controls: a terminal may act on any of them (ESC and CSI start escape sequences). */
const CONTROLS = /[\u0000-\u001f\u007f-\u009f]/g;

/** The short escapes a reader knows; every other control prints as `\xNN`. */
const NAMED = new Map<string, string>([
  ['\n', '\\n'],
  ['\r', '\\r'],
  ['\t', '\\t'],
]);

/** Hex digits in a `\xNN` escape. */
const HEX_WIDTH = 2;

/**
 * `text` with every control character written as an escape (`\n`, `\t`, `\x1b`), so text from outside, such as a file
 * name an outside pull request chose, prints on the one line it was given: it cannot add lines of its own to output a
 * session reads, nor send escape sequences to the terminal. Other text is left as it is.
 */
export function printable(text: string): string {
  return text.replace(CONTROLS, (control) => NAMED.get(control) ?? `\\x${control.charCodeAt(0).toString(16).padStart(HEX_WIDTH, '0')}`);
}
