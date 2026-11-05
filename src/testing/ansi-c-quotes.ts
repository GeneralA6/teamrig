/**
 * `$'...'` strings for the guards' specs, each one run through real bash 5.2 (T1994). A guard must judge the word bash
 * gives the program, not the text the line shows, so every guard is tried with the same spellings.
 */

/** Strings that add nothing to their word: a NUL ends the value of all but the last, which bash writes as no bytes. */
export const NOTHING_QUOTES: readonly string[] = [
  "$'\\0'",
  "$'\\000'",
  "$'\\x00'",
  "$'\\u0000'",
  "$'\\c@'",
  "$'\\400'",
  "$'\\x{}'",
  "$'\\x{g}'",
  "$'\\x{0}'",
  "$'\\x{100}'",
  "$'\\x{'",
  "$'\\u0'",
  "$'\\U0'",
  "$'\\c '",
  "$'\\c`'",
  "$'\\c\u0800'",
  "$'\\0junk'",
  "$'\\U80000000'",
];

/** Strings whose value is one dash, in spellings only bash's own decoder reads: an octal past a byte, a long hex, a long Unicode. */
export const DASH_QUOTES: readonly string[] = ["$'\\455'", "$'\\x{2d}'", "$'\\x{12d}'", "$'\\U0000002d'", "$'\\U2d'"];
