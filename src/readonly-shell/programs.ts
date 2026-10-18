/**
 * The programs the read-only shell hook lets run, and the arguments each may take: the plain readers any, the
 * rest only those that keep them from writing a file, running another program or reading a secret.
 */

/** One argument as the program receives it. */
export interface ProgramArgument {
  /** As written, quotes removed; a variable or a substitution stays as written. */
  readonly text: string;
  /** Part of it is only known when the shell runs it, so `text` is not what the program gets. */
  readonly dynamic: boolean;
  /** It reaches the program as exactly one argument whatever its variables hold: no unquoted variable or glob. */
  readonly single: boolean;
}

/** Whether a program, given these arguments (its own name left out), only reads. */
export type ArgumentCheck = (args: readonly ProgramArgument[]) => boolean;

/** Static text equal to `text`. */
function is(arg: ProgramArgument | undefined, text: string): boolean {
  return arg !== undefined && !arg.dynamic && arg.text === text;
}

/** The arguments before a static `--`, where a program still reads options; all of them when there is none. */
function optionsPart(args: readonly ProgramArgument[]): readonly ProgramArgument[] {
  const end = args.findIndex((arg) => is(arg, '--'));
  return end === -1 ? args : args.slice(0, end);
}

/** No variable or substitution where the program still reads options: one could expand to `--output=x`. */
function staticOptions(args: readonly ProgramArgument[]): boolean {
  return optionsPart(args).every((arg) => !arg.dynamic);
}

/**
 * Whether `text` is a long option that names, abbreviates or extends one of `names`: git and GNU tools take
 * any unique prefix, so `--out` is `--output`.
 */
function namesLongOption(text: string, names: readonly string[]): boolean {
  const option = /^--([^=]+)/.exec(text)?.[1];
  return option !== undefined && names.some((name) => name.startsWith(option) || option.startsWith(name));
}

/** Reads files or prints, whatever it is given. */
const anyArguments: ArgumentCheck = () => true;

const SED_FLAGS: ReadonlySet<string> = new Set(['-n', '-e', '-E', '-r', '--quiet', '--silent']);
const SED_ADDRESS = String.raw`(?:\/(?:[^\/\\\n]|\\.)*\/|[0-9$+]+)`;
const SED_PRINT_COMMAND = String.raw`(?:${SED_ADDRESS}\s*(?:,\s*${SED_ADDRESS}\s*)?)?p`;

/** A sed script of print commands alone, `;`-separated, each with an optional `/regex/` or line-number range. */
const SED_PRINT_SCRIPT = new RegExp(String.raw`^\s*${SED_PRINT_COMMAND}(?:\s*;\s*${SED_PRINT_COMMAND})*\s*;?\s*$`);

/**
 * sed that only prints a range: GNU sed reads options anywhere (`sed -n 1p -i f` edits in place), `-e` names the
 * script, else the first operand is; one static script of print commands, the rest are files.
 */
const sedArguments: ArgumentCheck = (args) => {
  if (!staticOptions(args)) {
    return false;
  }
  const scripts: ProgramArgument[] = [];
  const operands: ProgramArgument[] = [];
  let ended = false;
  const words = args.values();
  for (const arg of words) {
    if (ended || arg.text === '-' || !arg.text.startsWith('-')) {
      operands.push(arg);
    } else if (arg.text === '--') {
      ended = true;
    } else if (!SED_FLAGS.has(arg.text)) {
      return false;
    } else if (arg.text === '-e') {
      const script = words.next();
      if (script.done === true) {
        return false;
      }
      scripts.push(script.value);
    }
  }
  const [script, ...extra] = scripts.length === 0 ? operands.slice(0, 1) : scripts;
  return script !== undefined && extra.length === 0 && !script.dynamic && SED_PRINT_SCRIPT.test(script.text);
};

const AWK_FIELD = String.raw`(?:\$\d+|NR|NF)`;
/** `{print}` or `{print $1, NR}`: no expression a program could hide a `system()` or a `>` in. */
const AWK_PRINT_PROGRAM = new RegExp(String.raw`^\{\s*print(?:\s+${AWK_FIELD}(?:\s*,\s*${AWK_FIELD})*)?\s*;?\s*\}$`);

