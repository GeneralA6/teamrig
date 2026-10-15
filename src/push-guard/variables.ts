import type { ShellCommand, ShellParse, ShellWord } from './tokenizer.ts';

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
/** A value that stays one word, the same in every context: no blank, quote, glob, tilde, `$`, `=` or shell operator. */
const LITERAL_VALUE = /^[A-Za-z0-9._/:+@-]+$/;
/** A word that looks like an assignment, quoted or not: `NAME=`, `NAME+=` or `NAME[`. */
const ASSIGNMENT_LIKE = /^([A-Za-z_]\w*)(\[|\+?=)/;
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

/** One name a binding statement sets. */
interface Binding {
  readonly name: string;
  readonly value: string;
}

/** A name's one value in the line and the commands that set it. */
interface Bound {
  readonly value: string;
  readonly at: readonly number[];
}

/**
 * Replaces each plain `$NAME` or `${NAME}` in a parsed bash line's commands with the literal an earlier
 * binding statement of the same line provably gave it (see {@link LiteralBindings}). A word with any
 * reference left unresolved stays as it was, dynamic; a resolved word is static and has no parts.
 */
export function resolveLiteralVariables(parsed: ShellParse): readonly ShellCommand[] {
  const bindings = LiteralBindings.read(parsed);
  return parsed.commands.map((command, index) => ({ ...command, words: command.words.map((word) => bindings.resolve(word, index)) }));
}

/**
 * The literal values a bash line gives its variables, and where they surely hold. It trusts only
 * a binding statement (a command of nothing but `NAME=literal` words, or `export` with such words), with no
 * redirection, and only for a name the line sets nowhere else and never to another value. A name also
 * assigned in any other form (`NAME=x cmd`, `NAME+=`, `{NAME}>`, a quoted or dynamic value) is not
 * resolved; anything that can set variables unseen (see {@link UNSAFE_PROGRAMS}, a dynamic program name,
 * array elements, IFS, and what {@link ShellParse.bindingsUnclear} flags) leaves the whole line unresolved.
 * A value holds at a later command only when that command surely runs after the statement, in the same shell.
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
    return new LiteralBindings(parsed.commands, parsed.bindingsUnclear ? new Map() : boundNames(parsed.commands));
  }

  /** `word` with its variables replaced by the values that hold at command `index`, or `word` itself when one does not resolve. */
  resolve(word: ShellWord, index: number): ShellWord {
    if (!word.dynamic || word.parts === undefined) {
      return word;
    }
    let text = '';
    for (const part of word.parts) {
      const value = part.kind === 'text' ? part.text : this.valueAt(part.name, index);
      if (value === undefined) {
        return word;
      }
      text += value;
    }
    return { text, dynamic: false };
  }

  private valueAt(name: string, index: number): string | undefined {
    const bound = this.bound.get(name);
    return bound?.at.some((at) => at < index && this.reaches(at, index)) === true ? bound.value : undefined;
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

/** Each name the line binds to one literal, with the statements that bind it; empty when the line can set variables unseen. */
function boundNames(commands: readonly ShellCommand[]): ReadonlyMap<string, Bound> {
  const values = new Map<string, Set<string>>();
  const at = new Map<string, number[]>();
  const tainted = new Set<string>();
  for (const [index, command] of commands.entries()) {
    if (setsVariablesUnseen(command)) {
      return new Map();
    }
    const statement = bindingStatement(command);
    for (const binding of statement ?? []) {
      values.set(binding.name, (values.get(binding.name) ?? new Set()).add(binding.value));
      at.set(binding.name, [...(at.get(binding.name) ?? []), index]);
    }
    for (const word of statement === undefined ? command.words : []) {
      const assigned = ASSIGNMENT_LIKE.exec(word.text);
      if (assigned?.[2] === '[' || assigned?.[1] === 'IFS') {
        return new Map();
      }
      const name = assigned?.[1] ?? NAMED_FD.exec(word.text)?.[1];
      if (name !== undefined) {
        tainted.add(name);
      }
    }
  }
  const bound = new Map<string, Bound>();
  for (const [name, set] of values) {
    const [value] = set;
    if (value !== undefined && set.size === 1 && !tainted.has(name)) {
      bound.set(name, { value, at: at.get(name) ?? [] });
    }
  }
  return bound;
}

/** True for a command that can set a variable in a way the guard does not follow, or run code that can. */
function setsVariablesUnseen(command: ShellCommand): boolean {
  const start = command.words.findIndex((word) => !ASSIGNMENT_LIKE.test(word.text));
  const program = command.words[start];
  if (program === undefined) {
    return false;
  }
  if (program.dynamic || UNSAFE_PROGRAMS.has(program.text)) {
    return true;
  }
  const args = command.words.slice(start + 1);
  const optionOrDynamic = (word: ShellWord): boolean => word.dynamic || word.text.startsWith('-');
  switch (program.text) {
    case 'printf':
      // `printf -v NAME` assigns; so may a format only known when it runs.
      return args[0] !== undefined && optionOrDynamic(args[0]);
    case 'export':
      return args.some(optionOrDynamic);
    default:
      return false;
  }
}

/**
 * The names a binding statement sets: a command of only `NAME=literal` words with each name written unquoted,
 * or `export` followed by `NAME=literal` words and bare names. Undefined for any other command, or one with a
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

/** `NAME=literal` as a shell assignment: the name and `=` unquoted at the word's start. */
function plainBinding(word: ShellWord): Binding | undefined {
  const head = word.parts?.[0];
  const unquotedName = head?.kind === 'text' && !head.quoted ? /^([A-Za-z_]\w*)=/.exec(head.text)?.[1] : undefined;
  return unquotedName === undefined ? undefined : literalBinding(word, unquotedName);
}

/** `NAME=literal` as an `export` argument, where quotes around the name do not matter. */
function exportedBinding(word: ShellWord): Binding | undefined {
  const name = /^([A-Za-z_]\w*)=/.exec(word.text)?.[1];
  return name === undefined ? undefined : literalBinding(word, name);
}

function literalBinding(word: ShellWord, name: string): Binding | undefined {
  const value = word.text.slice(name.length + 1);
  const bindable = !SHELL_NAMES.has(name) && !SHELL_PREFIXES.test(name);
  return !word.dynamic && bindable && LITERAL_VALUE.test(value) ? { name, value } : undefined;
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
