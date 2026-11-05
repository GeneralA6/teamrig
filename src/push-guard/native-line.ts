import type { ShellWord } from './tokenizer.ts';

/**
 * How a Windows C runtime reads a doubled quote inside quotes, the one place the two measured on a real line differ
 * (T2003, 1,117 of 6,789 lines): `ucrt` gives one quote and stays in the quotes, as node does; `msvcrt` gives one and
 * leaves them, as git does. A guard cannot know which runtime a program links, and git is the one it watches most.
 */
export type CRuntime = 'ucrt' | 'msvcrt';

/** A piece of a command line that is not plain characters: a value only known when the line runs, kept as written. */
export interface LinePiece {
  readonly text: string;
}

/** One unit of a command line: a character, or a piece no quote or blank inside it can touch. */
export type LineUnit = string | LinePiece;

const QUOTE = '"';
const BACKSLASH = '\\';

/** .NET's `char.IsWhiteSpace`, which decides the binder's quotes; U+180E, U+200B and U+FEFF measured as no blank. */
const BINDER_WHITE_SPACE = /[\t-\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/;

/** What separates a C runtime's arguments outside quotes; every other blank stays in its word. */
const RUNTIME_BLANK = /^[ \t]$/;

/**
 * A value as Windows PowerShell 5.1 writes it into the line, measured on 11,724 rows: it adds quotes only when a white
 * space sits at an even count of double quotes, every one counted, a backslashed one too, and escapes nothing. So
 * `a"b` goes in bare, and `a b\` ends in `\"`, which the runtime reads as a quote, not the end of the value.
 */
function bound(value: string): string {
  let quotes = 0;
  let needed = false;
  for (const unit of value) {
    if (unit === QUOTE) {
      quotes += 1;
    } else if (quotes % 2 === 0 && BINDER_WHITE_SPACE.test(unit)) {
      needed = true;
    }
  }
  return needed ? `${QUOTE}${value}${QUOTE}` : value;
}

/**
 * One argument's units. An array literal with no blank in it is one argument: its elements are quoted one by one and
 * joined by a comma, and an empty one adds nothing, the comma included. A value of one empty element adds nothing at
 * all, so the program never sees it.
 */
function boundArgument(elements: readonly ShellWord[]): LineUnit[] {
  const units: LineUnit[] = [];
  for (const element of elements) {
    const value: readonly LineUnit[] = element.dynamic ? [{ text: element.text }] : [...bound(element.text)];
    if (value.length > 0) {
      units.push(...(units.length > 0 ? [','] : []), ...value);
    }
  }
  return units;
}

/** How many backslashes run from `start`. */
function backslashRun(line: readonly LineUnit[], start: number): number {
  let end = start;
  while (line[end] === BACKSLASH) {
    end += 1;
  }
  return end - start;
}

/**
 * Splits a command line as a C runtime does, each word as its units, measured on 6,789 lines. Backslashes are plain
 * until a quote follows: then each pair gives one, and an odd one left makes that quote plain. A quote otherwise opens
 * or closes the quotes; {@link CRuntime} says what a doubled one does inside them. Only a space or a tab separates.
 */
export function splitLine(line: readonly LineUnit[], runtime: CRuntime): LineUnit[][] {
  const words: LineUnit[][] = [];
  const blankAt = (at: number): boolean => {
    const unit = line[at];
    return typeof unit === 'string' && RUNTIME_BLANK.test(unit);
  };
  let at = 0;
  for (;;) {
    while (blankAt(at)) {
      at += 1;
    }
    if (at >= line.length) {
      return words;
    }
    const word: LineUnit[] = [];
    let quoted = false;
    while (at < line.length && (quoted || !blankAt(at))) {
      const unit = line[at];
      if (unit === BACKSLASH) {
        const run = backslashRun(line, at);
        at += run;
        const beforeQuote = line[at] === QUOTE;
        word.push(...BACKSLASH.repeat(beforeQuote ? Math.floor(run / 2) : run));
        if (beforeQuote && run % 2 === 1) {
          word.push(QUOTE);
          at += 1;
        }
      } else if (unit === QUOTE && quoted && line[at + 1] === QUOTE) {
        word.push(QUOTE);
        at += 2;
        quoted = runtime === 'ucrt';
      } else if (unit === QUOTE) {
        quoted = !quoted;
        at += 1;
      } else if (unit !== undefined) {
        word.push(unit);
        at += 1;
      }
    }
    words.push(word);
  }
}

/** A word from its units; dynamic when any of them is a piece, as its text then holds a value not known yet. */
export function wordOfUnits(units: readonly LineUnit[]): ShellWord {
  return {
    text: units.map((unit) => (typeof unit === 'string' ? unit : unit.text)).join(''),
    dynamic: units.some((unit) => typeof unit !== 'string'),
  };
}

/** What a `--%` puts on the line, measured on 1,359 rows: two blanks, then its text, leading spaces cut, trailing ones kept. */
export function verbatimLine(text: readonly LineUnit[]): LineUnit[] {
  const start = text.findIndex((unit) => unit !== ' ');
  return [' ', ' ', ...(start === -1 ? [] : text.slice(start))];
}

/** A line up to its first NUL, as a program's command line is one C string; a piece keeps the text before it. */
function untilNul(line: readonly LineUnit[]): LineUnit[] {
  const kept: LineUnit[] = [];
  for (const unit of line) {
    const text = typeof unit === 'string' ? unit : unit.text;
    const nul = text.indexOf('\0');
    if (nul !== -1) {
      return nul === 0 ? kept : [...kept, { text: text.slice(0, nul) }];
    }
    kept.push(unit);
  }
  return kept;
}

/**
 * The words a native program gets from Windows PowerShell 5.1, its head left out: `args` are its arguments, each the
 * elements of one argument, and `verbatim` what a `--%` adds to the line, as {@link verbatimLine} gives it. The binder
 * writes one line and the runtime splits it again, so a value's quote can open onto the words after it and a word can
 * come apart.
 */
export function nativeWords(args: readonly (readonly ShellWord[])[], verbatim: readonly LineUnit[], runtime: CRuntime): ShellWord[] {
  const line = [...args.flatMap((elements) => [' ', ...boundArgument(elements)]), ...verbatim];
  return splitLine(untilNul(line), runtime).map(wordOfUnits);
}