/**
 * awk running a plain print program: before it only `-F` and `-v`, static (`-f`, `-i` and `-l` load code); the
 * program static; the words after it are files, which awk no longer reads as options.
 */
const awkArguments: ArgumentCheck = (args) => {
  let index = 0;
  while (index < args.length) {
    const arg = args[index];
    if (arg === undefined || arg.dynamic) {
      return false;
    }
    if (arg.text === '--') {
      index += 1;
      break;
    }
    if (arg.text === '-F' || arg.text === '-v') {
      const value = args[index + 1];
      if (value === undefined || value.dynamic) {
        return false;
      }
      index += 2;
    } else if (/^-[Fv]./.test(arg.text)) {
      index += 1;
    } else if (arg.text.startsWith('-')) {
      return false;
    } else {
      break;
    }
  }
  const program = args[index];
  return program !== undefined && !program.dynamic && AWK_PRINT_PROGRAM.test(program.text);
};

/** sort that prints: no `-o`, alone or in a cluster such as `-uo`, no `--output`, no `--compress-program`. */
const sortArguments: ArgumentCheck = (args) =>
  staticOptions(args) &&
  optionsPart(args).every((arg) => !/^-[^-]*o/.test(arg.text) && !namesLongOption(arg.text, ['output', 'compress-program']));

/** The test operators that take an operand on each side; with one in the middle of three, `test` compares the two. */
const TEST_BINARY: ReadonlySet<string> = new Set(['=', '==', '!=', '<', '>', '-eq', '-ne', '-lt', '-le', '-gt', '-ge', '-ef', '-nt', '-ot', '-a', '-o']);

/**
 * `test` and `[`: `-v` and `-R` read a variable name, and bash evaluates a subscript in it (`-v 'a[$(cmd)]'`), so
 * neither may appear, nor a value that could become one: each word one argument, and a variable only where
 * the argument count leaves it an operand.
 */
function testOperands(operands: readonly ProgramArgument[]): boolean {
  if (operands.some((arg) => !arg.single || is(arg, '-v') || is(arg, '-R'))) {
    return false;
  }
  const [first, middle] = operands;
  switch (operands.length) {
    case 0:
    case 1:
      return true;
    case 2:
      return first !== undefined && !first.dynamic;
    case 3:
      return middle !== undefined && !middle.dynamic && TEST_BINARY.has(middle.text);
    default:
      return operands.every((arg) => !arg.dynamic);
  }
}

const testArguments: ArgumentCheck = (args) => testOperands(args);

/** `[ ... ]`: the operands of `test`, closed by a `]`. */
const bracketArguments: ArgumentCheck = (args) => is(args.at(-1), ']') && testOperands(args.slice(0, -1));

const GIT_READERS: ReadonlySet<string> = new Set([
  'status',
  'log',
  'diff',
  'show',
  'blame',
  'grep',
  'shortlog',
  'describe',
  'ls-files',
  'ls-tree',
  'rev-parse',
  'rev-list',
  'diff-tree',
  'show-ref',
  'cat-file',
  'count-objects',
  'check-ignore',
  'merge-base',
]);

/** Long options that write a file (`--output`), run a configured diff program or open a pager command. */
const GIT_WRITERS = ['output', 'ext-diff', 'open-files-in-pager'] as const;

/**
 * git reading its repository: before the subcommand only `--no-pager`, `-P` and `-C <dir>` (never `-c`, which
 * sets any config); a read-only subcommand; no option that writes or runs a program, `git grep -O` included.
 */
const gitArguments: ArgumentCheck = (args) => {
  let index = 0;
  while (is(args[index], '--no-pager') || is(args[index], '-P') || is(args[index], '-C')) {
    if (is(args[index], '-C')) {
      const folder = args[index + 1];
      if (folder === undefined || !folder.single) {
        return false;
      }
      index += 1;
    }
    index += 1;
  }
  const subcommand = args[index];
  if (subcommand === undefined || subcommand.dynamic || !GIT_READERS.has(subcommand.text)) {
    return false;
  }
  const rest = args.slice(index + 1);
  return (
    staticOptions(rest) &&
    optionsPart(rest).every((arg) => !namesLongOption(arg.text, GIT_WRITERS) && !(subcommand.text === 'grep' && /^-[^-]*O/.test(arg.text)))
  );
};

