/** git's `isspace` (sane_ctype's GIT_SPACE): no vertical tab or form feed. */
const GIT_SPACE = new Set([' ', '\t', '\n', '\r']);
/**
 * Splits a git alias value the way git's `split_cmdline` does: whitespace separates words, `'` and `"` quote, and a
 * backslash outside single quotes keeps the next character. Nothing expands. A word starts at the value's first
 * character and after each whitespace run, so leading or trailing whitespace gives an empty word, as in git. git
 * refuses a value whose quote never closes or which ends in a backslash, and runs nothing.
 */
export function splitGitAlias(value) {
    const words = [];
    let current = '';
    let quote;
    for (let at = 0; at < value.length; at += 1) {
        let char = value.charAt(at);
        if (quote === undefined && GIT_SPACE.has(char)) {
            words.push(current);
            current = '';
            while (at + 1 < value.length && GIT_SPACE.has(value.charAt(at + 1))) {
                at += 1;
            }
        }
        else if (quote === undefined && (char === "'" || char === '"')) {
            quote = char;
        }
        else if (char === quote) {
            quote = undefined;
        }
        else {
            if (char === '\\' && quote !== "'") {
                at += 1;
                if (at === value.length) {
                    return { kind: 'refused', reason: 'git refuses an alias value that ends in a backslash' };
                }
                char = value.charAt(at);
            }
            current += char;
        }
    }
    if (quote !== undefined) {
        return { kind: 'refused', reason: 'git refuses an alias value whose quote never closes' };
    }
    words.push(current);
    return { kind: 'words', words: words.map((text) => ({ text, dynamic: false })) };
}
/** GNU env's whitespace in an `-S` string. */
const ENV_SPACE = new Set([' ', '\t', '\n', '\v', '\f', '\r']);
/** The escapes GNU env's `-S` reads, to the character each writes; `\_` and `\c` are read on their own. */
const ENV_ESCAPES = new Map([
    ['"', '"'],
    ['#', '#'],
    ['$', '$'],
    ["'", "'"],
    ['\\', '\\'],
    ['f', '\f'],
    ['n', '\n'],
    ['r', '\r'],
    ['t', '\t'],
    ['v', '\v'],
]);
/** One word of an `env -S` split as it builds: its text as written for a guard, and its pieces. */
class EnvWord {
    parts = [];
    text = '';
    add(text) {
        const last = this.parts.at(-1);
        if (last?.kind === 'text') {
            this.parts[this.parts.length - 1] = { ...last, text: last.text + text };
        }
        else {
            this.parts.push({ kind: 'text', text, quoted: true });
        }
        this.text += text;
    }
    /** `${NAME}`: env puts the value in this word whole, never split, so it is a quoted variable. */
    addVariable(name) {
        this.parts.push({ kind: 'variable', name, quoted: true });
        this.text += `\${${name}}`;
    }
    word() {
        const dynamic = this.parts.some((part) => part.kind === 'variable');
        return dynamic ? { text: this.text, dynamic, parts: this.parts } : { text: this.text, dynamic };
    }
}
/** Collects an `env -S` split's words; a word starts where a separator was seen, as env's `check_start_new_arg` does. */
class EnvWords {
    words = [];
    /** True after whitespace or `\_`, and at the start: the next character, quote or variable starts a word. */
    separated = true;
    current;
    /** The word a character goes into, started anew after a separator. */
    word() {
        if (this.separated || this.current === undefined) {
            this.finish();
            this.current = new EnvWord();
            this.separated = false;
        }
        return this.current;
    }
    finish() {
        if (this.current !== undefined) {
            this.words.push(this.current.word());
            this.current = undefined;
        }
        return this.words;
    }
}
function envEscape(next, double) {
    if (next === '') {
        return { kind: 'refused', reason: 'env -S refuses a backslash at the end of its string' };
    }
    if (next === '_') {
        return double ? { kind: 'char', char: ' ' } : { kind: 'separate' };
    }
    if (next === 'c') {
        return double ? { kind: 'refused', reason: 'env -S refuses \\c inside double quotes' } : { kind: 'end' };
    }
    const char = ENV_ESCAPES.get(next);
    return char === undefined ? { kind: 'refused', reason: `env -S refuses the escape \\${next}` } : { kind: 'char', char };
}
/**
 * Splits an `env -S` string the way GNU env does: whitespace separates words; `'` quotes all but `\\` and `\'`; `"`
 * quotes and reads escapes; `\_` separates words outside double quotes and is a space inside; `\c` ends the string
 * outside double quotes; `#` at a word's start ends it; `${NAME}` puts a variable's value in the word, unsplit (not
 * inside single quotes). env refuses an unknown escape, a backslash at the end, another `$` form, `\c` inside double
 * quotes and a quote that never closes, and runs nothing. An unset `${NAME}` starts no word in env; here it always
 * does, a dynamic one, so a guard never reads a word as the program that a set value would push aside.
 */
export function splitEnvString(value) {
    const split = new EnvWords();
    let single = false;
    let double = false;
    for (let at = 0; at < value.length; at += 1) {
        const char = value.charAt(at);
        if (char === "'" && !double) {
            single = !single;
            split.word();
        }
        else if (char === '"' && !single) {
            double = !double;
            split.word();
        }
        else if (ENV_SPACE.has(char) && !single && !double) {
            split.separated = true;
        }
        else if (char === '#' && split.separated) {
            return { kind: 'words', words: split.finish() };
        }
        else if (char === '\\' && (!single || value.charAt(at + 1) === '\\' || value.charAt(at + 1) === "'")) {
            at += 1;
            const escape = envEscape(value.charAt(at), double);
            if (escape.kind === 'refused') {
                return escape;
            }
            if (escape.kind === 'end') {
                return { kind: 'words', words: split.finish() };
            }
            if (escape.kind === 'separate') {
                split.separated = true;
            }
            else {
                split.word().add(escape.char);
            }
        }
        else if (char === '$' && !single) {
            const name = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}/.exec(value.slice(at))?.[1];
            if (name === undefined) {
                return { kind: 'refused', reason: 'env -S expands only ${NAME}' };
            }
            split.word().addVariable(name);
            at += name.length + 2;
        }
        else {
            split.word().add(char);
        }
    }
    if (single || double) {
        return { kind: 'refused', reason: 'env -S refuses a quote that never closes' };
    }
    return { kind: 'words', words: split.finish() };
}
