import { isAssignment, launch, programName, type Launch, type ProgramLaunch } from './launchers.ts';
import type { Redirection, ShellCommand, ShellWord } from './tokenizer.ts';

/**
 * Every bash builtin (bash 5.2 and 5.3, `enable -a`). Any of them may read a word's held text again: several evaluate
 * the array subscript in a name argument (`read 'a[$(cmd)]'`, `printf -v`, `unset`, `test -v`), others store text they
 * run later (`trap`, `alias`, `bind -x`, `complete -C`, `mapfile -C`), and which ones check a name first changes by
 * version, so the whole closed set counts rather than a list of the ones that do (#1471).
 */
const BASH_BUILTINS: ReadonlySet<string> = new Set(
  (
    '. : [ alias bg bind break builtin caller cd command compgen complete compopt continue declare dirs disown echo enable ' +
    'eval exec exit export false fc fg getopts hash help history jobs kill let local logout mapfile popd printf pushd pwd ' +
    'read readarray readonly return set shift shopt source suspend test times trap true type typeset ulimit umask unalias ' +
    'unset wait'
  ).split(' '),
);
/** bash's reserved words; `[[ ]]` and `(( ))` read their words as expressions, and the rest are never a program. */
const BASH_KEYWORDS: ReadonlySet<string> = new Set(
  '! [[ ]] { } case coproc do done elif else esac fi for function if in select then time until while'.split(' '),
);
/** Words that end a compound command, whose redirections cover every command inside it. */
const COMPOUND_ENDS: ReadonlySet<string> = new Set(['}', 'done', 'fi', 'esac']);
/** Programs that write what they read on stdin to a file they are handed. */
const STDIN_WRITERS: ReadonlySet<string> = new Set(['tee', 'sponge', 'dd']);
/** A pipe to the next command, maybe after a group's `)` or the newline that ends a heredoc's line. */
const PIPE = /^\)*\|&?\n*$/;
/** A descriptor copy that writes to the terminal's streams or closes one: `2>&1`, `>&2`, `>&-`. */
const STREAM_COPY = /^\d*>&(?:[012]|-)$/;

/** True for a bash assignment word, `NAME=value`, `NAME+=value` or `NAME[sub]=value`, whose value bash may read again. */
export function isAssignmentWord(text: string): boolean {
  return isAssignment(text) || /^[A-Za-z_]\w*(?:\[[^\]]*\])?\+?=/.test(text);
}

/**
 * True when a redirection may write the command's output to a file a later line reads: any output redirection but a
 * literal `/dev/null` or a copy onto stdout, stderr or a closed descriptor. A variable target, a process substitution
 * (`> >(bash)`, a shell fed that text) or another descriptor (`>&3`, maybe a file opened earlier) count.
 */
export function writesFile(redirection: Redirection): boolean {
  const { operator, target } = redirection;
  if (!operator.includes('>')) {
    return false;
  }
  if (target === undefined) {
    return !STREAM_COPY.test(operator);
  }
  return target.dynamic || target.text !== '/dev/null';
}

/**
 * True when a single-dash option cluster turns on an in-place letter (`-i`, or another `inPlace` matches) before the
 * letter that takes the rest of the word as a value.
 */
