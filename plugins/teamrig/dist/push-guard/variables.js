/**
 * bash keywords and builtins that can set a variable in a way this module does not follow (`case`, a
 * function, `read`, `declare`, arithmetic) or run code that can (`eval`, `source`, `trap`). One anywhere in
 * a line keeps every variable of that line unresolved, except the keywords of a `for`, `while` or `until`
 * loop, an `if`, a `{ }` group and a `!` where they start a command (see {@link Compounds}).
 */
const UNSAFE_PROGRAMS = new Set([
    ...['if', 'then', 'elif', 'else', 'fi', 'for', 'while', 'until', 'do', 'done', 'case', 'esac', 'select', 'function'],
    ...['{', '}', '[[', ']]', '!', 'time', 'coproc'],
    ...['read', 'readarray', 'mapfile', 'getopts', 'let', 'declare', 'typeset', 'local', 'readonly', 'unset', 'wait'],
    ...['eval', 'source', '.', 'trap', 'command', 'builtin', 'enable', 'alias', 'unalias', 'shopt', 'compgen', 'complete', 'fc'],
]);
/** Variables bash itself sets or reads in a special way; a line never resolves them. */
const SHELL_NAMES = new Set([
    ...['_', 'IFS', 'PWD', 'OLDPWD', 'RANDOM', 'SRANDOM', 'SECONDS', 'LINENO', 'EPOCHSECONDS', 'EPOCHREALTIME', 'HISTCMD'],
    ...['FUNCNAME', 'GROUPS', 'DIRSTACK', 'PIPESTATUS', 'REPLY', 'OPTARG', 'OPTIND', 'OPTERR', 'SHLVL', 'UID', 'EUID', 'PPID'],
    ...['HOSTNAME', 'HOSTTYPE', 'MACHTYPE', 'OSTYPE', 'SHELLOPTS', 'MAPFILE', 'COPROC', 'COLUMNS', 'LINES'],
]);
const SHELL_PREFIXES = /^(?:BASH|COMP_|READLINE_)/;
const NAME = /^[A-Za-z_]\w*$/;
/** Unquoted value text bash assigns as written: no blank, glob, tilde, quote, `$`, `=` or shell operator. */
const UNQUOTED_VALUE = /^[A-Za-z0-9._/:+@-]*$/;
/** Text that makes an unquoted expansion a file name pattern: a glob, an extglob group or a backslash. */
const PATTERN_TEXT = /[*?[(\\]/;
/** The blanks bash splits an unquoted expansion at; a line that sets IFS resolves nothing. */
const FIELD_BREAKS = /[ \t\n]+/;
/** A word that looks like an assignment, quoted or not: `NAME=`, `NAME+=` or `NAME[`. */
const ASSIGNMENT_LIKE = /^([A-Za-z_]\w*)(\[|\+?=)/;
/** `NAME=` at the start of a word: an `export` argument that sets that one name. */
const SETS_NAME = /^([A-Za-z_]\w*)=/;
/** A `{NAME}` word, as in `exec {NAME}>file`, which stores a file descriptor number in NAME. */
const NAMED_FD = /^\{([A-Za-z_]\w*)\}$/;
const OPERATOR_LINKS = new Map([
    [';', 'sequence'],
    ['&&', 'and'],
    ['||', 'or'],
    ['|', 'pipe'],
    ['|&', 'pipe'],
    ['&', 'background'],
]);
/**
 * Replaces each plain `$NAME` or `${NAME}` in a parsed bash line's commands with the value an earlier binding
 * statement of the same line provably gave it (see {@link LiteralBindings}), split into words where bash splits
 * it. A word with a variable left unresolved stays as it was; a resolved word has no parts, and is dynamic only
 * where the value holds a variable only known when it runs. `home` is the folder HOME names when the line
 * starts, given where the caller knows it: then `$HOME`, and a value's leading `~`, which bash expands to it,
 * resolve too while the line assigns HOME nowhere.
 */
export function resolveLiteralVariables(parsed, home) {
    return (parsed.readings ?? [parsed]).flatMap((reading) => {
        const bindings = LiteralBindings.read(reading, home);
        return reading.commands.map((command, index) => ({ ...command, words: bindings.resolveWords(command.words, index) }));
    });
}
/**
 * The values a bash line gives its variables, and where they surely hold. It trusts only a binding statement
 * (a command of nothing but `NAME=value` words, or `export` with such words and bare names), with no
 * redirection, whose value is unquoted text bash keeps as written, a leading `~` or `~/`, quoted text and plain
 * variables (in quotes, for `export`), and only for a name the line sets nowhere else, or always to the same
 * text. A name also assigned in any other form (`NAME=x cmd`, `NAME+=`, `{NAME}>`, a value with a substitution
 * or any other tilde, a `for` loop's variable, a binding inside a compound command or after `!`) is not
 * resolved; anything that can set variables unseen (see {@link UNSAFE_PROGRAMS}, a program a variable names that
 * is not known or is one of those, array elements, IFS, and what {@link ShellParse.bindingsUnclear} flags)
 * leaves the whole line unresolved. A value holds at a later command only when that command surely runs after
 * the statement, in the same shell or in a subshell started after it; a variable in a value gives what it held
 * when the statement ran, and HOME, which the line never assigns, what the shell started with.
 */
class LiteralBindings {
    commands;
    bound;
    /** The values names the line never assigns hold from its start: HOME, when the caller knows it. */
    inherited;
    constructor(commands, bound, inherited) {
        this.commands = commands;
        this.bound = bound;
        this.inherited = inherited;
    }
    static read(parsed, home) {
        const none = new LiteralBindings(parsed.commands, new Map(), new Map());
        const line = parsed.bindingsUnclear ? undefined : boundNames(parsed.commands);
        if (line === undefined) {
            return none;
        }
        // A Windows home goes to bash with forward slashes, which keep an unquoted `$HOME` from reading as a pattern.
        const inherited = home === undefined || line.assigned.has('HOME') ? new Map() : new Map([['HOME', home.replaceAll('\\', '/')]]);
        const bindings = new LiteralBindings(parsed.commands, line.bound, inherited);
        const unseen = line.deferred.some(({ index, words }) => expandedSetsVariablesUnseen(bindings.resolveWords(words, index)));
        return unseen ? none : bindings;
    }
    /** The words of command `index` with their variables replaced by the values that hold there. */
    resolveWords(words, index) {
        return words.flatMap((word) => this.resolve(word, index));
    }
    /** The words `word` becomes at command `index`, or `word` itself when a variable in it does not resolve. */
    resolve(word, index) {
        if (!word.dynamic || word.parts === undefined) {
            return [word];
        }
        const fields = new Fields();
        for (const part of word.parts) {
            const value = part.kind === 'text' ? undefined : this.valueAt(part.name, index);
            if (part.kind === 'text') {
                fields.addText(part.text, part.quoted);
            }
            else if (value === undefined || !fields.addValue(value, part.quoted)) {
                return [word];
            }
        }
        const words = fields.finish();
        return words.length > 0 ? words : [word];
    }
    /** The value `name` holds at command `index`; a variable in it gives what it held when its statement ran. */
    valueAt(name, index) {
        const inherited = this.inherited.get(name);
        if (inherited !== undefined) {
            return [{ kind: 'text', text: inherited }];
        }
        const bound = this.bound.get(name);
        const at = bound?.at.find((statement) => statement < index && this.reaches(statement, index));
        if (bound === undefined || at === undefined) {
            return undefined;
        }
        return bound.value.flatMap((part) => part.kind === 'text' ? [part] : (this.valueAt(part.name, at) ?? [{ kind: 'unknown', written: `\${${part.name}}` }]));
    }
    /**
     * True when the binding statement at `from` has surely run whenever the command at `to` runs: in the same
     * shell, or in a subshell (a `( )` group or a substitution) started after it, which starts with a copy of
     * its variables. Read on the list the statement's shell runs (see {@link listItems}).
     */
    reaches(from, to) {
        const statement = this.commands[from];
        const target = this.commands[to];
        if (statement === undefined || target === undefined || !runsInside(target, statement)) {
            return false;
        }
        const items = listItems(this.commands, statement);
        const start = items.findIndex((item) => item.last === from);
        const end = items.findIndex((item) => item.first <= to && to <= item.last);
        const between = start < 0 || end <= start ? [] : items.slice(start, end).map((item) => item.link);
        // A pipeline runs each of its commands in a subshell of its own.
        if (between.length === 0 || between[0] === 'pipe' || between.includes('other')) {
            return false;
        }
        if (startsList(items, start)) {
            // It runs whenever its list does, and that list must not be a background job.
            return between.find((link) => link === 'sequence' || link === 'background') !== 'background';
        }
        return insideAndList(items, start) && between.every((link) => link === 'and' || link === 'pipe');
    }
}
/**
 * The list the shell `shell` runs in sits in, in order: each of its own commands, with the substitutions it holds,
 * and each `( )` group inside it as one item. A group keeps the nesting of the shell around it while a
 * substitution adds one, which tells them apart.
 */
function listItems(commands, shell) {
    const depth = shell.subshells.length;
    const inside = [...commands.entries()].filter(([, command]) => runsInside(command, shell));
    const groups = new Set(inside.flatMap(([, command]) => (command.nesting === shell.nesting ? command.subshells.slice(depth, depth + 1) : [])));
    const items = [];
    let held;
    for (const [index, command] of inside) {
        const child = command.subshells[depth];
        const link = linkOf(command.terminator);
        const previous = items.at(-1);
        if (child !== undefined && !groups.has(child)) {
            held ??= index;
        }
        else if (child !== undefined && previous?.group === child) {
            items[items.length - 1] = { ...previous, last: index, link };
        }
        else {
            items.push(child === undefined ? { first: held ?? index, last: index, link } : { first: held ?? index, last: index, link, group: child });
            held = undefined;
        }
    }
    return items;
}
/** True when the item at `at` starts a list: first in its shell, or after `;`, `&` or a newline. */
function startsList(items, at) {
    const link = items[at - 1]?.link;
    return link === undefined || link === 'sequence' || link === 'background';
}
/** True when the item at `at` follows `&&` and every link back to the start of its list is `&&` or a pipe. */
function insideAndList(items, at) {
    if (items[at - 1]?.link !== 'and') {
        return false;
    }
    for (let index = at - 1; index >= 0; index -= 1) {
        const link = items[index]?.link;
        if (link !== 'and' && link !== 'pipe') {
            return false;
        }
        if (startsList(items, index)) {
            return true;
        }
    }
    return false;
}
/**
 * The words one word expands to: its own text and quoted values join the current word, while an unquoted value
 * splits at blanks, and a word only an unquoted value made, left empty, disappears. A variable only known when
 * it runs stays one dynamic piece of the current word, however bash would split it.
 */
class Fields {
    words = [];
    text = '';
    dynamic = false;
    /** True once the current word surely exists: it holds text, or a quote, which keeps even an empty word. */
    present = false;
    addText(text, quoted) {
        this.text += text;
        this.present ||= quoted || text !== '';
    }
    /** Adds a variable's value; false when, unquoted, it would be a file name pattern, which this does not follow. */
    addValue(value, quoted) {
        this.present ||= quoted;
        for (const piece of value) {
            if (piece.kind === 'unknown') {
                this.text += piece.written;
                this.dynamic = true;
                this.present = true;
            }
            else if (quoted) {
                this.addText(piece.text, true);
            }
            else if (PATTERN_TEXT.test(piece.text)) {
                return false;
            }
            else {
                const [head = '', ...rest] = piece.text.split(FIELD_BREAKS);
                this.addText(head, false);
                for (const field of rest) {
                    this.close();
                    this.addText(field, false);
                }
            }
        }
        return true;
    }
    finish() {
        this.close();
        return this.words;
    }
    close() {
        if (this.present) {
            this.words.push({ text: this.text, dynamic: this.dynamic });
        }
        this.text = '';
        this.dynamic = false;
        this.present = false;
    }
}
/**
 * Each name the line binds to one value, with the statements that bind it, and the commands whose program a
 * variable names; undefined when the line can set variables unseen.
 */
function boundNames(commands) {
    const statements = new Map();
    const tainted = new Set();
    const deferred = [];
    const compounds = new Compounds();
    for (const [index, command] of commands.entries()) {
        const entered = compounds.enter(command, (name) => tainted.add(name));
        if (entered === undefined) {
            return undefined;
        }
        const { words, followed } = entered;
        if (programIsVariable(words)) {
            deferred.push({ index, words });
        }
        else if (setsVariablesUnseen(words)) {
            return undefined;
        }
        const statement = bindingStatement(words, command.redirections.length > 0);
        for (const binding of statement ?? []) {
            if (!followed) {
                // A compound command may run its body any number of times, or never.
                tainted.add(binding.name);
            }
            else {
                statements.set(binding.name, [...(statements.get(binding.name) ?? []), { value: binding.value, at: index }]);
            }
        }
        for (const word of statement === undefined ? words : []) {
            const assigned = ASSIGNMENT_LIKE.exec(word.text);
            if (assigned?.[2] === '[' || assigned?.[1] === 'IFS') {
                return undefined;
            }
            const name = assigned?.[1] ?? NAMED_FD.exec(word.text)?.[1];
            if (name !== undefined) {
                tainted.add(name);
            }
        }
    }
    if (!compounds.closed) {
        return undefined;
    }
    const bound = new Map();
    for (const [name, list] of statements) {
        const value = agreedValue(list.map((statement) => statement.value));
        if (value !== undefined && !tainted.has(name)) {
            bound.set(name, { value, at: list.map((statement) => statement.at) });
        }
    }
    return { bound, assigned: new Set([...statements.keys(), ...tainted]), deferred };
}
/** The keywords that open a compound command, and the part each starts. */
const OPENERS = new Map([
    ['if', 'if'],
    ['while', 'while'],
    ['until', 'while'],
    ['{', '{'],
]);
/** The keywords that end one part of a compound command and start the next: the parts each may end, and the part it starts. */
const TURNS = new Map([
    ['do', { ends: ['for', 'while'], starts: 'do' }],
    ['then', { ends: ['if'], starts: 'then' }],
    ['elif', { ends: ['then'], starts: 'if' }],
    ['else', { ends: ['then'], starts: 'else' }],
]);
/** The keywords that close a compound command, and the parts each may close; nothing may follow them in their command. */
const CLOSERS = new Map([
    ['done', ['do']],
    ['fi', ['then', 'else']],
    ['}', ['{']],
]);
/** The words {@link Compounds} reads at a command's start: the keywords above, `for`, and `!`, which only negates its status. */
const RESERVED_WORDS = new Set([...OPENERS.keys(), ...TURNS.keys(), ...CLOSERS.keys(), 'for', '!']);
/**
 * The compound commands open at each command of a line (`for`, `while` and `until` loops, `if` and `{ }`),
 * read from the keywords that start its commands. A binding inside one may run any number of times, or never,
 * so it is not followed; the line's other bindings hold inside and past it. `case`, `select`, functions
 * declared with `function`, and a keyword out of place or in another shell than the one that opened its
 * compound are not followed.
 */
class Compounds {
    /** The open parts, innermost last. */
    open = [];
    /** True when every compound the line opened has closed. */
    get closed() {
        return this.open.length === 0;
    }
    /**
     * Reads the keywords that start `command`, and gives a `for` header's variable to `taint`. Returns the words
     * after them (none for a `for` header or a closing keyword); a binding there is not followed inside a
     * compound or after `!`. Undefined for a keyword out of place.
     */
    enter(command, taint) {
        let words = command.words;
        let negated = false;
        for (let keyword = reservedWord(words[0]); keyword !== undefined; keyword = reservedWord(words[0])) {
            words = words.slice(1);
            if (keyword === 'for') {
                return this.openFor(command, words, taint) ? { words: [], followed: false } : undefined;
            }
            const closes = CLOSERS.get(keyword);
            if (closes !== undefined) {
                if (words.length > 0 || this.innermost(command, closes) === undefined) {
                    return undefined;
                }
                this.open.pop();
                return { words: [], followed: false };
            }
            if (keyword === '!') {
                negated = true;
            }
            else if (!this.move(command, keyword)) {
                return undefined;
            }
        }
        return { words, followed: !negated && this.open.length === 0 };
    }
    /** Opens a compound for `keyword`, or turns its innermost part; false when `keyword` does not fit that part. */
    move(command, keyword) {
        const opens = OPENERS.get(keyword);
        if (opens !== undefined) {
            this.open.push({ part: opens, opener: command });
            return true;
        }
        const turn = TURNS.get(keyword);
        const current = turn === undefined ? undefined : this.innermost(command, turn.ends);
        if (turn === undefined || current === undefined) {
            return false;
        }
        this.open[this.open.length - 1] = { part: turn.starts, opener: current.opener };
        return true;
    }
    /** Opens a `for NAME [in WORDS]` header and taints NAME; false for any other form, such as `for ((`. */
    openFor(command, rest, taint) {
        const [name, list] = rest;
        if (name === undefined || name.dynamic || !NAME.test(name.text) || (list !== undefined && !(list.text === 'in' && reservedWordText(list)))) {
            return false;
        }
        taint(name.text);
        this.open.push({ part: 'for', opener: command });
        return true;
    }
    /** The innermost open part when it is one of `parts` and opened in the same shell as `command`. */
    innermost(command, parts) {
        const current = this.open.at(-1);
        return current !== undefined && parts.includes(current.part) && current.opener.nesting === command.nesting && sameShell(current.opener, command) ? current : undefined;
    }
}
/** The reserved word `word` is, when it is one {@link Compounds} reads, written unquoted. */
function reservedWord(word) {
    return word !== undefined && RESERVED_WORDS.has(word.text) && reservedWordText(word) ? word.text : undefined;
}
/** True when `word` is static text with no quote or escape in it, as a bash reserved word must be. */
function reservedWordText(word) {
    return !word.dynamic && (word.parts ?? []).every((part) => part.kind === 'text' && !part.quoted);
}
/** The one value the statements binding a name give it: the only statement's, or the text all of them agree on. */
function agreedValue(values) {
    const [first, ...rest] = values;
    if (rest.length === 0) {
        return first;
    }
    const texts = new Set(values.map(textOf));
    const [text] = texts;
    return text !== undefined && texts.size === 1 ? [{ kind: 'text', text }] : undefined;
}
/** A value's text, or undefined when it holds a variable, whose value may differ from statement to statement. */
function textOf(value) {
    let text = '';
    for (const part of value) {
        if (part.kind !== 'text') {
            return undefined;
        }
        text += part.text;
    }
    return text;
}
/** The program a command's words run: the first word that is not an assignment. */
function programOf(words) {
    return words.find((word) => !ASSIGNMENT_LIKE.test(word.text));
}
/** True when the program is plain variables (and text), known once the line's bindings resolve it. */
function programIsVariable(words) {
    const program = programOf(words);
    return program !== undefined && program.dynamic && program.parts !== undefined;
}
/**
 * True when a command whose program a variable names, with its variables resolved, can set variables unseen:
 * its program is still not known, it sets them as {@link setsVariablesUnseen} reads, or it is `export`, whose
 * arguments, all made by expansions, may set any name.
 */
function expandedSetsVariablesUnseen(words) {
    const program = programOf(words);
    return program === undefined || program.dynamic || program.text === 'export' || setsVariablesUnseen(words);
}
/** True for a command that can set a variable in a way the guard does not follow, or run code that can. */
function setsVariablesUnseen(words) {
    const start = words.findIndex((word) => !ASSIGNMENT_LIKE.test(word.text));
    const program = words[start];
    if (program === undefined) {
        return false;
    }
    if (program.dynamic || UNSAFE_PROGRAMS.has(program.text)) {
        return true;
    }
    const args = words.slice(start + 1);
    switch (program.text) {
        case 'printf':
            // `printf -v NAME` assigns; so may a format only known when it runs.
            return args[0] !== undefined && (args[0].dynamic || args[0].text.startsWith('-'));
        case 'export':
            return args.some((word) => word.text.startsWith('-') || !exportsOwnName(word));
        default:
            return false;
    }
}
/**
 * True for an `export` argument that can set only the name it shows: a static word, or `NAME=` with any
 * variables in quotes, which bash never splits into further arguments.
 */
function exportsOwnName(word) {
    return !word.dynamic || (SETS_NAME.test(word.text) && word.parts !== undefined && word.parts.every((part) => part.kind === 'text' || part.quoted));
}
/**
 * The names a binding statement sets: a command of only `NAME=value` words with each name written unquoted,
 * or `export` followed by `NAME=value` words and bare names. Undefined for any other command, or one with a
 * redirection (a failed one stops `export`).
 */
function bindingStatement(words, redirected) {
    const [first, ...rest] = words;
    if (first === undefined || redirected) {
        return undefined;
    }
    const exported = !first.dynamic && first.text === 'export';
    const bindings = [];
    for (const word of exported ? rest : words) {
        const binding = exported ? exportedBinding(word) : plainBinding(word);
        if (binding !== undefined) {
            bindings.push(binding);
        }
        else if (!exported || word.dynamic || !NAME.test(word.text)) {
            return undefined;
        }
    }
    return bindings;
}
/** `NAME=value` as a shell assignment: the name and `=` unquoted at the word's start. */
function plainBinding(word) {
    const head = word.parts?.[0];
    const unquotedName = head?.kind === 'text' && !head.quoted ? SETS_NAME.exec(head.text)?.[1] : undefined;
    return unquotedName === undefined ? undefined : valueBinding(word, unquotedName, false);
}
/** `NAME=value` as an `export` argument, where quotes around the name do not matter but variables must be quoted. */
function exportedBinding(word) {
    const name = SETS_NAME.exec(word.text)?.[1];
    return name === undefined ? undefined : valueBinding(word, name, true);
}
/**
 * The binding of `name` when the rest of the word is a value this module follows: unquoted text bash keeps as
 * written (no tilde past {@link startsAtHome}'s), quoted text, and plain variables, quoted where
 * `quotedVariables` asks. Undefined for any other value, or a name bash sets itself.
 */
function valueBinding(word, name, quotedVariables) {
    const parts = word.parts === undefined ? undefined : dropText(word.parts, name.length + 1);
    if (parts === undefined || SHELL_NAMES.has(name) || SHELL_PREFIXES.test(name)) {
        return undefined;
    }
    // bash expands the `~` to what HOME holds, which it never splits, as it never splits a value.
    const home = startsAtHome(parts);
    const rest = home ? dropText(parts, 1) : parts;
    if (rest === undefined) {
        return undefined;
    }
    const value = home ? [{ kind: 'variable', name: 'HOME' }] : [];
    for (const part of rest) {
        if (part.kind === 'variable' && (part.quoted || !quotedVariables)) {
            value.push({ kind: 'variable', name: part.name });
        }
        else if (part.kind === 'text' && (part.quoted || UNQUOTED_VALUE.test(part.text))) {
            value.push({ kind: 'text', text: part.text });
        }
        else {
            return undefined;
        }
    }
    return { name, value };
}
/**
 * True when a value starts with the `~` bash expands to HOME: unquoted, and alone or before a `/`. A `~` before
 * anything else names a user's home (`~bob`) or a folder (`~+`, `~-`), which this module does not follow.
 */
function startsAtHome(parts) {
    const [first] = parts;
    return first?.kind === 'text' && !first.quoted && (first.text.startsWith('~/') || (first.text === '~' && parts.length === 1));
}
/** `parts` without their first `count` characters of text; undefined when a variable comes first. */
function dropText(parts, count) {
    let left = count;
    const kept = [];
    for (const part of parts) {
        if (left === 0) {
            kept.push(part);
        }
        else if (part.kind !== 'text') {
            return undefined;
        }
        else if (part.text.length <= left) {
            left -= part.text.length;
        }
        else {
            kept.push({ ...part, text: part.text.slice(left) });
            left = 0;
        }
    }
    return left === 0 ? kept : undefined;
}
/**
 * How a command hands over to the next one, read from its terminator without the parentheses of the `( )`
 * groups it closes or opens. A bare `)` gives no link, since what follows the group (a redirection holding a
 * substitution) is not read; `()` declares a function.
 */
function linkOf(terminator) {
    const bare = terminator.includes('()') ? terminator : terminator.replace(/[()]/g, '');
    const operator = bare.replace(/\n+$/, '');
    if (operator === '') {
        return bare === '' ? 'other' : 'sequence';
    }
    return OPERATOR_LINKS.get(operator) ?? 'other';
}
/** True when `command` runs in the shell `shell` runs in, or in a subshell started inside it. */
function runsInside(command, shell) {
    return shell.subshells.every((id, at) => command.subshells[at] === id);
}
/** True when two commands run in the same bash shell: the same chain of subshells. */
function sameShell(a, b) {
    return a !== undefined && b !== undefined && a.subshells.length === b.subshells.length && a.subshells.every((id, at) => id === b.subshells[at]);
}
