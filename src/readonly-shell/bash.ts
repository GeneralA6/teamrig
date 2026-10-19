import { parseShell, type Redirection, type ShellCommand, type ShellWord, type WordPart } from '../push-guard/tokenizer.ts';
import { mayAssign } from './names.ts';
import { programReads, type ProgramArgument } from './programs.ts';
import { startsWithPrefix, type ReadonlyRules } from './rules.ts';

/** The reserved words a command may start with: they shape the line, and the words after them still face every check. */
const KEYWORDS: ReadonlySet<string> = new Set(['if', 'then', 'else', 'elif', 'fi', 'while', 'until', 'do', 'done', '!', '{', '}']);
/** The keywords that open a block, whose commands run conditionally, repeatedly or grouped; a `for` header opens one too. */
const BLOCK_OPENERS: ReadonlySet<string> = new Set(['if', 'while', 'until', '{']);
const BLOCK_CLOSERS: ReadonlySet<string> = new Set(['fi', 'done', '}']);

/** The variables a command may set for the program it runs: Git Bash's path conversion switches, which only change how it passes arguments. */
const ENV_PREFIXES: ReadonlySet<string> = new Set(['MSYS_NO_PATHCONV', 'MSYS2_ARG_CONV_EXCL']);

const ASSIGNMENT = /^([A-Za-z_]\w*)(\[|\+?=)/;
const NAME = /^[A-Za-z_]\w*$/;
const GLOB = /[*?[]/;
/** A bracket expression of one digit or a `*`, which matches only that character. */
const BRACKET = /\[([\d*])\]/g;
/** A `>&` or `<&` target that copies or closes a descriptor rather than naming a file. */
const DESCRIPTOR = /^(?:\d+|-)$/;
/** A value an unquoted use keeps as one word, as written: no blank splits it and no glob expands it. */
const PLAIN_VALUE = /^[\w./:@%+,=-]+$/;
/** The separators after a command before which an assignment still always runs: `;`, a newline, a subshell's `)`. */
const UNCONDITIONAL = /^[;\n)]*$/;
/** A separator that runs the command before it in a pipeline or in the background, so in a subshell of its own. */
const SUBSHELL_SEPARATOR = /^(?:\|(?!\|)|&(?!&))/;

interface Assignment {
  readonly name: string;
  /** `name[...]=`: bash evaluates the subscript as arithmetic, which can run a command. */
  readonly subscript: boolean;
  readonly word: ShellWord;
}

/** What a variable reads as where a command uses it: the static text the line set it to, if that holds there. */
type ValueOf = (name: string) => string | undefined;

/** A static value of the line's own variable, and the index of the command that sets it: every later command reads it. */
interface StaticValue {
  readonly text: string;
  readonly at: number;
}

/** The word's text when it is plain unquoted text, as keywords and loop names must be: a quoted keyword is a program name. */
function bareText(word: ShellWord): string | undefined {
  const [part, ...rest] = word.parts ?? [];
  return rest.length === 0 && part?.kind === 'text' && !part.quoted ? part.text : undefined;
}

function isKeyword(word: ShellWord): boolean {
  return KEYWORDS.has(bareText(word) ?? '');
}

/**
 * The assignment a word makes, read as bash does: a name written unquoted at its start, then `=`, `+=` or `[`. A word
 * holding a substitution keeps no parts, so its text is read instead, and `"x"=$(cmd)` counts as an assignment
 * although bash runs a program named `x=...`: no PATH holds one.
 */
function assignmentOf(word: ShellWord): Assignment | undefined {
  const head = word.parts === undefined ? word.text : word.parts[0]?.kind === 'text' && !word.parts[0].quoted ? word.parts[0].text : '';
  const match = ASSIGNMENT.exec(head);
  const name = match?.[1];
  return name === undefined ? undefined : { name, subscript: match?.[2] === '[', word };
}

/** A word as the program receives it: dynamic when a variable, a substitution or a glob decides what it becomes. */
export function argumentOf(word: ShellWord): ProgramArgument {
  const single = word.parts !== undefined && word.parts.every((part) => part.quoted || (part.kind === 'text' && !GLOB.test(part.text)));
  const match = single || word.dynamic ? undefined : bracketMatchOf(word.parts ?? []);
  return { text: word.text, dynamic: word.dynamic || !single, single, ...(match === undefined ? {} : { bracketMatch: match }) };
}

/**
 * The one file name a glob made only of one-digit or `*` brackets can match: each unquoted `[0]` or `[*]` read as its
 * character. Undefined for a variable, any other glob, or a letter in brackets, which `nocaseglob` would match in
 * either case.
 */
function bracketMatchOf(parts: readonly WordPart[]): string | undefined {
  let match = '';
  for (const part of parts) {
    if (part.kind === 'variable') {
      return undefined;
    }
    if (!part.quoted && GLOB.test(part.text.replace(BRACKET, ''))) {
      return undefined;
    }
    match += part.quoted ? part.text : part.text.replace(BRACKET, '$1');
  }
  return match;
}

/** A part's text once the shell expands it: plain or quoted text, or a variable's static value that an unquoted use neither splits nor globs. */
function boundText(part: WordPart, valueOf: ValueOf): string | undefined {
  if (part.kind === 'text') {
    return part.quoted || !GLOB.test(part.text) ? part.text : undefined;
  }
  const value = valueOf(part.name);
  return value !== undefined && (part.quoted || PLAIN_VALUE.test(value)) ? value : undefined;
}

/**
 * A word as the program receives it, its variables read as `valueOf` knows them: static and single when it holds a
 * variable and every part has a known text (`"$out/a.log"` where `out=x` holds), else as `argumentOf` reads it.
 */
export function boundArgumentOf(word: ShellWord, valueOf: ValueOf): ProgramArgument {
  const parts = word.parts ?? [];
  const texts = parts.map((part) => boundText(part, valueOf));
  if (!parts.some((part) => part.kind === 'variable') || texts.some((text) => text === undefined)) {
    return argumentOf(word);
  }
  return { text: texts.join(''), dynamic: false, single: true };
}

/**
 * A redirection that writes nothing: input from a file, a descriptor copied or closed, or output thrown away to
 * `/dev/null`. Never `<>`, which opens a file for writing, nor a here-document (`<<`, `<<<`).
 */
function redirectionReads({ operator, target }: Redirection): boolean {
  if (target === undefined) {
    return true;
  }
  const fixed = target.dynamic ? undefined : target.text;
  if (operator.endsWith('&') && fixed !== undefined && DESCRIPTOR.test(fixed)) {
    return true;
  }
  if (/^\d*<$/.test(operator)) {
    return true;
  }
  return operator.includes('>') && !operator.includes('<') && fixed === '/dev/null';
}

/** `for name [in words...]`: the loop sets `name`, so it must be one the line may set; the words are its values. */
function loopReads(words: readonly ShellWord[], rules: ReadonlyRules): boolean {
  const [name, keyword] = words;
  const variable = name === undefined ? undefined : bareText(name);
  return variable !== undefined && NAME.test(variable) && mayAssign(variable, rules) && (keyword === undefined || bareText(keyword) === 'in');
}

/** A program run with its arguments: a team-trusted prefix, or a program on the list given arguments that keep it reading. */
function callReads(words: readonly ShellWord[], rules: ReadonlyRules, valueOf: ValueOf): boolean {
  if (startsWithPrefix(words, rules.prefixes)) {
    return true;
  }
  const [program, ...args] = words;
  return program !== undefined && !program.dynamic && programReads(program.text, args.map((arg) => boundArgumentOf(arg, valueOf)));
}

/** The leading `NAME=value` words of a command, which bash reads as assignments until the first word that is not one. */
function leadingAssignments(words: readonly ShellWord[]): readonly Assignment[] {
  const found: Assignment[] = [];
  for (const word of words) {
    const assignment = assignmentOf(word);
    if (assignment === undefined) {
      break;
    }
    found.push(assignment);
  }
  return found;
}

/** A command's leading keywords, which shape the line, and the words past them. */
function splitKeywords(command: ShellCommand): { readonly keywords: readonly ShellWord[]; readonly words: readonly ShellWord[] } {
  const start = command.words.findIndex((word) => !isKeyword(word));
  return start === -1 ? { keywords: command.words, words: [] } : { keywords: command.words.slice(0, start), words: command.words.slice(start) };
}

/**
 * One simple command: no here-document, every redirection harmless, no function definition (a function can call
 * itself without end); then, past its leading keywords, either a `for` header, assignments alone (each to a name the
 * line may set), or a program call, before which only the path conversion switches may be set, to static values
 * and with no subscript.
 */
function commandReads(command: ShellCommand, rules: ReadonlyRules, valueOf: ValueOf): boolean {
  if (command.stdin !== undefined || command.terminator.startsWith('()') || !command.redirections.every(redirectionReads)) {
    return false;
  }
  const { words } = splitKeywords(command);
  const [first] = words;
  if (first === undefined) {
    return true;
  }
  if (bareText(first) === 'for') {
    return loopReads(words.slice(1), rules);
  }
  const assignments = leadingAssignments(words);
  const call = words.slice(assignments.length);
  if (call.length === 0) {
    return assignments.every((assignment) => !assignment.subscript && mayAssign(assignment.name, rules));
  }
  return assignments.every((assignment) => ENV_PREFIXES.has(assignment.name) && !assignment.subscript && !assignment.word.dynamic) && callReads(call, rules, valueOf);
}

/** The names a command sets: a `for` header's name, else its leading assignments, a program's prefixes included. */
function namesSet(command: ShellCommand): readonly string[] {
  const { words } = splitKeywords(command);
  const [first, name] = words;
  if (first !== undefined && bareText(first) === 'for') {
    const variable = name === undefined ? undefined : bareText(name);
    return variable === undefined ? [] : [variable];
  }
  return leadingAssignments(words).map((assignment) => assignment.name);
}

/** The static text an assignment gives its name: `name=text`, with nothing in it the shell expands, nor a flag's `-` or an array's `(`. */
function staticText({ name, subscript, word }: Assignment): string | undefined {
  const text = word.text.slice(name.length + 1);
  return !subscript && !word.dynamic && word.text.startsWith(`${name}=`) && text !== '' && !/[~(]/.test(text) && !text.startsWith('-') ? text : undefined;
}

/**
 * The static values of the line's own variables. A name the line may set, and sets once in the whole line, keeps the
 * text it was set to in every later command when assignments alone set it in the line's own shell, always: at the
 * top level, outside any block, subshell or substitution, after `;` or a newline, and not in a pipeline or the
 * background. A second assignment anywhere, a loop's included, leaves the name dynamic everywhere.
 */
function staticValues(commands: readonly ShellCommand[], rules: ReadonlyRules): ReadonlyMap<string, StaticValue> {
  const counts = new Map<string, number>();
  for (const name of commands.flatMap(namesSet)) {
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const values = new Map<string, StaticValue>();
  let depth = 0;
  let before = '';
  commands.forEach((command, at) => {
    if (command.nesting > 0) {
      return;
    }
    const { keywords, words } = splitKeywords(command);
    const assignments = leadingAssignments(words);
    const always =
      depth === 0 && keywords.length === 0 && command.subshells.length === 0 && UNCONDITIONAL.test(before) && !SUBSHELL_SEPARATOR.test(command.terminator);
    if (always && assignments.length === words.length) {
      for (const assignment of assignments) {
        const text = staticText(assignment);
        if (text !== undefined && counts.get(assignment.name) === 1 && mayAssign(assignment.name, rules)) {
          values.set(assignment.name, { text, at });
        }
      }
    }
    for (const keyword of keywords) {
      const text = bareText(keyword) ?? '';
      depth += BLOCK_OPENERS.has(text) ? 1 : BLOCK_CLOSERS.has(text) ? -1 : 0;
    }
    depth += words[0] !== undefined && bareText(words[0]) === 'for' ? 1 : 0;
    before = command.terminator;
  });
  return values;
}

/**
 * Whether a bash line only reads: the parser read all of it, it sets no variable in a way the parser cannot follow
 * (which also covers every arithmetic expansion, whose variables can run a command), and each command it runs,
 * substitutions included, reads, its arguments read with the static values the line's own variables hold there.
 */
export function bashLineReads(line: string, rules: ReadonlyRules): boolean {
  const parse = parseShell(line, 'bash');
  if (!parse.complete || parse.bindingsUnclear || parse.unreadBodies.length > 0 || parse.commands.length === 0) {
    return false;
  }
  const values = staticValues(parse.commands, rules);
  return parse.commands.every((command, at) => {
    const valueOf: ValueOf = (name) => {
      const value = values.get(name);
      return value !== undefined && value.at < at ? value.text : undefined;
    };
    return commandReads(command, rules, valueOf);
  });
}