const KUBECTL_READERS: ReadonlySet<string> = new Set(['logs', 'get', 'describe', 'top', 'explain', 'api-resources', 'api-versions', 'version', 'cluster-info']);

/** kubectl commands that only read with these subcommands. */
const KUBECTL_GROUPS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['config', new Set(['view', 'current-context', 'get-contexts', 'get-clusters', 'get-users'])],
  ['rollout', new Set(['status', 'history'])],
]);

/**
 * kubectl options a read must not take: `--raw` and `--flatten` print credentials, `--kubeconfig` can run the
 * exec plugin of any file, `--server` sends the token elsewhere, the rest write files. kubectl takes no
 * abbreviations, so the exact names are enough.
 */
const KUBECTL_FORBIDDEN: ReadonlySet<string> = new Set([
  '--raw',
  '--flatten',
  '--kubeconfig',
  '--server',
  '--token',
  '--cache-dir',
  '--log-file',
  '--log-dir',
  '--profile-output',
]);

/** Short flags of the read commands that take no value, so the letters after one are more flags. */
const KUBECTL_SHORT_SWITCHES: ReadonlySet<string> = new Set(['A', 'w', 'p', 'R', 'h', 'f']);
/** Short flags that take a value: the letters after one are that value. */
const KUBECTL_SHORT_VALUES: ReadonlySet<string> = new Set(['o', 'n', 'l', 'L', 'c', 'k', 'v']);

/** Whether a short-flag cluster such as `-Ao` stays clear of `-s` (`--server`), reading flags until one takes a value. */
function kubectlShortFlags(text: string): boolean {
  for (const letter of text.slice(1)) {
    if (KUBECTL_SHORT_VALUES.has(letter)) {
      return true;
    }
    if (!KUBECTL_SHORT_SWITCHES.has(letter)) {
      return false;
    }
  }
  return true;
}

/** One static kubectl argument: no forbidden option, no secret named, no `-s` in a short-flag cluster. */
function kubectlArgument(arg: ProgramArgument): boolean {
  if (/secret/i.test(arg.text) || KUBECTL_FORBIDDEN.has(arg.text.split('=')[0] ?? '')) {
    return false;
  }
  return !/^-[^-]/.test(arg.text) || kubectlShortFlags(arg.text);
}

/**
 * kubectl reading the cluster: the read command right after `kubectl` (a leading flag is not read), `config`
 * and `rollout` only with their read subcommands, no `cluster-info dump`, and every argument static.
 */
const kubectlArguments: ArgumentCheck = (args) => {
  const [command, subcommand] = args;
  if (command === undefined || command.dynamic) {
    return false;
  }
  const group = KUBECTL_GROUPS.get(command.text);
  if (!KUBECTL_READERS.has(command.text) && (group === undefined || subcommand === undefined || subcommand.dynamic || !group.has(subcommand.text))) {
    return false;
  }
  const rest = args.slice(group === undefined ? 1 : 2);
  if (command.text === 'cluster-info' && rest.some((arg) => is(arg, 'dump'))) {
    return false;
  }
  return rest.every((arg) => !arg.dynamic && kubectlArgument(arg));
};

/** Every program the hook lets run, by the name the line calls it by, with what its arguments may be. */
export const PROGRAMS: ReadonlyMap<string, ArgumentCheck> = new Map([
  ...['cd', 'pushd', 'popd', 'pwd', 'grep', 'egrep', 'fgrep', 'head', 'tail', 'cat', 'nl', 'wc', 'cut', 'tr', 'ls', 'echo', 'sleep', 'true', 'false', 'exit'].map(
    (name): [string, ArgumentCheck] => [name, anyArguments],
  ),
  ['sed', sedArguments],
  ['awk', awkArguments],
  ['sort', sortArguments],
  ['test', testArguments],
  ['[', bracketArguments],
  ['git', gitArguments],
  ['kubectl', kubectlArguments],
]);

/** Whether `program`, given `args`, only reads: false for any program the hook does not know. */
export function programReads(program: string, args: readonly ProgramArgument[]): boolean {
  return PROGRAMS.get(program)?.(args) ?? false;
}