function clusterHasI(word: ShellWord, takesValue: RegExp, inPlace = /i/): boolean {
  if (word.dynamic && /^[-$`]/.test(word.text)) {
    return true;
  }
  if (!/^-[^-]/.test(word.text)) {
    return false;
  }
  const cluster = word.text.slice(1);
  const end = cluster.search(takesValue);
  return inPlace.test(end === -1 ? cluster : cluster.slice(0, end));
}

/**
 * True when `text` names the long option `name`, spelled out or by any prefix getopt_long accepts (`--i` for
 * `--in-place` in GNU sed, where no other long option starts with `--i`), with or without an `=value`.
 */
function isLongOption(text: string, name: string): boolean {
  const end = text.indexOf('=');
  const spelled = end === -1 ? text : text.slice(0, end);
  return spelled.length >= 3 && name.startsWith(spelled);
}

/** True when a gawk word loads the inplace extension: `inplace`, `-iinplace`, `--incl=inplace`, a path to `inplace.awk`. */
function loadsInplace(text: string): boolean {
  let value = text;
  if (text.startsWith('--') && text.includes('=') && isLongOption(text, '--include')) {
    value = text.slice(text.indexOf('=') + 1);
  } else if (text.startsWith('-i')) {
    value = text.slice(2);
  }
  return value.slice(value.lastIndexOf('/') + 1).startsWith('inplace');
}

/**
 * True when a program writes its arguments' text back into the files it edits: `sed -i`, `perl -pi`, `ruby -i`, gawk's
 * `-i inplace`. A word only known when it runs may be such an option, so it counts.
 */
export function editsInPlace(launched: ProgramLaunch): boolean {
  const { args } = launched;
  switch (programName(launched.program.text)) {
    case 'sed':
    case 'gsed':
      // BSD and macOS sed spell in-place `-I` too; GNU sed refuses it, so reading it there only over-counts.
      return args.some((arg) => isLongOption(arg.text, '--in-place') || clusterHasI(arg, /[ef]/, /[iI]/));
    case 'perl':
    case 'ruby':
      // `-d` takes a value only after `:` or `=` (perl) or none (ruby), so a cluster goes on past it: `-di`.
      return args.some((arg) => clusterHasI(arg, /[eEMmIDFxV]/));
    case 'awk':
    case 'gawk':
      return args.some((arg) => (arg.dynamic && /^[-$`]/.test(arg.text)) || loadsInplace(arg.text));
    default:
      return false;
  }
}

/** The commands whose arguments may define names: `alias`, `enable` and the file readers `source` and `.`. */
const DEFINERS = new Set(['alias', 'enable', 'source', '.']);

/**
 * The names a command line makes into commands of its own: functions (`f() {`, `function f`), aliases and builtins it
 * loads (`enable -f lib.so name`). Such a name may run its arguments as code, so it is never a known external program.
 * A sourced file or text eval'd from a word known only when it runs may define any name.
 */
export class LineCommands {
  private readonly names = new Set<string>();
  /** True once a name is only known when the line runs, so any name may be one. */
  private unknown = false;

  /** Notes the names `commands` define. */
  note(commands: readonly ShellCommand[]): void {
    for (const command of commands) {
      const [head, second] = command.words;
      if (head === undefined) {
        continue;
      }
      if (head.text === 'function' && second !== undefined) {
        this.add(second);
      } else if (command.words.length === 1 && command.terminator.replace(/\s/g, '').startsWith('()')) {
        this.add(head);
      }
      // A sourced file or eval'd text known only when it runs may define any name.
      if (command.words.some((word) => word.text === 'eval') && command.words.some((word) => word.dynamic)) {
        this.unknown = true;
      }
      if (command.words.some((word) => DEFINERS.has(word.text))) {
        this.noteDefiners(launch(command.words, 'bash'));
      }
    }
  }

  /** True when `name` may be a command the line defines. */
  has(name: string): boolean {
    return this.unknown || this.names.has(name);
  }

  private noteDefiners(launched: Launch): void {
    if (launched.kind !== 'program') {
      return;
    }
    const program = launched.program.text;
    if (program === 'source' || program === '.') {
      this.unknown = true;
      return;
    }
    for (const arg of launched.args) {
      if (program === 'alias' && arg.text.includes('=')) {
        this.add({ text: arg.text.slice(0, arg.text.indexOf('=')), dynamic: arg.dynamic });
      } else if (program === 'enable' && !arg.text.startsWith('-')) {
        this.add(arg);
      }
    }
  }

  private add(word: ShellWord): void {
    if (word.dynamic) {
      this.unknown = true;
    } else {
      this.names.add(word.text);
    }
  }
}

