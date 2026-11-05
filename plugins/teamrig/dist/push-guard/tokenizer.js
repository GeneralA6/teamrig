import { ansiCValue } from "./ansi-c.js";
/** How deep substitutions may nest before the parse stops and calls itself incomplete. */
const MAX_NESTING = 16;
/**
 * What separates the words of an unquoted line, measured on the real shells (T2002). JS `\s` fits none of them:
 * PowerShell also takes U+0085 and keeps U+FEFF in a word, and bash and a program started by cmd take only these two.
 */
const BLANKS = {
    bash: /[ \t]/,
    powershell: /[\t\v\f \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/,
    cmd: /[ \t]/,
};
/**
 * PowerShell's quote marks, measured on its parser (T2002): any mark of a class closes a quote any other opened. bash
 * and cmd know only the plain ones.
 */
const POWERSHELL_QUOTES = { single: /['\u2018\u2019\u201a\u201b]/, double: /["\u201c\u201d\u201e]/ };
/**
 * What a PowerShell backtick makes of a letter, in a word or in quotes alike, measured on 5.1 (T2002). Every other letter
 * keeps itself. That holds `e` too, ESC on pwsh 7: only the letter can spell an option, and ESC makes a word git refuses.
 */
const POWERSHELL_ESCAPES = new Map([
    ['0', '\0'],
    ['a', '\x07'],
    ['b', '\b'],
    ['f', '\f'],
    ['n', '\n'],
    ['r', '\r'],
    ['t', '\t'],
    ['v', '\v'],
]);
/** pwsh's escape for a character by its number, from its backtick; see {@link Reading.codePoints}. */
const CODE_POINT = /`u\{[0-9a-fA-F]{1,6}\}/y;
const MAX_CODE_POINT = 0x10ffff;
/** A word that is all a redirection's file-descriptor number: `2` of `2>`, or PowerShell's `*` of `*>`. */
const DESCRIPTOR = /^(?:\d+|\*)$/;
/**
 * PowerShell's variable, member name and `-name:` token, measured on its parser (T2002). A `/u` class takes a surrogate
 * pair as one unit, which the tables never counted as a letter, so each refuses one first: else a word is cut there and
 * a `--verify` after it reads as a cancel. `:(?!:)` leaves `::` to the member chain, as `$v::Length` is a member.
 */
const VARIABLE = /\$(?![\u{10000}-\u{10ffff}])[\p{L}\p{Nd}_?$^\u1885\u1886](?:(?![\u{10000}-\u{10ffff}])[\p{L}\p{Nd}_?$^\u1885\u1886]|:(?!:))*/uy;
const MEMBER_NAME = /(?:(?![\u{10000}-\u{10ffff}])[\p{L}\p{Nd}_\u1885\u1886])+/uy;
const PARAMETER = /[-\u2013\u2014\u2015](?![\u{10000}-\u{10ffff}])[\p{L}_?\u1885\u1886][^.[;|:\0\t\v\f \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\n\r'\u2018\u2019\u201a\u201b"\u201c\u201d\u201e&(),{}]*:(?!:)/uy;
/**
 * Every way PowerShell may take a line holding a NUL, a `` `u `` or a dash before a unit past ASCII. A native program's
 * command line on Windows is one C string, so a NUL ends the word and the words after it (`line`, measured on 5.1,
 * reasoned for pwsh). On other hosts each argument is a C string of its own (`word`, reasoned, no pwsh here). A cmdlet
 * keeps the NUL in its string (`kept`), and `Invoke-Expression` then reads the text after it, so a cut there would hide
 * a command. The dash goes by the version, as `` `u `` does; see {@link Reading.asciiParameters}.
 */
const POWERSHELL_READINGS = [
    { codePoints: false, nul: 'line', asciiParameters: true },
    { codePoints: false, nul: 'kept', asciiParameters: true },
    { codePoints: true, nul: 'line', asciiParameters: false },
    { codePoints: true, nul: 'word', asciiParameters: false },
    { codePoints: true, nul: 'kept', asciiParameters: false },
];
/** The reading of a line with nothing to choose between. */
function plainReading(source) {
    return { source, codePoints: false, nul: 'kept', asciiParameters: false, caretLine: 'joins' };
}
/**
 * The readings of a line. cmd drops every CR before it reads anything. bash on Windows does the same, by `-c`, file
 * and stdin alike, while bash elsewhere keeps a CR in its word, so a bash line holding one is read both ways. PowerShell
 * takes {@link POWERSHELL_READINGS} when the line holds what they differ on. cmd's caret before a newline is read both
 * ways, as the entry decides it. Which host, version or entry the line runs on is not asked: a guard's answer must not
 * depend on it.
 */
function readingsOf(source, dialect) {
    const plain = plainReading(source);
    const dropped = plainReading(source.replaceAll('\r', ''));
    switch (dialect) {
        case 'bash':
            return source.includes('\r') ? [dropped, plain] : [plain];
        case 'powershell':
            return /\0|`[0u]|[-\u2013\u2014\u2015][^\0-\x7f]/.test(source) ? POWERSHELL_READINGS.map((reading) => ({ ...plain, ...reading })) : [plain];
        case 'cmd':
            return dropped.source.includes('^\n') ? [dropped, { ...dropped, caretLine: 'ends' }] : [dropped];
    }
}
/**
 * One parse from the parses of a line's readings. Readings that agree count once; ones that differ all count, so every
 * guard sees each command any of them runs, and the line is not read with confidence. Each then sits in a subshell of
 * its own, numbered below the scanner's ids, so a relative `cd` in one does not move the next.
 */
function mergedParse(parses) {
    const distinct = [...new Map(parses.map((parse) => [JSON.stringify([parse.commands, parse.unreadBodies]), parse])).values()];
    const single = distinct.length === 1;
    const readings = single ? distinct : distinct.map((parse, at) => ({ ...parse, commands: parse.commands.map((command) => ({ ...command, subshells: [-1 - at, ...command.subshells] })) }));
    return {
        commands: readings.flatMap((parse) => parse.commands),
        complete: single && parses.every((parse) => parse.complete),
        skipped: parses.some((parse) => parse.skipped),
        unreadBodies: readings.flatMap((parse) => parse.unreadBodies),
        bindingsUnclear: parses.some((parse) => parse.bindingsUnclear),
        ...(single ? {} : { readings }),
    };
}
/**
 * Splits a command line into simple commands the way `dialect` would; see {@link Scanner}. Where the same text means
 * different words in different hosts or versions of the shell, the parse holds the commands of every reading.
 */
export function parseShell(command, dialect) {
    return mergedParse(readingsOf(command, dialect).map((reading) => new Scanner(reading, dialect, { nesting: 0, subshells: [], ids: { next: 0 } }).parse()));
}
/**
 * The commands bash runs when an expansion reads a word's {@link ShellWord.held} text again: the substitutions
 * in it, read as in an unquoted heredoc's body, where quotes are plain text and a backslash keeps a `$`.
 * bash expands that text left to right, so where it never closes bash stops at the error after running the
 * substitutions before it, which the commands hold; only {@link ShellParse.skipped} text may hide one.
 */
export function parseHeldText(held) {
    return new Scanner(plainReading(held), 'bash', { nesting: 0, subshells: [], ids: { next: 0 } }).parseExpandable();
}
/** What may stand before the `=` of a PowerShell assignment that has no target in the same word. */
const ASSIGNMENT_PREFIX = /^(?:[-+*/%]|\?\?)?$/;
/**
 * Where a word's first `=` outside any bracket or quote sits, so the `=` in `$w[$i=0]=a`, `${a=b}=a` or `$h."a=b"=a` is
 * the last one. A member chain keeps its source, quotes included.
 */
function assignmentAt(text) {
    let depth = 0;
    let quote;
    for (let index = 0; index < text.length; index += 1) {
        const char = text.charAt(index);
        if (quote !== undefined) {
            quote = quote.test(char) ? undefined : quote;
            continue;
        }
        if (char === '=' && depth === 0) {
            return index;
        }
        quote = [POWERSHELL_QUOTES.single, POWERSHELL_QUOTES.double].find((marks) => marks.test(char));
        depth += /[[({]/.test(char) ? 1 : /[\])}]/.test(char) ? -1 : 0;
    }
    return undefined;
}
/**
 * Whether a PowerShell word at a statement's start can only be an expression: a `[Type]`, or anything else only known
 * when it runs. Nothing but `&` makes a program of one.
 */
export function isExpressionHead(word) {
    return word.dynamic || word.text.startsWith('[');
}
/**
 * PowerShell: the words an assignment's right side runs, when `words` open with one, else undefined. A target is any
 * expression with a member or an index, on a variable, a quote, a group, a block or a `[Type]`, and a list of them
 * (`$p, $q = ...`) is one too, all measured to run the right side; casts before the first are skipped. Only a target at
 * the start opens one: a bare `=` among a program's arguments is text.
 */
export function assignedWords(words) {
    for (const [index, word] of words.entries()) {
        const text = index === 0 ? word.text.replace(/^(?:\[[^\]]+\])+/, '') : word.text;
        const at = assignmentAt(text);
        const left = text.slice(0, at);
        const target = isExpressionHead(word);
        if (at === undefined) {
            if (target) {
                continue;
            }
            return undefined;
        }
        if (!target && (index === 0 || !ASSIGNMENT_PREFIX.test(left))) {
            return undefined;
        }
        const right = text.slice(at + 1);
        const rest = words.slice(index + 1);
        return right === '' ? rest : [{ text: right, dynamic: /[$@]/.test(right) }, ...rest];
    }
    return undefined;
}
/** What opens a PowerShell statement whose `( )` and `{ }` are its own parts, never arguments, in lower case. */
const STATEMENT_KEYWORDS = new Set([
    'if', 'elseif', 'else', 'while', 'until', 'do', 'for', 'foreach', 'switch', 'try', 'catch', 'finally', 'function', 'filter', 'workflow', 'configuration',
    'trap', 'class', 'enum', 'data', 'param', 'begin', 'process', 'end', 'clean', 'dynamicparam', 'parallel', 'sequence', 'inlinescript',
]);
/**
 * PowerShell: whether a `(` or `{` after `words` is an argument of their command. It is not at a statement's start,
 * where `(` is a group, nor after a keyword, whose block ends the statement: `do {} while (0) git push` runs what
 * follows. A block called at once (`& { ... }`) reads as a group too: its commands are all it runs, where a word would
 * leave the program unknown.
 */
