import { parseShell, type Redirection, type ShellCommand, type ShellWord } from '../push-guard/tokenizer.ts';
import { mayAssign } from './names.ts';
import { programReads, type ProgramArgument } from './programs.ts';
import { startsWithPrefix, type ReadonlyRules } from './rules.ts';

/** The reserved words a command may start with: they shape the line, and the words after them still face every check. */
const KEYWORDS: ReadonlySet<string> = new Set(['if', 'then', 'else', 'elif', 'fi', 'while', 'until', 'do', 'done', '!', '{', '}']);

/** The variables a command may set for the program it runs: Git Bash's path conversion switches, which only change how it passes arguments. */
const ENV_PREFIXES: ReadonlySet<string> = new Set(['MSYS_NO_PATHCONV', 'MSYS2_ARG_CONV_EXCL']);

const ASSIGNMENT = /^([A-Za-z_]\w*)(\[|\+?=)/;
const NAME = /^[A-Za-z_]\w*$/;
const GLOB = /[*?[]/;
/** A `>&` or `<&` target that copies or closes a descriptor rather than naming a file. */
const DESCRIPTOR = /^(?:\d+|-)$/;

interface Assignment {
  readonly name: string;
  /** `name[...]=`: bash evaluates the subscript as arithmetic, which can run a command. */
  readonly subscript: boolean;
  readonly word: ShellWord;
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
  return { text: word.text, dynamic: word.dynamic || !single, single };
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
function callReads(words: readonly ShellWord[], rules: ReadonlyRules): boolean {
  if (startsWithPrefix(words, rules.prefixes)) {
    return true;
  }
  const [program, ...args] = words;
  return program !== undefined && !program.dynamic && programReads(program.text, args.map(argumentOf));
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

/**
 * One simple command: no here-document, every redirection harmless, no function definition (a function can call
 * itself without end); then, past its leading keywords, either a `for` header, assignments alone (each to a name the
 * line may set), or a program call, before which only the path conversion switches may be set, to static values
 * and with no subscript.
 */
function commandReads(command: ShellCommand, rules: ReadonlyRules): boolean {
  if (command.stdin !== undefined || command.terminator.startsWith('()') || !command.redirections.every(redirectionReads)) {
    return false;
  }
  const start = command.words.findIndex((word) => !isKeyword(word));
  const words = start === -1 ? [] : command.words.slice(start);
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
  return assignments.every((assignment) => ENV_PREFIXES.has(assignment.name) && !assignment.subscript && !assignment.word.dynamic) && callReads(call, rules);
}

/**
 * Whether a bash line only reads: the parser read all of it, it sets no variable in a way the parser cannot follow
 * (which also covers every arithmetic expansion, whose variables can run a command), and each command it runs,
 * substitutions included, reads.
 */
export function bashLineReads(line: string, rules: ReadonlyRules): boolean {
  const parse = parseShell(line, 'bash');
  if (!parse.complete || parse.bindingsUnclear || parse.unreadBodies.length > 0 || parse.commands.length === 0) {
    return false;
  }
  return parse.commands.every((command) => commandReads(command, rules));
}
