import { isStaticWord, parseShell } from "../push-guard/tokenizer.js";
/**
 * The first gate of a sanctioned route (T679, security ruling C1): a Bash line is one plain command whose words are
 * their own text, so the words a route matches are the words bash runs. Two layers, each enough to refuse: a scan of
 * the raw text, which no gap in the tokenizer can pass, then the parse. A quoted commit message holding `;`, `>` or `#`
 * is refused too: it simply matches no route, and the call goes on to the prompt as before.
 */
/** A standalone `2>&1`, the one redirection a route line may carry; the scan takes it out before it looks. */
const STDERR_TO_STDOUT = /(?<=^|[ \t])2>&1(?=[ \t]|$)/g;
/**
 * Text that may join, feed, redirect or substitute another command, refused even inside quotes; `#`, whose comment
 * bash skips, so an allowed line never carries text the matcher did not judge; and `$'` and `$"`, whose value is not the
 * text the line shows (T1994), which no route needs.
 */
const JOINS = /[;&|<>`#]|\$[({'"]/;
/** A leading `NAME=value` word, which sets a variable for the command instead of naming its program. */
const ASSIGNMENT = /^[A-Za-z_]\w*=/;
/** The words of `line` when it is one plain bash command, else undefined. */
export function plainWordsOf(line) {
    if (!scansPlain(line)) {
        return undefined;
    }
    const command = onlyCommandOf(parseShell(line, 'bash'));
    if (command === undefined || !isPlainCommand(command)) {
        return undefined;
    }
    const words = command.words.map((word) => word.text);
    const [program] = words;
    return program === undefined || ASSIGNMENT.test(program) ? undefined : words;
}
/** The raw scan: no control character but a tab (a newline included), nothing that joins commands or starts a comment, outside a lone `2>&1`. */
function scansPlain(line) {
    const scanned = line.replace(STDERR_TO_STDOUT, ' ');
    return !JOINS.test(scanned) && ![...scanned].some(isControl);
}
function isControl(character) {
    const code = character.codePointAt(0) ?? 0;
    return (code < 0x20 && character !== '\t') || code === 0x7f;
}
/** The parse's one command, when the parse read the whole line with confidence. */
function onlyCommandOf(parse) {
    const [command, ...more] = parse.commands;
    const clear = parse.complete && !parse.skipped && !parse.bindingsUnclear && parse.unreadBodies.length === 0;
    return clear && more.length === 0 ? command : undefined;
}
/** A top-level command of static words, no stdin from the line, and no redirection but `2>&1`. */
function isPlainCommand(command) {
    return (command.nesting === 0 &&
        command.subshells.length === 0 &&
        command.terminator === '' &&
        command.stdin === undefined &&
        command.redirections.every((redirection) => redirection.operator === '2>&1' && redirection.target === undefined) &&
        command.words.length > 0 &&
        command.words.every((word) => isStaticWord(word) && word.held === undefined));
}
