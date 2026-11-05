const QUOTE = '"';
const BACKSLASH = '\\';
/** The text of PowerShell's verbatim marker, for the parser and the binder alike. */
export const MARKER = '--%';
/**
 * The parser's `--%` on a line. Measured, the real line has no trace of it: inside quotes it adds nothing, not even a
 * blank, so `'a "b' --% c d` hands a program `a b  c d`. Between words it only ends the word before it, so
 * {@link splitLine} gives it no word, as the plain reading gives it none, and readings that agree still fold.
 */
export const PARSER_MARKER = { text: MARKER };
/** .NET's `char.IsWhiteSpace`, which decides the binder's quotes; U+180E, U+200B and U+FEFF measured as no blank. */
const BINDER_WHITE_SPACE = /[\t-\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/;
/** What separates a C runtime's arguments outside quotes; every other blank stays in its word. */
const RUNTIME_BLANK = /^[ \t]$/;
/**
 * A value as Windows PowerShell 5.1 writes it into the line, measured on 11,724 rows: it adds quotes only when a white
 * space sits at an even count of double quotes, every one counted, a backslashed one too, and escapes nothing. So
 * `a"b` goes in bare, and `a b\` ends in `\"`, which the runtime reads as a quote, not the end of the value.
 */
function bound(value) {
    let quotes = 0;
    let needed = false;
    for (const unit of value) {
        if (unit === QUOTE) {
            quotes += 1;
        }
        else if (quotes % 2 === 0 && BINDER_WHITE_SPACE.test(unit)) {
            needed = true;
        }
    }
    return needed ? `${QUOTE}${value}${QUOTE}` : value;
}
/**
 * One argument's units, each static value as `written` gives it. An array literal with no blank in it is one argument:
 * its elements are written one by one and joined by a comma, and an empty one adds nothing, the comma included. A value
 * of one empty element adds nothing at all, so the program never sees it. A value that opens with a NUL is not empty,
 * even where `written` leaves nothing of it: the comma behind it stays.
 */
function argumentUnits(elements, written) {
    const units = [];
    let joins = false;
    for (const element of elements) {
        if (element.text !== '') {
            units.push(...(joins ? [','] : []), ...(element.dynamic ? [{ text: element.text }] : written(element.text)));
            joins = true;
        }
    }
    return units;
}
/** How many backslashes run from `start`. */
function backslashRun(line, start) {
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
export function splitLine(line, runtime) {
    const words = [];
    const blankAt = (at) => {
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
        if (line[at] === PARSER_MARKER) {
            at += 1;
            continue;
        }
        const word = [];
        let quoted = false;
        while (at < line.length && (quoted || !(blankAt(at) || line[at] === PARSER_MARKER))) {
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
            }
            else if (unit === QUOTE && quoted && line[at + 1] === QUOTE) {
                word.push(QUOTE);
                at += 2;
                quoted = runtime === 'ucrt';
            }
            else if (unit === QUOTE) {
                quoted = !quoted;
                at += 1;
            }
            else if (unit === PARSER_MARKER) {
                at += 1;
            }
            else if (unit !== undefined) {
                word.push(unit);
                at += 1;
            }
        }
        words.push(word);
    }
}
/** A word from its units; dynamic when any of them is a piece, as its text then holds a value not known yet. */
export function wordOfUnits(units) {
    return {
        text: units.map((unit) => (typeof unit === 'string' ? unit : unit.text)).join(''),
        dynamic: units.some((unit) => typeof unit !== 'string'),
    };
}
/** What a `--%` puts on the line, measured on 1,359 rows: two blanks, then its text, leading spaces cut, trailing ones kept. */
export function verbatimLine(text) {
    const start = text.findIndex((unit) => unit !== ' ');
    return [' ', ' ', ...(start === -1 ? [] : text.slice(start))];
}
/** A `%NAME%`; a blank or a quote in it leaves it text, so a word inside `%a --no-verify b%` stays a word when unset. */
const VARIABLE = /(%[^%\s"]+%)/u;
/**
 * Text 5.1 expands on its way to a program, each `%NAME%` a piece as its value is not known here. Measured on 44 rows, it
 * is the only form: `%%`, `%1`, `%*`, `%~dp0` and `!NAME!` stay as written, so cmd's reading is not this one.
 */
export function expandedUnits(text) {
    return text.split(VARIABLE).flatMap((part, at) => (at % 2 === 1 ? [{ text: part }] : [...part]));
}
/**
 * What arguments add to the line behind the binder's `--%`, a value equal to it that no parser took as its marker:
 * measured, each keeps its blank and goes in with no quotes, its `%NAME%` expanded as {@link expandedUnits} says, so
 * `'--%' 'a b' c` hands a program `a`, `b` and `c`, and a value of `%W%` is as many words as W holds. A NUL here cuts only
 * its own value, so it never reaches the line.
 */
export function bareLine(args) {
    return args.flatMap((elements) => [' ', ...argumentUnits(elements, (value) => expandedUnits(value.replaceAll('\0', '')))]);
}
/** A line up to its first NUL, as a program's command line is one C string; a piece keeps the text before it. */
function untilNul(line) {
    const kept = [];
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
 * elements of one argument, and `written` what follows them on the line as it stands, as {@link bareLine} and
 * {@link verbatimLine} give it. The binder writes one line and the runtime splits it again, so a value's quote can open
 * onto the words after it and a word can come apart.
 */
export function nativeWords(args, written, runtime) {
    const line = [...args.flatMap((elements) => [' ', ...argumentUnits(elements, (value) => [...bound(value)])]), ...written];
    return splitLine(untilNul(line), runtime).map(wordOfUnits);
}
