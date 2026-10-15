import type { ShellCommand, ShellParse, ShellWord, WordPart } from './tokenizer.ts';

/**
 * bash keywords and builtins that can set a variable in a way this module does not follow (a condition, a
 * loop, a function, `read`, `declare`, arithmetic) or run code that can (`eval`, `source`, `trap`). One
 * anywhere in a line keeps every variable of that line unresolved.
 */
const UNSAFE_PROGRAMS: ReadonlySet<string> = new Set([
  ...['if', 'then', 'elif', 'else', 'fi', 'for', 'while', 'until', 'do', 'done', 'case', 'esac', 'select', 'function'],
  ...['{', '}', '[[', ']]', '!', 'time', 'coproc'],
  ...['read', 'readarray', 'mapfile', 'getopts', 'let', 'declare', 'typeset', 'local', 'readonly', 'unset', 'wait'],
  ...['eval', 'source', '.', 'trap', 'command', 'builtin', 'enable', 'alias', 'unalias', 'shopt', 'compgen', 'complete', 'fc'],
]);
/** Variables bash itself sets or reads in a special way; a line never resolves them. */
const SHELL_NAMES: ReadonlySet<string> = new Set([
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

/** How a command hands over to the next one, read from its terminator. */
type Link = 'sequence' | 'and' | 'or' | 'pipe' | 'background' | 'other';

const OPERATOR_LINKS: ReadonlyMap<string, Link> = new Map<string, Link>([
  [';', 'sequence'],
  ['&&', 'and'],
  ['||', 'or'],
  ['|', 'pipe'],
  ['|&', 'pipe'],
  ['&', 'background'],
]);

/** A piece of a binding's value: text, or a variable, which gives the value it holds when the statement runs. */
type ValuePart = { readonly kind: 'text'; readonly text: string } | { readonly kind: 'variable'; readonly name: string };

/** A piece of a variable's value where it is used: text, or a variable only known when it runs, as written. */
type ValuePiece = { readonly kind: 'text'; readonly text: string } | { readonly kind: 'unknown'; readonly written: string };

/** One name a binding statement sets. */
interface Binding {
  readonly name: string;
  readonly value: readonly ValuePart[];
}

/** A name's one value in the line and the commands that set it. */
interface Bound {
  readonly value: readonly ValuePart[];
  readonly at: readonly number[];
}

/** What a line binds: each bound name, and the commands whose program a variable names, checked once those resolve. */
interface LineBindings {
  readonly bound: ReadonlyMap<string, Bound>;
  readonly deferred: readonly number[];
}

/**
 * Replaces each plain `$NAME` or `${NAME}` in a parsed bash line's commands with the value an earlier binding
 * statement of the same line provably gave it (see {@link LiteralBindings}), split into words where bash splits
 * it. A word with a variable left unresolved stays as it was; a resolved word has no parts, and is dynamic only
 * where the value holds a variable only known when it runs.
 */
export function resolveLiteralVariables(parsed: ShellParse): readonly ShellCommand[] {
  const bindings = LiteralBindings.read(parsed);
  return parsed.commands.map((command, index) => ({ ...command, words: bindings.resolveWords(command.words, index) }));
}

/**
 * The values a bash line gives its variables, and where they surely hold. It trusts only a binding statement
 * (a command of nothing but `NAME=value` words, or `export` with such words and bare names), with no
 * redirection, whose value is unquoted text bash keeps as written, quoted text and plain variables (in quotes,
 * for `export`), and only for a name the line sets nowhere else, or always to the same text. A name also
 * assigned in any other form (`NAME=x cmd`, `NAME+=`, `{NAME}>`, a value with a substitution or a tilde) is
 * not resolved; anything that can set variables unseen (see {@link UNSAFE_PROGRAMS}, a program a variable names
 * that is not known or is one of those, array elements, IFS, and what {@link ShellParse.bindingsUnclear} flags)
 * leaves the whole line unresolved. A value holds at a later command only when that command surely runs after
 * the statement, in the same shell; a variable in a value gives what it held when the statement ran.
 */
class LiteralBindings {
  private readonly commands: readonly ShellCommand[];
  private readonly links: readonly Link[];
  private readonly bound: ReadonlyMap<string, Bound>;

  private constructor(commands: readonly ShellCommand[], bound: ReadonlyMap<string, Bound>) {
    this.commands = commands;
    this.links = commands.map((command) => linkOf(command.terminator));
    this.bound = bound;
  }

  static read(parsed: ShellParse): LiteralBindings {
    const none = new LiteralBindings(parsed.commands, new Map());
    const line = parsed.bindingsUnclear ? undefined : boundNames(parsed.commands);
    if (line === undefined) {
      return none;
    }
    const bindings = new LiteralBindings(parsed.commands, line.bound);
    const unseen = line.deferred.some((index) => expandedSetsVariablesUnseen(bindings.resolveWords(parsed.commands[index]?.words ?? [], index)));
    return unseen ? none : bindings;
  }

  /** The words of command `index` with their variables replaced by the values that hold there. */
  resolveWords(words: readonly ShellWord[], index: number): readonly ShellWord[] {
    return words.flatMap((word) => this.resolve(word, index));
  }

  /** The words `word` becomes at command `index`, or `word` itself when a variable in it does not resolve. */
  private resolve(word: ShellWord, index: number): readonly ShellWord[] {
    if (!word.dynamic || word.parts === undefined) {
      return [word];
    }
    const fields = new Fields();
    for (const part of word.parts) {
      const value = part.kind === 'text' ? undefined : this.valueAt(part.name, index);
      if (part.kind === 'text') {
        fields.addText(part.text, part.quoted);
      } else if (value === undefined || !fields.addValue(value, part.quoted)) {
        return [word];
      }
    }
    const words = fields.finish();
    return words.length > 0 ? words : [word];
  }

  /** The value `name` holds at command `index`; a variable in it gives what it held when its statement ran. */
  private valueAt(name: string, index: number): readonly ValuePiece[] | undefined {
    const bound = this.bound.get(name);
    const at = bound?.at.find((statement) => statement < index && this.reaches(statement, index));
    if (bound === undefined || at === undefined) {
      return undefined;
    }
    return bound.value.flatMap((part): readonly ValuePiece[] =>
      part.kind === 'text' ? [part] : (this.valueAt(part.name, at) ?? [{ kind: 'unknown', written: `\${${part.name}}` }]),
    );
  }

  /**
   * True when the binding statement at `from` has surely run, in the same shell, whenever the command at `to`
   * runs. The commands of a substitution between them are passed over: they run in a subshell of their own,
   * so they set nothing here, and the command that holds them carries the link to the next one.
   */
  private reaches(from: number, to: number): boolean {
    const statement = this.commands[from];
    if (statement === undefined || this.links[from] === 'pipe') {
      return false;
    }
    const path: number[] = [];
    for (let index = from; index < to; index += 1) {
      if ((this.commands[index]?.nesting ?? 0) <= statement.nesting) {
        path.push(index);
      }
    }
    if (path.some((index) => !sameShell(statement, this.commands[index]) || this.links[index] === 'other') || !sameShell(statement, this.commands[to])) {
      return false;
    }
    const between = path.map((index) => this.links[index]);
    if (this.startsList(from)) {
      // It runs whenever its list does, and that list must not be a background job.
      return between.find((link) => link === 'sequence' || link === 'background') !== 'background';
    }
    return this.insideAndList(from) && between.every((link) => link === 'and' || link === 'pipe');
  }

  /** True when the command at `index` starts a list: first in the line or in a `( )` group, or after `;`, `&` or a newline. */
  private startsList(index: number): boolean {
    const previous = this.previous(index);
    const before = previous === undefined ? undefined : this.commands[previous];
    if (previous === undefined || before === undefined || opensGroup(before.terminator)) {
      return true;
    }
    const link = this.links[previous];
    return sameShell(before, this.commands[index]) && (link === 'sequence' || link === 'background');
  }

  /** True when the command at `from` follows `&&` and every link back to the start of its list is `&&` or a pipe. */
  private insideAndList(from: number): boolean {
    let index = this.previous(from);
    if (index === undefined || this.links[index] !== 'and') {
      return false;
    }
    while (index !== undefined && sameShell(this.commands[index], this.commands[from]) && (this.links[index] === 'and' || this.links[index] === 'pipe')) {
      if (this.startsList(index)) {
        return true;
      }
      index = this.previous(index);
    }
    return false;
  }

  /** The command before the one at `index` in its own list: the nearest earlier one not inside a deeper substitution. */
  private previous(index: number): number | undefined {
    const nesting = this.commands[index]?.nesting ?? 0;
    for (let at = index - 1; at >= 0; at -= 1) {
      if ((this.commands[at]?.nesting ?? 0) <= nesting) {
        return at;
      }
    }
    return undefined;
  }
}

/**
 * The words one word expands to: its own text and quoted values join the current word, while an unquoted value
 * splits at blanks, and a word only an unquoted value made, left empty, disappears. A variable only known when
 * it runs stays one dynamic piece of the current word, however bash would split it.
 */
class Fields {
  private readonly words: ShellWord[] = [];
  private text = '';
  private dynamic = false;
  /** True once the current word surely exists: it holds text, or a quote, which keeps even an empty word. */
  private present = false;

  addText(text: string, quoted: boolean): void {
    this.text += text;
    this.present ||= quoted || text !== '';
  }

  /** Adds a variable's value; false when, unquoted, it would be a file name pattern, which this does not follow. */
  addValue(value: readonly ValuePiece[], quoted: boolean): boolean {
    this.present ||= quoted;
    for (const piece of value) {
      if (piece.kind === 'unknown') {
        this.text += piece.written;
        this.dynamic = true;
        this.present = true;
      } else if (quoted) {
        this.addText(piece.text, true);
      } else if (PATTERN_TEXT.test(piece.text)) {
        return false;
      } else {
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

  finish(): readonly ShellWord[] {
    this.close();
    return this.words;
  }

  private close(): void {
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
function boundNames(commands: readonly ShellCommand[]): LineBindings | undefined {
  const statements = new Map<string, { readonly value: readonly ValuePart[]; readonly at: number }[]>();
  const tainted = new Set<string>();
  const deferred: number[] = [];
  for (const [index, command] of commands.entries()) {
    if (programIsVariable(command.words)) {
      deferred.push(index);
    } else if (setsVariablesUnseen(command.words)) {
      return undefined;
    }
    const statement = bindingStatement(command);
    for (const binding of statement ?? []) {
      statements.set(binding.name, [...(statements.get(binding.name) ?? []), { value: binding.value, at: index }]);
    }
    for (const word of statement === undefined ? command.words : []) {
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
  const bound = new Map<string, Bound>();
  for (const [name, list] of statements) {
    const value = agreedValue(list.map((statement) => statement.value));
    if (value !== undefined && !tainted.has(name)) {
      bound.set(name, { value, at: list.map((statement) => statement.at) });
    }
  }
  return { bound, deferred };
}

/** The one value the statements binding a name give it: the only statement's, or the text all of them agree on. */
function agreedValue(values: readonly (readonly ValuePart[])[]): readonly ValuePart[] | undefined {
  const [first, ...rest] = values;
  if (rest.length === 0) {
    return first;
  }
  const texts = new Set(values.map(textOf));
  const [text] = texts;
  return text !== undefined && texts.size === 1 ? [{ kind: 'text', text }] : undefined;
}

/** A value's text, or undefined when it holds a variable, whose value may differ from statement to statement. */
function textOf(value: readonly ValuePart[]): string | undefined {
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
function programOf(words: readonly ShellWord[]): ShellWord | undefined {
  return words.find((word) => !ASSIGNMENT_LIKE.test(word.text));
}

/** True when the program is plain variables (and text), known once the line's bindings resolve it. */
function programIsVariable(words: readonly ShellWord[]): boolean {
  const program = programOf(words);
  return program !== undefined && program.dynamic && program.parts !== undefined;
}

/**
 * True when a command whose program a variable names, with its variables resolved, can set variables unseen:
 * its program is still not known, it sets them as {@link setsVariablesUnseen} reads, or it is `export`, whose
 * arguments, all made by expansions, may set any name.
 */
function expandedSetsVariablesUnseen(words: readonly ShellWord[]): boolean {
  const program = programOf(words);
  return program === undefined || program.dynamic || program.text === 'export' || setsVariablesUnseen(words);
}

/** True for a command that can set a variable in a way the guard does not follow, or run code that can. */
function setsVariablesUnseen(words: readonly ShellWord[]): boolean {
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
function exportsOwnName(word: ShellWord): boolean {
  return !word.dynamic || (SETS_NAME.test(word.text) && word.parts !== undefined && word.parts.every((part) => part.kind === 'text' || part.quoted));
}

/**
 * The names a binding statement sets: a command of only `NAME=value` words with each name written unquoted,
 * or `export` followed by `NAME=value` words and bare names. Undefined for any other command, or one with a
 * redirection (a failed one stops `export`).
 */
function bindingStatement(command: ShellCommand): readonly Binding[] | undefined {
  const [first, ...rest] = command.words;
  if (first === undefined || command.redirections.length > 0) {
    return undefined;
  }
  const exported = !first.dynamic && first.text === 'export';
  const bindings: Binding[] = [];
  for (const word of exported ? rest : command.words) {
    const binding = exported ? exportedBinding(word) : plainBinding(word);
    if (binding !== undefined) {
      bindings.push(binding);
    } else if (!exported || word.dynamic || !NAME.test(word.text)) {
      return undefined;
    }
  }
  return bindings;
}

/** `NAME=value` as a shell assignment: the name and `=` unquoted at the word's start. */
function plainBinding(word: ShellWord): Binding | undefined {
  const head = word.parts?.[0];
  const unquotedName = head?.kind === 'text' && !head.quoted ? SETS_NAME.exec(head.text)?.[1] : undefined;
  return unquotedName === undefined ? undefined : valueBinding(word, unquotedName, false);
}

/** `NAME=value` as an `export` argument, where quotes around the name do not matter but variables must be quoted. */
function exportedBinding(word: ShellWord): Binding | undefined {
  const name = SETS_NAME.exec(word.text)?.[1];
  return name === undefined ? undefined : valueBinding(word, name, true);
}

/**
 * The binding of `name` when the rest of the word is a value this module follows: unquoted text bash keeps as
 * written (no tilde), quoted text, and plain variables, quoted where `quotedVariables` asks. Undefined for any
 * other value, or a name bash sets itself.
 */
function valueBinding(word: ShellWord, name: string, quotedVariables: boolean): Binding | undefined {
  const parts = word.parts === undefined ? undefined : dropText(word.parts, name.length + 1);
  if (parts === undefined || SHELL_NAMES.has(name) || SHELL_PREFIXES.test(name)) {
    return undefined;
  }
  const value: ValuePart[] = [];
  for (const part of parts) {
    if (part.kind === 'variable' && (part.quoted || !quotedVariables)) {
      value.push({ kind: 'variable', name: part.name });
    } else if (part.kind === 'text' && (part.quoted || UNQUOTED_VALUE.test(part.text))) {
      value.push({ kind: 'text', text: part.text });
    } else {
      return undefined;
    }
  }
  return { name, value };
}

/** `parts` without their first `count` characters of text; undefined when a variable comes first. */
function dropText(parts: readonly WordPart[], count: number): readonly WordPart[] | undefined {
  let left = count;
  const kept: WordPart[] = [];
  for (const part of parts) {
    if (left === 0) {
      kept.push(part);
    } else if (part.kind !== 'text') {
      return undefined;
    } else if (part.text.length <= left) {
      left -= part.text.length;
    } else {
      kept.push({ ...part, text: part.text.slice(left) });
      left = 0;
    }
  }
  return left === 0 ? kept : undefined;
}

function linkOf(terminator: string): Link {
  const operator = terminator.replace(/\n+$/, '');
  if (operator === '') {
    return terminator === '' ? 'other' : 'sequence';
  }
  return OPERATOR_LINKS.get(operator) ?? 'other';
}

/** True when a terminator ends by opening a `( )` group, so the next command is the first inside it. */
function opensGroup(terminator: string): boolean {
  return terminator.replace(/\n+$/, '').endsWith('(');
}

/** True when two commands run in the same bash shell: the same chain of subshells. */
function sameShell(a: ShellCommand | undefined, b: ShellCommand | undefined): boolean {
  return a !== undefined && b !== undefined && a.subshells.length === b.subshells.length && a.subshells.every((id, at) => id === b.subshells[at]);
}
