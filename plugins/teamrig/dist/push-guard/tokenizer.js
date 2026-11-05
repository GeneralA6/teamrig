import { ansiCValue } from "./ansi-c.js";
/** How deep substitutions may nest before the parse stops and calls itself incomplete. */
const MAX_NESTING = 16;
/** Splits a command line into simple commands the way `dialect` would; see {@link Scanner}. */
export function parseShell(command, dialect) {
    return new Scanner(command, dialect, { nesting: 0, subshells: [], ids: { next: 0 } }).parse();
}
/**
 * The commands bash runs when an expansion reads a word's {@link ShellWord.held} text again: the substitutions
 * in it, read as in an unquoted heredoc's body, where quotes are plain text and a backslash keeps a `$`.
 * bash expands that text left to right, so where it never closes bash stops at the error after running the
 * substitutions before it, which the commands hold; only {@link ShellParse.skipped} text may hide one.
 */
export function parseHeldText(held) {
    return new Scanner(held, 'bash', { nesting: 0, subshells: [], ids: { next: 0 } }).parseExpandable();
}
/** Characters bash expands in unquoted text: a glob, or `~` for a home folder. */
const EXPANDS = /[*?[~]/;
/** A bash word whose text is its value: nothing in it is only known when it runs, and no unquoted text expands. */
export function isStaticWord(word) {
    return !word.dynamic && word.parts !== undefined && word.parts.every((part) => part.kind === 'text' && (part.quoted || !EXPANDS.test(part.text)));
}
/** A bash variable reference with nothing else in it: `$NAME` or `${NAME}`. */
const PLAIN_VARIABLE = /^\$(?:([A-Za-z_]\w*)|\{([A-Za-z_]\w*)\})$/;
/**
 * The head of a bash `${...}`: a `#` (length) or `!` (indirection) prefix, the parameter, a name with an
 * optional `[@]`, `[*]` or plain index such as `[0]` (arithmetic with nothing to run or assign), and the
 * operator after it, or `[` when another subscript follows.
 */
const BRACED_HEAD = /^\$\{([#!]?)([A-Za-z_]\w*(?:\[(?:[@*]|\d+)\])?|\d+|[@*#?$!-])?(:[-=+?]?|[-=+?]|##?|%%?|\/[/#%]?|\^\^?|,,?|@[A-Za-z]?|\[|\})?/;
/** Text that holds a bash command substitution: `$(` or a backtick. */
const SUBSTITUTION = /\$\(|`/;
/** The `${NAME@X}` transforms that never expand the value again: quoting, escapes, attributes and case. */
const PLAIN_TRANSFORM = /^@[QEAaUuLKk]$/;
/**
 * Whether a bash `${...}` can assign a variable as it expands: `=` and `:=` assign, a substring offset and an
 * array subscript other than a plain index are arithmetic, and indirection and `@P` expand a value the line
 * does not show. The
 * expansions in its word count on their own, as they are read.
 */
function bracedMayAssign(written) {
    const head = BRACED_HEAD.exec(written);
    const prefix = head?.[1];
    const parameter = head?.[2];
    const operator = head?.[3];
    if (parameter === undefined || operator === undefined || prefix === '!') {
        return true;
    }
    if (prefix === '#') {
        return operator !== '}';
    }
    return ['=', ':=', ':', '['].includes(operator) || (operator.startsWith('@') && !PLAIN_TRANSFORM.test(operator));
}
/** The word being read: its text so far, whether anything dynamic went in, its bash parts and brace-list hints. */
class WordBuilder {
    text = '';
    /** The text kept as written, every piece but the dynamic ones; see {@link ShellWord.held}. */
    literal = '';
    dynamic = false;
    started = false;
    brace = false;
    braceList = false;
    /** The parts so far; undefined once a piece is dynamic but not a plain variable. */
    parts = [];
    tracksParts;
    constructor(tracksParts) {
        this.tracksParts = tracksParts;
    }
    get isStarted() {
        return this.started;
    }
    get value() {
        return this.text;
    }
    /** Adds text; a piece read through a quote or an escape is `quoted`, as is any text outside bash. */
    add(chars, piece = 'quoted') {
        this.text += chars;
        this.literal += piece === 'dynamic' ? '' : chars;
        this.started = true;
        this.dynamic ||= piece === 'dynamic';
        if (this.parts !== undefined) {
            this.parts = piece === 'dynamic' ? undefined : withText(this.parts, chars, piece === 'quoted');
        }
    }
    /** Adds a `$` expansion as written; a plain variable stays a part, `quoted` inside double quotes or an expanding body. */
    addDollar(written, quoted) {
        this.text += written;
        this.started = true;
        this.dynamic = true;
        if (this.parts !== undefined) {
            this.parts = withVariable(this.parts, written, quoted);
        }
    }
    /** Notes an unquoted bash character: `{a,b}` and `{1..3}` expand to several words, so such a word is dynamic. */
    noteBrace(char) {
        if (char === '{') {
            this.brace = true;
        }
        else if (this.brace && (char === ',' || (char === '.' && this.text.endsWith('.')))) {
            this.braceList = true;
        }
    }
    take() {
        const word = this.started ? this.word() : undefined;
        this.text = '';
        this.literal = '';
        this.dynamic = false;
        this.started = false;
        this.brace = false;
        this.braceList = false;
        this.parts = [];
        return word;
    }
    /** The word read so far, even an empty one, such as a heredoc's empty body. */
    word() {
        const held = this.tracksParts && SUBSTITUTION.test(this.literal) ? { held: this.literal } : {};
        const word = { text: this.text, dynamic: this.dynamic || this.braceList, ...held };
        return this.tracksParts && this.parts !== undefined && !this.braceList ? { ...word, parts: this.parts } : word;
    }
}
/** `parts` with `text` added, joined to the last part when that is text quoted the same way. */
function withText(parts, text, quoted) {
    if (text === '') {
        return parts;
    }
    const last = parts.at(-1);
    if (last?.kind === 'text' && last.quoted === quoted) {
        return [...parts.slice(0, -1), { kind: 'text', text: last.text + text, quoted }];
    }
    return [...parts, { kind: 'text', text, quoted }];
}
/** `parts` with a `$` expansion added: a plain variable reference, or undefined for anything else. */
function withVariable(parts, written, quoted) {
    const match = PLAIN_VARIABLE.exec(written);
    const name = match?.[1] ?? match?.[2];
    return name === undefined ? undefined : [...parts, { kind: 'variable', name, quoted }];
}
/**
 * Reads a command line the way bash, PowerShell or cmd splits it: quotes group words, an unquoted separator
 * ends a command (`; & | ( )` and a newline, `{ }` in PowerShell, only `& | ( )` in cmd), `#` at a word start
 * begins a comment (bash and PowerShell), and a redirection is kept apart from the words with its target. A
 * variable, `$(...)`, backticks (bash), `@(...)` (PowerShell) or `%VAR%` (cmd) leave the word dynamic, and the
 * commands inside a substitution are read too. PowerShell's `&` call operator is kept as a word at a command's
 * start. A bash heredoc's body, after the newline that ends its line, is its command's stdin, not commands
 * (the substitutions an unquoted one expands are read); a PowerShell here-string is one word.
 */
class Scanner {
    index = 0;
    complete = true;
    skipped = false;
    nesting;
    commands = [];
    /** bash heredocs opened since the last newline, in order. */
    heredocs = [];
    unreadBodies = [];
    bindingsUnclear = false;
    /** How many bash `${...}`, `$((...))` and `$[...]` the reader is inside, bounded like substitutions. */
    expansions = 0;
    subshells;
    ids;
    source;
    dialect;
    constructor(source, dialect, scope) {
        this.source = source;
        this.dialect = dialect;
        this.nesting = scope.nesting;
        this.subshells = scope.subshells;
        this.ids = scope.ids;
    }
    parse() {
        return this.scan();
    }
    /** Reads the whole source as expandable text; the commands are those of the substitutions in it. */
    parseExpandable() {
        this.readExpandable(new WordBuilder(true), this.source.length);
        return this.result();
    }
    /** Reads the whole source; its commands stay open to the separators an enclosing scanner adds after them. */
    scan() {
        this.readList(false);
        return this.result();
    }
    /** What the reader found so far. */
    result() {
        return { commands: this.commands, complete: this.complete, skipped: this.skipped, unreadBodies: this.unreadBodies, bindingsUnclear: this.bindingsUnclear };
    }
    /** Notes text the reader leaves unread that may hold commands; see {@link ShellParse.skipped}. */
    skip() {
        this.complete = false;
        this.skipped = true;
    }
    /** Adds separator characters to the command read last, if any. */
    addTerminator(chars) {
        const last = this.commands.at(-1);
        if (last !== undefined) {
            last.terminator += chars;
        }
    }
    at(offset = 0) {
        return this.source.charAt(this.index + offset);
    }
    get done() {
        return this.index >= this.source.length;
    }
    openSubshell() {
        this.subshells.push(this.ids.next);
        this.ids.next += 1;
    }
    /** Reads commands to the end or, inside a substitution, through the `)` that closes it. */
    readList(inSubstitution) {
        let words = [];
        const word = new WordBuilder(this.dialect === 'bash');
        /** The operator of a redirection whose target is the next word. */
        let awaiting;
        let verbatim = false;
        let redirections = [];
        let depth = 0;
        /** The depth a bash `((` arithmetic command opened at: inside it `<<` shifts and starts no heredoc. */
        let arithmetic;
        /**
         * The command a `( )` group closed on, until the command after its `)` ends: redirections there belong
         * to the group, so they join that command, as those after a `{ }` group's `}` join the `}` command.
         */
        let closedGroup;
        const endWord = () => {
            const taken = word.take();
            if (taken === undefined) {
                return;
            }
            if (awaiting === undefined) {
                words.push(taken);
                verbatim = this.dialect === 'powershell' && taken.text === '--%' && !taken.dynamic;
                return;
            }
            redirections.push({ operator: awaiting, target: taken });
            awaiting = undefined;
        };
        const endCommand = () => {
            endWord();
            if (awaiting !== undefined) {
                redirections.push({ operator: awaiting });
                awaiting = undefined;
            }
            verbatim = false;
            const command = words.length > 0 || (redirections.length > 0 && closedGroup === undefined)
                ? { words, subshells: [...this.subshells], terminator: '', redirections, nesting: this.nesting }
                : undefined;
            if (command !== undefined) {
                this.commands.push(command);
            }
            else {
                closedGroup?.redirections.push(...redirections);
            }
            closedGroup = undefined;
            // A heredoc on a line of redirections alone has no reader: its body is one of the unread ones.
            this.openHeredocs(words.length > 0 ? command : undefined, redirections, arithmetic === undefined);
            words = [];
            redirections = [];
        };
        while (!this.done) {
            if (verbatim) {
                words.push(...this.readVerbatim());
                verbatim = false;
                continue;
            }
            const char = this.at();
            if (char === ')' && depth === 0 && inSubstitution) {
                this.index += 1;
                endCommand();
                return;
            }
            if (this.readQuoteOrExpansion(word)) {
                continue;
            }
            if (char === '\n') {
                endCommand();
                this.addTerminator(char);
                this.index += 1;
                this.readHeredocBodies();
                continue;
            }
            if (char === '(') {
                endCommand();
                this.addTerminator(char);
                if (this.dialect === 'bash' && this.at(1) === '(') {
                    this.bindingsUnclear = true;
                    arithmetic ??= depth;
                }
                depth += 1;
                if (this.dialect === 'bash') {
                    this.openSubshell();
                }
            }
            else if (char === ')') {
                endCommand();
                this.addTerminator(char);
                if (depth > 0) {
                    depth -= 1;
                    if (this.dialect === 'bash') {
                        this.subshells.pop();
                    }
                    closedGroup = this.commands.at(-1);
                }
                if (depth === arithmetic) {
                    arithmetic = undefined;
                }
            }
            else if (this.isCallOperator(char, words.length === 0 && !word.isStarted)) {
                words.push({ text: '&', dynamic: false });
            }
            else if (this.isSeparator(char)) {
                endCommand();
                this.addTerminator(char);
            }
            else if (char === '#' && !word.isStarted && this.dialect !== 'cmd') {
                this.skipComment();
                continue;
            }
            else if (char === '<' || char === '>' || this.isOutputAndErrorRedirection(char)) {
                if (this.readProcessSubstitution(word)) {
                    continue;
                }
                // A file-descriptor number (`2>`), PowerShell's `*>` or bash's `{NAME}>` belongs to the redirection.
                const named = this.dialect === 'bash' && /^\{[A-Za-z_]\w*\}$/.test(word.value);
                let descriptor = '';
                if (char !== '&' && word.isStarted && (named || /^(?:\d+|\*)$/.test(word.value))) {
                    descriptor = word.value;
                    word.take();
                    this.bindingsUnclear ||= named;
                }
                else {
                    endWord();
                }
                if (awaiting !== undefined) {
                    redirections.push({ operator: awaiting });
                }
                const start = this.index;
                const targeted = this.readRedirection();
                const operator = descriptor + this.source.slice(start, this.index + 1);
                awaiting = targeted ? operator : undefined;
                if (!targeted) {
                    redirections.push({ operator });
                }
            }
            else if (/\s/.test(char)) {
                endWord();
            }
            else if (char === ',' && this.dialect === 'powershell') {
                // An unquoted comma builds an array: each element reaches a native program as its own argument.
                endWord();
            }
            else if (char === '@' && this.dialect === 'cmd' && words.length === 0 && !word.isStarted) {
                // cmd's `@` before a command only hides its echo.
            }
            else {
                if (this.dialect === 'bash') {
                    word.noteBrace(char);
                }
                word.add(char, 'unquoted');
            }
            this.index += 1;
        }
        endCommand();
        if (inSubstitution || depth > 0) {
            this.complete = false;
        }
        if (this.dialect === 'bash') {
            this.subshells.length = Math.max(0, this.subshells.length - depth);
        }
    }
    /**
     * Notes the bash heredocs among a command's redirections, whose bodies follow the next newline, and gives
     * the command a here-string as stdin: its last input redirection decides what it reads. A delimiter only
     * known when it runs opens no heredoc, so the lines after it stay commands.
     */
    openHeredocs(command, redirections, heredocsOpen) {
        if (this.dialect !== 'bash') {
            return;
        }
        const input = redirections.findLast((redirection) => /^0?</.test(redirection.operator));
        if (command !== undefined && input?.operator.endsWith('<<<') === true && input.target !== undefined) {
            command.stdin = input.target;
        }
        for (const redirection of redirections) {
            const target = redirection.target;
            if (!heredocsOpen || !/^\d*<<-?$/.test(redirection.operator)) {
                continue;
            }
            if (target !== undefined && !target.dynamic && target.text !== '') {
                const quoted = target.parts?.some((part) => part.kind === 'text' && part.quoted) === true;
                this.heredocs.push({ delimiter: target.text, tabbed: redirection.operator.endsWith('-'), expands: !quoted, reader: redirection === input ? command : undefined });
            }
            else {
                this.bindingsUnclear = true;
            }
        }
    }
    /**
     * After a newline: reads the body of each bash heredoc opened before it, through the first line that is its
     * delimiter, as bash finds it. A body is its reader's stdin; an unquoted one expands, so the
     * substitutions in it are read as commands, placed before the reader. A delimiter that never comes leaves
     * the lines as commands, so a stray `<<` cannot hide them.
     */
    readHeredocBodies() {
        for (const heredoc of this.heredocs.splice(0)) {
            const close = this.delimiterLine(heredoc);
            if (close === undefined) {
                this.bindingsUnclear = true;
                return;
            }
            const end = Math.max(this.index, close.start - 1);
            const body = new WordBuilder(true);
            const before = this.commands.length;
            if (heredoc.expands) {
                this.readExpandable(body, end);
            }
            else {
                body.add(this.source.slice(this.index, end));
            }
            const inner = this.commands.splice(before);
            const at = heredoc.reader === undefined ? this.commands.length : this.commands.indexOf(heredoc.reader);
            this.commands.splice(at, 0, ...inner);
            if (heredoc.reader === undefined) {
                this.unreadBodies.push(body.word());
            }
            else {
                heredoc.reader.stdin = body.word();
            }
            this.index = Math.max(this.index, close.next);
        }
    }
    /**
     * The first line from the cursor that is exactly the heredoc's delimiter, after leading tabs for `<<-`, as
     * bash requires: where it starts, and where the next line starts. A line with other blanks or a `\r` does
     * not close it.
     */
    delimiterLine(heredoc) {
        let start = this.index;
        for (const line of this.source.slice(this.index).split('\n')) {
            if ((heredoc.tabbed ? line.replace(/^\t+/, '') : line) === heredoc.delimiter) {
                return { start, next: Math.min(start + line.length + 1, this.source.length) };
            }
            start += line.length + 1;
        }
        return undefined;
    }
    /**
     * Expandable text through `end`: an unquoted heredoc's body or a PowerShell `@"` here-string. Quotes are
     * plain text; variables and substitutions expand, and the commands inside a substitution are read.
     */
    readExpandable(word, end) {
        word.add('');
        while (this.index < end) {
            const char = this.at();
            if (this.dialect === 'bash' && char === '\\' && /[\\$`\n]/.test(this.at(1))) {
                word.add(this.at(1) === '\n' ? '' : this.at(1));
                this.index += 2;
            }
            else if (this.dialect === 'powershell' && char === '`') {
                this.readEscape(word);
            }
            else if (char === '$') {
                this.readDollar(word, true);
            }
            else if (this.dialect === 'bash' && char === '`') {
                this.readBackticks(word);
            }
            else {
                word.add(char);
                this.index += 1;
            }
        }
        this.complete &&= this.index === end;
    }
    /** At `@`: true when `@'` or `@"` ends its line, which opens a PowerShell here-string. */
    opensHereString() {
        const quote = this.at(1);
        const opener = /[ \t]*\r?\n/y;
        opener.lastIndex = this.index + 2;
        return (quote === "'" || quote === '"') && opener.test(this.source);
    }
    /**
     * PowerShell `@'...'@` (literal) and `@"..."@` (expandable): the lines between the opening line and the first
     * line that starts with the closing `'@` or `"@`, blanks before it allowed. One that never closes takes the rest.
     */
    readHereString(word) {
        const quote = this.at(1);
        const start = this.source.indexOf('\n', this.index) + 1;
        const closing = new RegExp(`\\r?\\n[ \\t]*${quote}@`, 'g');
        closing.lastIndex = start - 1;
        const close = closing.exec(this.source);
        const end = close === null ? this.source.length : Math.max(start, close.index);
        this.index = start;
        if (quote === '"') {
            this.readExpandable(word, end);
        }
        else {
            word.add(this.source.slice(start, end));
        }
        this.complete &&= close !== null;
        this.index = close === null ? this.source.length : Math.max(this.index, close.index + close[0].length);
    }
    /** PowerShell's `&` at a command's start calls the program named next; elsewhere `&` separates commands. */
    isCallOperator(char, atCommandStart) {
        return this.dialect === 'powershell' && char === '&' && this.at(1) !== '&' && this.at(-1) !== '&' && atCommandStart;
    }
    /** bash `&>` and `&>>` send stdout and stderr to a file: a redirection, where `&&>` and `|&>` end a command first. */
    isOutputAndErrorRedirection(char) {
        return this.dialect === 'bash' && char === '&' && this.at(1) === '>' && this.at(-1) !== '&' && this.at(-1) !== '|';
    }
    isSeparator(char) {
        switch (this.dialect) {
            case 'bash':
                return char === ';' || char === '|' || (char === '&' && !this.isOutputAndErrorRedirection(char));
            case 'powershell':
                return char === ';' || char === '&' || char === '|' || char === '{' || char === '}';
            case 'cmd':
                return char === '&' || char === '|';
        }
    }
    /** Reads a quote, an escape or an expansion at the cursor into `word`; false when the cursor holds none. */
    readQuoteOrExpansion(word) {
        switch (this.dialect) {
            case 'bash':
                return this.readBashQuote(word);
            case 'powershell':
                return this.readPowerShellQuote(word);
            case 'cmd':
                return this.readCmdQuote(word);
        }
    }
    readBashQuote(word) {
        const char = this.at();
        if (char === '$' && this.at(1) === "'") {
            this.index += 1;
            this.readAnsiCQuoted(word);
        }
        else if (char === '$' && this.at(1) === '"') {
            this.index += 1;
            this.readDoubleQuoted(word);
        }
        else if (char === "'") {
            this.readSingleQuoted(word);
        }
        else if (char === '"') {
            this.readDoubleQuoted(word);
        }
        else if (char === '\\') {
            this.readEscape(word);
        }
        else if (char === '`') {
            this.readBackticks(word);
        }
        else if (char === '$') {
            this.readDollar(word, false);
        }
        else {
            return false;
        }
        return true;
    }
    readPowerShellQuote(word) {
        const char = this.at();
        if (char === "'") {
            this.readSingleQuoted(word);
        }
        else if (char === '"') {
            this.readDoubleQuoted(word);
        }
        else if (char === '`') {
            this.readEscape(word);
        }
        else if (char === '$') {
            this.readDollar(word, false);
        }
        else if (char === '@' && !word.isStarted && this.opensHereString()) {
            this.readHereString(word);
        }
        else if (char === '@' && (this.at(1) === '(' || (/[A-Za-z_]/.test(this.at(1)) && !word.isStarted))) {
            this.readSplatOrArray(word);
        }
        else if (char === '<' && this.at(1) === '#') {
            this.skipBlockComment();
        }
        else {
            return false;
        }
        return true;
    }
    readCmdQuote(word) {
        const char = this.at();
        if (char === '"') {
            this.readDoubleQuoted(word);
        }
        else if (char === '^') {
            this.readEscape(word);
        }
        else if (char === '%' || char === '!') {
            this.readCmdVariable(word);
        }
        else {
            return false;
        }
        return true;
    }
    /** `'...'`: literal; in PowerShell `''` inside is one quote. An unclosed quote takes the rest of the line. */
    readSingleQuoted(word) {
        this.index += 1;
        let text = '';
        while (!this.done) {
            const char = this.at();
            if (char === "'") {
                if (this.dialect === 'powershell' && this.at(1) === "'") {
                    text += "'";
                    this.index += 2;
                    continue;
                }
                this.index += 1;
                word.add(text);
                return;
            }
            text += char;
            this.index += 1;
        }
        word.add(text);
        this.complete = false;
    }
    /**
     * bash `$'...'`, in bash's two steps: the closing quote is the first one no backslash hides, then the text between is
     * decoded on its own. They disagree on `\c\'`, whose decoding takes the backslash the search paired with the quote.
     */
    readAnsiCQuoted(word) {
        this.index += 1;
        const start = this.index;
        while (!this.done && this.at() !== "'") {
            this.index += this.at() === '\\' ? 2 : 1;
        }
        word.add(ansiCValue(this.source.slice(start, this.index)));
        if (this.done) {
            this.complete = false;
        }
        this.index += 1;
    }
    /** `"..."`: expansions inside stay dynamic; bash escapes with `\`, PowerShell with a backtick or `""`, cmd not at all. */
    readDoubleQuoted(word) {
        this.index += 1;
        word.add('');
        while (!this.done) {
            const char = this.at();
            if (char === '"') {
                if (this.dialect === 'powershell' && this.at(1) === '"') {
                    word.add('"');
                    this.index += 2;
                    continue;
                }
                this.index += 1;
                return;
            }
            if (this.dialect === 'bash' && char === '\\' && /["\\$`\n]/.test(this.at(1))) {
                word.add(this.at(1) === '\n' ? '' : this.at(1));
                this.index += 2;
            }
            else if (this.dialect === 'powershell' && char === '`') {
                this.readEscape(word);
            }
            else if (this.dialect !== 'cmd' && char === '$') {
                this.readDollar(word, true);
            }
            else if (this.dialect === 'bash' && char === '`') {
                this.readBackticks(word);
            }
            else if (this.dialect === 'cmd' && (char === '%' || char === '!')) {
                this.readCmdVariable(word);
            }
            else {
                word.add(char);
                this.index += 1;
            }
        }
        this.complete = false;
    }
    /** The escape character (`\`, a backtick or `^`) keeps the next character; before a newline it joins the lines. */
    readEscape(word) {
        const next = this.at(1);
        if (next === '\n') {
            this.index += 2;
            return;
        }
        if (next === '\r' && this.at(2) === '\n') {
            this.index += 3;
            return;
        }
        word.add(next === '' ? this.at() : next);
        this.index += 2;
    }
    /**
     * At `$`: a substitution `$(...)` (its commands are read too), arithmetic `$((...))` or bash `$[...]`, `${...}`
     * or a variable, kept as written and dynamic; `quoted` inside double quotes or an expanding body. A `$` that
     * starts none of them is literal.
     */
    readDollar(word, quoted) {
        const start = this.index;
        const next = this.at(1);
        if (next === '(' && this.dialect === 'bash' && this.at(2) === '(') {
            this.index += 3;
            this.readArithmetic('(', ')', 2, quoted);
            this.bindingsUnclear = true;
        }
        else if (next === '[' && this.dialect === 'bash') {
            this.index += 2;
            this.readArithmetic('[', ']', 1, quoted);
            this.bindingsUnclear = true;
        }
        else if (next === '(') {
            this.index += 2;
            this.readSubstitution();
        }
        else if (next === '{' && this.dialect === 'bash') {
            this.readBraced(quoted);
            this.bindingsUnclear ||= bracedMayAssign(this.source.slice(start, this.index));
        }
        else if (next === '{') {
            const close = this.source.indexOf('}', this.index + 2);
            this.complete &&= close !== -1;
            this.index = close === -1 ? this.source.length : close + 1;
        }
        else if (this.dialect === 'bash' && /[A-Za-z_]/.test(next)) {
            this.index += 1;
            while (/\w/.test(this.at())) {
                this.index += 1;
            }
        }
        else if (this.dialect === 'bash' && /[0-9@*#?$!-]/.test(next)) {
            this.index += 2;
        }
        else if (this.dialect === 'powershell' && /[\w?$^]/.test(next)) {
            this.index += 1;
            while (/[\w:?$^]/.test(this.at())) {
                this.index += 1;
            }
        }
        else {
            word.add('$');
            this.index += 1;
            return;
        }
        word.addDollar(this.source.slice(start, this.index), quoted);
    }
    /**
     * bash, at `${`: reads through the first `}` that no quote, escape or substitution holds, and the commands of
     * a substitution inside, as in `${B:-$(git branch --show-current)}`. Inside double quotes or an expanding body
     * (`quoted`) single quotes still hold a `}` but are kept as text, and expansions inside them may run, so a
     * single-quoted piece there that holds anything but plain text is not read with confidence.
     */
    readBraced(quoted) {
        if (!this.enterExpansion()) {
            return;
        }
        const inner = new WordBuilder(false);
        this.index += 2;
        while (!this.done && this.at() !== '}') {
            const char = this.at();
            if (!quoted) {
                if (!this.readBashQuote(inner)) {
                    this.index += 1;
                }
            }
            else if (char === "'") {
                const close = this.source.indexOf("'", this.index + 1);
                if (close === -1 || /[}"$`\\]/.test(this.source.slice(this.index + 1, close))) {
                    this.skip();
                }
                this.index = close === -1 ? this.source.length : close + 1;
            }
            else if (char === '"') {
                this.readDoubleQuoted(inner);
            }
            else if (char === '\\') {
                this.index += 2;
            }
            else if (char === '$') {
                this.readDollar(inner, true);
            }
            else if (char === '`') {
                this.readBackticks(inner);
            }
            else {
                this.index += 1;
            }
        }
        this.complete &&= !this.done;
        this.index = Math.min(this.index + 1, this.source.length);
        this.expansions -= 1;
    }
    /** Inside `$(`, `@(` or `<(`: reads the commands through the closing `)`; in bash they run in a subshell. */
    readSubstitution() {
        if (this.nesting >= MAX_NESTING) {
            this.skip();
            this.index = this.source.length;
            return;
        }
        this.nesting += 1;
        if (this.dialect === 'bash') {
            this.openSubshell();
        }
        this.readList(true);
        if (this.dialect === 'bash') {
            this.subshells.pop();
        }
        this.nesting -= 1;
    }
    /**
     * Reads to the `close` that brings `depth` open brackets to zero, as in `$((1 + (2)))` or `$[a[1]]`, and the
     * commands of the substitutions inside, which run before the sum. A single quote there is an error bash may
     * read past, so a line with one is not read with confidence.
     */
    readArithmetic(open, close, depth, quoted) {
        if (!this.enterExpansion()) {
            return;
        }
        const inner = new WordBuilder(false);
        let left = depth;
        while (!this.done && left > 0) {
            const char = this.at();
            if (char === '$') {
                this.readDollar(inner, quoted);
            }
            else if (char === '`') {
                this.readBackticks(inner);
            }
            else if (char === '"') {
                this.readDoubleQuoted(inner);
            }
            else if (char === '\\') {
                this.index += 2;
            }
            else {
                this.complete &&= char !== "'";
                left += char === open ? 1 : char === close ? -1 : 0;
                this.index += 1;
            }
        }
        this.complete &&= left === 0;
        this.expansions -= 1;
    }
    /** Counts one more bash expansion the reader is inside; false, with the line unreadable, when they nest too deep. */
    enterExpansion() {
        if (this.expansions >= MAX_NESTING) {
            this.skip();
            this.index = this.source.length;
            return false;
        }
        this.expansions += 1;
        return true;
    }
    /** bash backticks: the commands inside are read as their own line, in a subshell; the word keeps them as written. */
    readBackticks(word) {
        const start = this.index;
        let inner = '';
        this.index += 1;
        while (!this.done && this.at() !== '`') {
            if (this.at() === '\\' && /[`\\$]/.test(this.at(1))) {
                this.index += 1;
            }
            inner += this.at();
            this.index += 1;
        }
        if (this.done) {
            this.complete = false;
        }
        else {
            this.index += 1;
        }
        if (this.nesting >= MAX_NESTING) {
            this.skip();
        }
        else {
            const subshells = [...this.subshells, this.ids.next];
            this.ids.next += 1;
            const nested = new Scanner(inner, 'bash', { nesting: this.nesting + 1, subshells, ids: this.ids }).scan();
            this.commands.push(...nested.commands);
            this.unreadBodies.push(...nested.unreadBodies);
            this.complete &&= nested.complete;
            this.skipped ||= nested.skipped;
            this.bindingsUnclear ||= nested.bindingsUnclear;
        }
        word.add(this.source.slice(start, this.index), 'dynamic');
    }
    /** bash `<(...)` and `>(...)`: a process substitution, read like `$(...)`; false at a plain redirection. */
    readProcessSubstitution(word) {
        if (this.dialect !== 'bash' || this.at(1) !== '(' || word.isStarted) {
            return false;
        }
        const start = this.index;
        this.index += 2;
        this.readSubstitution();
        word.add(this.source.slice(start, this.index), 'dynamic');
        return true;
    }
    /** PowerShell `@(...)` (read like `$(...)`) or a splatted `@args`; both are dynamic. */
    readSplatOrArray(word) {
        const start = this.index;
        if (this.at(1) === '(') {
            this.index += 2;
            this.readSubstitution();
        }
        else {
            this.index += 1;
            while (/\w/.test(this.at())) {
                this.index += 1;
            }
        }
        word.add(this.source.slice(start, this.index), 'dynamic');
    }
    /**
     * cmd `%VAR%`, `%1`, `%*`, `%~dp0` and delayed `!VAR!` are dynamic; `%%` is one literal `%`, and a `%` or `!`
     * that starts none of them is literal.
     */
    readCmdVariable(word) {
        const rest = this.source.slice(this.index);
        const match = /^(?:%%|%~[a-zA-Z]*[0-9]|%[0-9*]|%[^%\s"]+%|![^!\s"]+!)/.exec(rest);
        if (match === null) {
            word.add(this.at());
            this.index += 1;
        }
        else if (match[0] === '%%') {
            word.add('%');
            this.index += 2;
        }
        else {
            word.add(match[0], 'dynamic');
            this.index += match[0].length;
        }
    }
    /**
     * Moves past a redirection operator; true when a target word follows (`> file`), false when a descriptor
     * does: `2>&1` copies one, `2>&1-` moves it and `2>&-` closes it.
     */
    readRedirection() {
        while (/[<>&|]/.test(this.at(1)) || this.dashEndsOperator()) {
            this.index += 1;
        }
        if (this.at() === '-' && this.at(-1) === '&') {
            return false;
        }
        if (this.at() === '&' && /\d/.test(this.at(1))) {
            while (/\d/.test(this.at(1))) {
                this.index += 1;
            }
            if (this.at(1) === '-') {
                this.index += 1;
            }
            return false;
        }
        return true;
    }
    /** Whether the next `-` belongs to the redirection operator: in `<<-` and in `>&-`, not in `>-`, which writes to a file named `-`. */
    dashEndsOperator() {
        return this.at(1) === '-' && (this.at() === '&' || (this.at() === '<' && this.at(-1) === '<' && this.at(-2) !== '<'));
    }
    skipComment() {
        while (!this.done && this.at() !== '\n') {
            this.index += 1;
        }
    }
    /** PowerShell `<# ... #>`; an unclosed one runs to the end. */
    skipBlockComment() {
        const close = this.source.indexOf('#>', this.index + 2);
        this.index = close === -1 ? this.source.length : close + 2;
    }
    /**
     * After PowerShell's `--%`: the rest of the line up to a newline or `|` goes to the program as written,
     * split on spaces and double quotes, with cmd-style `%VAR%` left dynamic.
     */
    readVerbatim() {
        const words = [];
        const word = new WordBuilder(false);
        const flush = () => {
            const taken = word.take();
            if (taken !== undefined) {
                words.push(taken);
            }
        };
        while (!this.done && this.at() !== '\n' && this.at() !== '|') {
            const char = this.at();
            if (char === '"') {
                this.index += 1;
                word.add('');
                while (!this.done && this.at() !== '"' && this.at() !== '\n') {
                    word.add(this.at());
                    this.index += 1;
                }
                this.index += this.at() === '"' ? 1 : 0;
            }
            else if (char === '%') {
                this.readCmdVariable(word);
            }
            else {
                if (/\s/.test(char)) {
                    flush();
                }
                else {
                    word.add(char);
                }
                this.index += 1;
            }
        }
        flush();
        return words;
    }
}