/**
 * True when bash runs `program` as a file: a static name with a slash, or one that is no builtin, reserved word or
 * command the line defines. Only such a program's arguments are plain data to bash.
 */
function isExternal(program: ShellWord, defined: LineCommands): boolean {
  if (program.dynamic) {
    return false;
  }
  if (program.text.includes('/')) {
    return true;
  }
  return !BASH_BUILTINS.has(program.text) && !BASH_KEYWORDS.has(program.text) && !defined.has(program.text);
}

/**
 * For each of `commands`, one bash parse, whether bash may read the held text of its words again (see `ShellWord.held`),
 * in this line or a later one: the arguments of a builtin, a reserved word, a function the line defines or a program only
 * known when it runs (resolved past `command`, `builtin` and quotes, as `launch` reads the head); the words of a command
 * inside a substitution or `(( ))`, whose output or value is read again; and text written for a later line, by an output
 * redirection, a pipe into `tee` or anything else that stores or reads it, or an in-place edit. A plain argument of any
 * other program, such as a perl or sed script, is data bash never reads again. Assignment words count everywhere (see
 * {@link isAssignmentWord}). Where it is unsure, it counts.
 */
export function rereadingCommands(commands: readonly ShellCommand[], defined: LineCommands): readonly boolean[] {
  const launches = commands.map((command) => launch(command.words, 'bash', command.stdin));
  const writes = (index: number): boolean => {
    const command = commands[index];
    const launched = launches[index];
    const writer = launched?.kind === 'program' && STDIN_WRITERS.has(programName(launched.program.text));
    return writer || command?.redirections.some(writesFile) === true;
  };
  // Text a later command of the same pipeline writes, or a builtin or a reserved word reads, may be read again.
  const stores = (index: number): boolean => {
    const launched = launches[index];
    return writes(index) || launched?.kind === 'nothing' || (launched?.kind === 'program' && !isExternal(launched.program, defined));
  };
  const lands = commands.map((command, index) => writes(index) || (PIPE.test(command.terminator) && pipedOnto(commands, index, stores)));
  // A group's, a loop's, a function's or `exec`'s redirection covers commands the guard does not tie to it, so all count.
  const covered = commands.some((command, index) => {
    const head = command.words[0]?.text ?? '';
    const launched = launches[index];
    const calls = launched?.kind === 'program' && defined.has(launched.program.text);
    const coversOthers = COMPOUND_ENDS.has(head) || command.terminator.startsWith(')') || (head === 'exec' && command.words.length === 1) || calls;
    return coversOthers && lands[index] === true;
  });
  // `((` and `))` stand among the separators, so the commands between them are the expression's words.
  let arithmetic = false;
  return commands.map((command, index) => {
    const terminator = command.terminator.replace(/\s/g, '');
    const inArithmetic = arithmetic || terminator.startsWith('))');
    const opens = terminator.lastIndexOf('((');
    const closes = terminator.lastIndexOf('))');
    arithmetic = opens > closes || (closes === -1 && arithmetic);
    const launched = launches[index];
    const program = launched?.kind === 'program' ? launched : undefined;
    const reads = program === undefined || !isExternal(program.program, defined) || editsInPlace(program);
    return covered || command.nesting > 0 || inArithmetic || lands[index] === true || reads;
  });
}

/** True when a command after `index` in its pipeline, at the same nesting, `stores` what it is handed. */
function pipedOnto(commands: readonly ShellCommand[], index: number, stores: (index: number) => boolean): boolean {
  const nesting = commands[index]?.nesting ?? 0;
  for (let next = index + 1; next < commands.length; next += 1) {
    const command = commands[next];
    if (command === undefined || command.nesting < nesting) {
      return false;
    }
    // A substitution's commands come before the command that holds them.
    if (command.nesting > nesting) {
      continue;
    }
    if (stores(next)) {
      return true;
    }
    if (!PIPE.test(command.terminator)) {
      return false;
    }
  }
  return false;
}