function takesArguments(words, open) {
    let statement = words[0]?.text.startsWith(':') === true ? words.slice(1) : words;
    for (let right = assignedWords(statement); right !== undefined; right = assignedWords(statement)) {
        statement = right;
    }
    const head = statement[0];
    if (head === undefined || (open === '{' && statement.length === 1 && (head.text === '&' || head.text === '.'))) {
        return false;
    }
    return head.dynamic || !STATEMENT_KEYWORDS.has(head.text.toLowerCase());
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
    cut = false;
    tracksParts;
    cutsAtNul;
    /** `cutsAtNul`: the word's value ends at a NUL, and what comes after it in the word is read but adds nothing. */
    constructor(tracksParts, cutsAtNul = false) {
        this.tracksParts = tracksParts;
        this.cutsAtNul = cutsAtNul;
    }
    get isStarted() {
        return this.started;
    }
    /** True once a NUL ended the word's value. */
    get isCut() {
        return this.cut;
    }
    get value() {
        return this.text;
    }
    get isDynamic() {
        return this.dynamic;
    }
    /** Adds text; a piece read through a quote or an escape is `quoted`, as is any text outside bash. */
    add(chars, piece = 'quoted') {
        if (this.cut) {
            return;
        }
        const nul = this.cutsAtNul ? chars.indexOf('\0') : -1;
        const kept = nul === -1 ? chars : chars.slice(0, nul);
        this.cut = nul !== -1;
        this.text += kept;
        this.literal += piece === 'dynamic' ? '' : kept;
        this.started = true;
        this.dynamic ||= piece === 'dynamic';
        if (this.parts !== undefined) {
            this.parts = piece === 'dynamic' ? undefined : withText(this.parts, kept, piece === 'quoted');
        }
    }
    /** Adds a `$` expansion as written; a plain variable stays a part, `quoted` inside double quotes or an expanding body. */
    addDollar(written, quoted) {
        if (this.cut) {
            return;
        }
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
        this.cut = false;
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
 * (the substitutions an unquoted one expands are read); a PowerShell here-string is one word. A PowerShell word
 * that starts with a quote, a here-string, `$(` or `@(` ends where that closes, so what touches it is a new word.
 * In PowerShell a `( )`, `{ }` or `@{ }` among a command's arguments is one more word, not a group, with its commands
 * read; each value takes a chain of members and indexes, and a `-name:` token takes the value that touches it. Where a
 * NUL cuts a word, what follows it is still read, as a substitution there runs and a separator still applies.
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
    /** How many bash `${...}`, `$((...))` and `$[...]` or PowerShell `[...]` the reader is inside, bounded like substitutions. */
    expansions = 0;
    subshells;
    ids;
    reading;
    source;
    dialect;
    constructor(reading, dialect, scope) {
        this.reading = reading;
        this.source = reading.source;
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
        this.readList();
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
    /**
     * Reads commands to the end or, inside a substitution or a PowerShell block, through the `close` that ends it. `hash`
     * says the list is a `@{ }`, whose entries open with a key.
     */
    readList(close, hash = false) {
        const powershell = this.dialect === 'powershell';
        let words = [];
        const word = new WordBuilder(this.dialect === 'bash', this.reading.nul !== 'kept');
        /** The operator of a redirection whose target is the next word. */
        let awaiting;
        let verbatim = false;
        /** True once a NUL ended this command's line: the words after it never reach the program. */
        let lineCut = false;
        let redirections = [];
        let depth = 0;
        /** PowerShell: how many `{ }` of keywords are open here, so `{if (1) {a}}` closes at its last `}`. */
        let blocks = 0;
        /** PowerShell: where the value of a `-name:` token opens, which joins the token's word. */
        let valueAt = -1;
        /** True at a `@{ }` entry's start, where its key and `=` come before its statement. */
        let keyNext = hash;
        const atEntry = () => hash && depth === 0 && blocks === 0;
        /** The depth a bash `((` arithmetic command opened at: inside it `<<` shifts and starts no heredoc. */
        let arithmetic;
        /**
         * The command a `( )` group closed on, until the command after its `)` ends: redirections there belong
         * to the group, so they join that command, as those after a `{ }` group's `}` join the `}` command.
         */
        let closedGroup;
        /** A word the NUL left empty is no argument, as the line ends before it: `x <NUL> a` hands the program nothing. */
        const addWord = (taken, cut) => {
            const endsLine = cut && this.reading.nul === 'line';
            if (!lineCut && !(endsLine && taken.text === '')) {
                words.push(taken);
            }
            lineCut ||= endsLine;
        };
        const endWord = () => {
            const cut = word.isCut;
            const taken = word.take();
            if (taken === undefined) {
                return;
            }
            if (awaiting === undefined) {
                addWord(taken, cut);
                // Set on a word the cut dropped too: the shell still reads the rest as written.
                verbatim = this.dialect === 'powershell' && taken.text === '--%' && !taken.dynamic && !cut;
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
            lineCut = false;
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
                this.readVerbatim(addWord);
                verbatim = false;
                continue;
            }
            if (keyNext) {
                keyNext = false;
                this.readHashKey();
                continue;
            }
            const char = this.at();
            if (char === close && (close === '}' ? blocks : depth) === 0) {
                this.index += 1;
                endCommand();
                return;
            }
            const parameter = powershell && !word.isStarted ? this.parameterEnd() : undefined;
            if (parameter !== undefined) {
                word.add(this.source.slice(this.index, parameter), 'unquoted');
                this.index = parameter;
                valueAt = parameter;
                continue;
            }
            const opening = powershell && (!word.isStarted || this.index === valueAt);
            const whole = opening && this.opensWholeWord(char);
            const variable = opening && char === '$';
            const inArguments = words.length > 0 || awaiting !== undefined;
            if (this.readQuoteOrExpansion(word, opening)) {
                if (whole) {
                    this.readMembers(word);
                    endWord();
                    // Text in quotes is only text: `'--%'` is no marker, though `--'%'` is.
                    verbatim = false;
                }
                else if (variable && word.isDynamic && (this.readMembers(word) || this.at() === '.') && inArguments) {
                    // At a head the word goes on: `$h.a=git push` is an assignment, read from one word. A dot with no name after
                    // it starts a word of its own, as a quote's does: `$v. b` reaches a program as three words.
                    endWord();
                }
                continue;
            }
            if (this.endsLine(char)) {
                endCommand();
                // Written as a newline whichever character it was: the guards find a pipe across lines by `\n` alone.
                this.addTerminator('\n');
                this.index += 1;
                this.readHeredocBodies();
                keyNext = atEntry();
                continue;
            }
            if (powershell && this.atBlock() && (opening || char !== '@')) {
                if (this.index !== valueAt) {
                    endWord();
                }
                if (verbatim) {
                    continue;
                }
                if (char === '@' || this.index === valueAt || awaiting !== undefined || takesArguments(words, char)) {
                    const start = this.index;
                    this.readBlock();
                    word.add(this.source.slice(start, this.index), 'dynamic');
                    this.readMembers(word);
                    endWord();
                    continue;
                }
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
            else if (!word.isStarted && this.isCallOperator(char, words)) {
                words.push({ text: '&', dynamic: false });
            }
            else if (this.isSeparator(char)) {
                endCommand();
                this.addTerminator(char);
                blocks += char === '{' ? 1 : char === '}' ? -1 : 0;
                keyNext = char === ';' && atEntry();
            }
            else if (char === '#' && !word.isStarted && this.dialect !== 'cmd') {
                this.skipComment();
                continue;
            }
            else if (this.opensRedirection(char, word)) {
                if (this.readProcessSubstitution(word)) {
                    continue;
                }
                // A file-descriptor number (`2>`), PowerShell's `*>` or bash's `{NAME}>` belongs to the redirection.
                const named = this.dialect === 'bash' && /^\{[A-Za-z_]\w*\}$/.test(word.value);
                let descriptor = '';
                if (char !== '&' && word.isStarted && (named || DESCRIPTOR.test(word.value))) {
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
            else if (BLANKS[this.dialect].test(char)) {
                endWord();
            }
            else if (char === ',' && this.dialect === 'powershell') {
                // An unquoted comma builds an array: each element reaches a native program as its own argument.
                endWord();
            }
            else if (char === '@' && this.dialect === 'cmd' && words.length === 0 && !word.isStarted) {
                // cmd's `@` before a command only hides its echo.
            }
            else if (char === ']' && powershell && !word.isStarted) {
                // Measured: a `]` first is a word of its own, so `]--no-verify` hands the program two words.
                word.add(char, 'unquoted');
                endWord();
            }
            else if (char === '\0' && powershell) {
                // Measured: a NUL outside quotes ends the word and leads the next one.
                endWord();
                word.add(char, 'unquoted');
            }
            else {
                if (this.dialect === 'bash') {
                    word.noteBrace(char);
                }
                word.add(char, 'unquoted');
            }
            this.index += 1;
            if (powershell && (char === ')' || char === '}')) {
                // `(1).a = git push` and `{x}.a = git push` run their right side: the chain is the target's, no program.
                this.readMembers(word);
            }
        }
        endCommand();
        if (close !== undefined || depth > 0) {
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
                this.readPowerShellEscape(word);
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
    /**
     * PowerShell, where a word's value opens: true at what ends the word when it closes, a quote, a here-string, `$(` or
     * `@(`, so `"a"--flag` is two words. A variable, a number or a splat first stays one word, as text in the middle of a
     * word does. `( )`, `{ }` and `@{ }` end theirs too, read by {@link readBlock}.
     */
    opensWholeWord(char) {
        if (this.dialect !== 'powershell') {
            return false;
        }
        const substitution = (char === '$' || char === '@') && this.at(1) === '(';
        return substitution || this.isSingleQuote(char) || this.isDoubleQuote(char) || (char === '@' && this.hereStringBody() !== undefined);
    }
    /** At `@`: where the body of a PowerShell here-string starts, when `@` and a quote mark end their line and so open one. */
    hereStringBody() {
        const quote = this.at(1);
        if (!this.isSingleQuote(quote) && !this.isDoubleQuote(quote)) {
            return undefined;
        }
        const opener = new RegExp(`${BLANKS.powershell.source}*(?:\\r\\n?|\\n)`, 'y');
        opener.lastIndex = this.index + 2;
        return opener.test(this.source) ? opener.lastIndex : undefined;
    }
    /**
     * PowerShell `@'...'@` (literal) and `@"..."@` (expandable), whose body opens at `start`: the lines up to the first
     * line that starts with a mark of the opener's class and `@`, with no blank before it. One that never closes takes
     * the rest.
     */
    readHereString(word, start) {
        const expands = this.isDoubleQuote(this.at(1));
        const closing = new RegExp(`(?:\\r\\n?|\\n)${(expands ? POWERSHELL_QUOTES.double : POWERSHELL_QUOTES.single).source}@`, 'g');
        // From the opener's own line end, so an empty body closes on it.
        closing.lastIndex = start - 1;
        const close = closing.exec(this.source);
        const end = close === null ? this.source.length : Math.max(start, close.index);
        this.index = start;
        if (expands) {
            this.readExpandable(word, end);
        }
        else {
            word.add(this.source.slice(start, end));
        }
        this.complete &&= close !== null;
        this.index = close === null ? this.source.length : Math.max(this.index, close.index + close[0].length);
    }
    /** PowerShell's `&` at a command's start, or an assignment's right side, calls the program named next; elsewhere `&` separates commands. */
    isCallOperator(char, words) {
        return this.dialect === 'powershell' && char === '&' && this.at(1) !== '&' && this.at(-1) !== '&' && (words.length === 0 || assignedWords(words)?.length === 0);
    }
    /**
     * True at what starts a redirection. In PowerShell `<` and `>` are word text inside a word, measured on its parser
     * (T2002): `a>b c` hands the program `a>b` and `c`. Only a word of a descriptor alone gives way to one.
     */
    opensRedirection(char, word) {
        if (char === '<' || char === '>') {
            return this.dialect !== 'powershell' || !word.isStarted || DESCRIPTOR.test(word.value);
        }
        return this.isOutputAndErrorRedirection(char);
    }
    /** bash `&>` and `&>>` send stdout and stderr to a file: a redirection, where `&&>` and `|&>` end a command first. */
    isOutputAndErrorRedirection(char) {
        return this.dialect === 'bash' && char === '&' && this.at(1) === '>' && this.at(-1) !== '&' && this.at(-1) !== '|';
    }
    /** A newline ends a statement in every shell, and in PowerShell so does a lone CR. */
    endsLine(char) {
        return char === '\n' || (char === '\r' && this.dialect === 'powershell');
    }
    isSingleQuote(char) {
        return this.dialect === 'powershell' ? POWERSHELL_QUOTES.single.test(char) : char === "'";
    }
    isDoubleQuote(char) {
        return this.dialect === 'powershell' ? POWERSHELL_QUOTES.double.test(char) : char === '"';
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
    readQuoteOrExpansion(word, opening) {
        switch (this.dialect) {
            case 'bash':
                return this.readBashQuote(word);
            case 'powershell':
                return this.readPowerShellQuote(word, opening);
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
    /** `opening` is true where a word's value may open: a here-string or an `@(` only opens there, `a@(b)` being text and a value. */
    readPowerShellQuote(word, opening) {
        const char = this.at();
        const hereStringBody = char === '@' && opening ? this.hereStringBody() : undefined;
        if (this.isSingleQuote(char)) {
            this.readSingleQuoted(word);
        }
        else if (this.isDoubleQuote(char)) {
            this.readDoubleQuoted(word);
        }
        else if (char === '`') {
            this.readPowerShellEscape(word);
        }
        else if (char === '$') {
            this.readDollar(word, false);
        }
        else if (hereStringBody !== undefined) {
            this.readHereString(word, hereStringBody);
        }
        else if (char === '@' && ((this.at(1) === '(' && opening) || (/[A-Za-z_]/.test(this.at(1)) && !word.isStarted))) {
            this.readSplatOrArray(word);
        }
        else if (char === '<' && this.at(1) === '#' && !word.isStarted) {
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
    /** `'...'`: literal; in PowerShell a doubled mark inside keeps its second. An unclosed quote takes the rest of the line. */
    readSingleQuoted(word) {
        this.index += 1;
        let text = '';
        while (!this.done) {
            const char = this.at();
            if (this.isSingleQuote(char)) {
                if (this.dialect === 'powershell' && this.isSingleQuote(this.at(1))) {
                    text += this.at(1);
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
    /** `"..."`: expansions inside stay dynamic; bash escapes with `\`, PowerShell with a backtick or a doubled mark, which keeps its second, cmd not at all. */
    readDoubleQuoted(word) {
        this.index += 1;
        word.add('');
        while (!this.done) {
            const char = this.at();
            if (this.isDoubleQuote(char)) {
                if (this.dialect === 'powershell' && this.isDoubleQuote(this.at(1))) {
                    word.add(this.at(1));
                    this.index += 2;
                    continue;
                }
                this.index += 1;
                return;
            }
            if (this.dialect === 'cmd' && char === '\n') {
                // cmd ends the line here, quote or no quote: left in place, it ends the command too.
                return;
            }
            if (this.dialect === 'bash' && char === '\\' && /["\\$`\n]/.test(this.at(1))) {
                word.add(this.at(1) === '\n' ? '' : this.at(1));
                this.index += 2;
            }
            else if (this.dialect === 'powershell' && char === '`') {
                this.readPowerShellEscape(word);
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
    /**
     * The escape character (`\` or `^`) keeps the next character; before a newline it joins the lines, or leaves the
     * newline to end the line where the reading says so. With nothing after it, cmd drops its caret and bash keeps its
     * backslash.
     */
    readEscape(word) {
        const next = this.at(1);
        if (next === '\n') {
            this.index += this.reading.caretLine === 'ends' ? 1 : 2;
            return;
        }
        if (next === '' && this.dialect === 'cmd') {
            this.index += 1;
            return;
        }
        word.add(next === '' ? this.at() : next);
        this.index += 2;
    }
    /**
     * At a backtick: the text of a `u{hex}` and where it ends, in a reading that takes one. Anything else there is an
     * error on pwsh, so nothing runs and the letter stands.
     */
    matchCodePoint() {
        const end = this.reading.codePoints ? this.matchEnd(CODE_POINT) : undefined;
        if (end === undefined) {
            return undefined;
        }
        const value = Number.parseInt(this.source.slice(this.index + '`u{'.length, end - 1), 16);
        return value > MAX_CODE_POINT ? undefined : { text: String.fromCodePoint(value), end };
    }
    /**
     * PowerShell's backtick, measured on 5.1 (T2002). Between words it continues the line, whichever line end follows. In a
     * word or quotes it keeps ONE character, so `a<backtick><CR><LF>b c` is the word `a<CR>`, then the LF ends the statement
     * and `b c` runs. With nothing after it, or a NUL, the backtick stays. pwsh alone also reads a code point.
     */
    readPowerShellEscape(word) {
        const next = this.at(1);
        if (!word.isStarted && /[\n\r]/.test(next)) {
            this.index += next === '\r' && this.at(2) === '\n' ? 3 : 2;
            return;
        }
        if (next === '' || next === '\0') {
            word.add(this.at());
            this.index += 1;
            return;
        }
        const codePoint = this.matchCodePoint();
        if (codePoint !== undefined) {
            word.add(codePoint.text);
            this.index = codePoint.end;
            return;
        }
        word.add(POWERSHELL_ESCAPES.get(next) ?? next);
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
        const variable = this.dialect === 'powershell' ? this.matchEnd(VARIABLE) : undefined;
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
        else if (variable !== undefined) {
            this.index = variable;
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
    /**
     * Inside `$(`, `@(`, `<(` or a PowerShell value: reads the commands through the `close` that ends it; in bash they run
     * in a subshell.
     */
    readSubstitution(close = ')', hash = false) {
        if (this.nesting >= MAX_NESTING) {
            this.skip();
            this.index = this.source.length;
            return;
        }
        this.nesting += 1;
        if (this.dialect === 'bash') {
            this.openSubshell();
        }
        this.readList(close, hash);
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
    /** Counts one more expansion or PowerShell expression the reader is inside; false, with the line unreadable, when they nest too deep. */
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
            const nested = new Scanner(plainReading(inner), 'bash', { nesting: this.nesting + 1, subshells, ids: this.ids }).scan();
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
    /** Where the sticky `pattern` ends when it matches at the cursor. */
    matchEnd(pattern) {
        pattern.lastIndex = this.index;
        return pattern.test(this.source) ? pattern.lastIndex : undefined;
    }
    /** Where a `-name:` token ends at the cursor, if this reading opens one there; see {@link Reading.asciiParameters}. */
    parameterEnd() {
        const end = this.matchEnd(PARAMETER);
        return end !== undefined && this.reading.asciiParameters && /[^\0-\x7f]/.test(this.at(1)) ? undefined : end;
    }
    /** PowerShell: true at a `(`, `{` or `@{`. */
    atBlock() {
        const char = this.at();
        return char === '(' || char === '{' || (char === '@' && this.at(1) === '{');
    }
    /** PowerShell, at a `(`, `{` or `@{`: reads the commands inside, which run or may run, like a substitution's. */
    readBlock() {
        const open = this.at();
        this.index += open === '@' ? 2 : 1;
        this.readSubstitution(open === '(' ? ')' : '}', open === '@');
    }
    /** PowerShell: reads a chain of members and indexes into `word`, only known when it runs; true when one is there. */
    readMembers(word) {
        const start = this.index;
        let read = false;
        while (this.readMember()) {
            read = true;
        }
        if (read) {
            word.add(this.source.slice(start, this.index), 'dynamic');
        }
        return read;
    }
    /**
     * One link of a chain: `[...]`, or `.` or `::` then a name, a method's `(...)` or `{...}` after it. A dot or a colon
     * with no name after it is plain text: false, the cursor where it was.
     */
    readMember() {
        if (this.at() === '[') {
            this.index += 1;
            this.readExpression(']');
            return true;
        }
        const start = this.index;
        this.index += this.at() === '.' ? 1 : this.at() === ':' && this.at(1) === ':' ? 2 : 0;
        if (this.index === start || !this.readMemberName()) {
            this.index = start;
            return false;
        }
        if (this.at() === '(') {
            this.index += 1;
            this.readExpression(')');
        }
        else if (this.at() === '{') {
            this.readBlock();
        }
        return true;
    }
    /** A member's name: a plain name, a quote, a `(...)` or a variable, whose expression runs. */
    readMemberName() {
        const char = this.at();
        if (char === '(') {
            this.readBlock();
            return true;
        }
        if (char === '$' || this.isSingleQuote(char) || this.isDoubleQuote(char)) {
            return this.readPowerShellQuote(new WordBuilder(false), true);
        }
        const end = this.matchEnd(MEMBER_NAME);
        if (end === undefined) {
            return false;
        }
        this.index = end;
        return true;
    }
    /**
     * Inside a PowerShell `[...]` or a method's `(...)`, through the `close`: bare text there is no command, so none is
     * listed, while the quotes, substitutions and blocks in it run. A fresh word each time, as a started one reads `<#` as text.
     */
    readExpression(close) {
        if (!this.enterExpansion()) {
            return;
        }
        while (!this.done && this.at() !== close) {
            if (this.at() === '#') {
                this.skipComment();
            }
            else if (this.at() === '[') {
                this.index += 1;
                this.readExpression(']');
            }
            else if (this.atBlock()) {
                this.readBlock();
            }
            else if (!this.readPowerShellQuote(new WordBuilder(false), true)) {
                this.index += 1;
            }
        }
        this.complete &&= !this.done;
        this.index = Math.min(this.index + 1, this.source.length);
        this.expansions -= 1;
    }
    /**
     * At a `@{ }` entry: moves past its key and `=`, so the statement after it reads as a command's start, whose words the
     * key would else open. The key may be a quote or a `(...)`, whose commands run. A line that shows no `=` and ran nothing
     * is the next line of the statement before, as in `@{a = b |` and a line under it: the cursor goes back.
     */
    readHashKey() {
        this.skipGaps();
        const start = this.index;
        const listed = this.commands.length;
        while (!this.done && !/[=;}]/.test(this.at()) && !BLANKS.powershell.test(this.at()) && !this.endsLine(this.at())) {
            if (this.atBlock()) {
                this.readBlock();
            }
            else if (!this.readPowerShellQuote(new WordBuilder(false), true)) {
                this.index += 1;
            }
        }
        this.skipGaps();
        if (this.at() === '=') {
            this.index += 1;
            this.skipGaps();
        }
        else if (this.commands.length === listed) {
            this.index = start;
        }
    }
    /** Moves past blanks, line ends and comments, which may sit around a `@{ }` entry's key and `=`. */
    skipGaps() {
        while (!this.done) {
            const char = this.at();
            if (char === '#') {
                this.skipComment();
            }
            else if (char === '<' && this.at(1) === '#') {
                this.skipBlockComment();
            }
            else if (BLANKS.powershell.test(char) || this.endsLine(char)) {
                this.index += 1;
            }
            else {
                return;
            }
        }
    }
    /**
     * cmd `%VAR%`, `%1`, `%*`, `%~dp0` and delayed `!VAR!` are dynamic; `%%` is one literal `%`, and a `%` or `!`
     * that starts none of them is literal. Text from `end` on is not looked at.
     */
    readCmdVariable(word, end = this.source.length) {
        const rest = this.source.slice(this.index, end);
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
        while (!this.done && !this.endsLine(this.at())) {
            this.index += 1;
        }
    }
    /** PowerShell `<# ... #>`; an unclosed one runs to the end. */
    skipBlockComment() {
        const close = this.source.indexOf('#>', this.index + 2);
        this.index = close === -1 ? this.source.length : close + 2;
    }
    /**
     * After PowerShell's `--%`: the text up to {@link verbatimEnd} goes to the program as written, with cmd-style `%VAR%`
     * left dynamic. The shell no longer splits it, so the program does, on a space or a tab, and only a plain `"` groups.
     * Each word goes to `addWord`, with whether a NUL cut it.
     */
    readVerbatim(addWord) {
        const end = this.verbatimEnd();
        const word = new WordBuilder(false, this.reading.nul !== 'kept');
        const flush = () => {
            const cut = word.isCut;
            const taken = word.take();
            if (taken !== undefined) {
                addWord(taken, cut);
            }
        };
        let grouped = false;
        while (this.index < end) {
            const char = this.at();
            if (char === '%') {
                this.readCmdVariable(word, end);
                continue;
            }
            if (char === '"') {
                grouped = !grouped;
                word.add('');
            }
            else if (!grouped && BLANKS.cmd.test(char)) {
                flush();
            }
            else {
                word.add(char);
            }
            this.index += 1;
        }
        flush();
    }
    /**
     * Where the text after `--%` ends: a line end, even inside quotes, or a `|` or `&&` outside them. This is the shell
     * looking, not the program, so a curly double quote counts here, and a `%` means nothing: `%a|b%` ends at the `|`.
     */
    verbatimEnd() {
        let inQuotes = false;
        for (let end = this.index; end < this.source.length; end += 1) {
            const char = this.source.charAt(end);
            if (this.endsLine(char) || (!inQuotes && (char === '|' || this.source.startsWith('&&', end)))) {
                return end;
            }
            inQuotes = inQuotes !== this.isDoubleQuote(char);
        }
        return this.source.length;
    }
}
