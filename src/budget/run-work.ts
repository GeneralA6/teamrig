import { programsOf, type ProgramRun, type ProgramsContext } from '../package-guard/programs.ts';
import { EXEC_VALUED, NPM_VALUED } from '../package-guard/runners.ts';
import { programName } from '../push-guard/launchers.ts';
import type { ShellDialect, ShellWord } from '../push-guard/tokenizer.ts';
import type { ToolUse } from './line.ts';

/**
 * What one program a shell call starts does, read from the program and its own arguments as the shell splits them
 * (`programsOf`; T483, T505, T551): words inside a quoted argument, such as a `teamrig add --description` that
 * quotes `npm test` or `git commit`, run nothing. The budget's tool kinds (`kindOf`) and the lead boundary both
 * read a shell call this way.
 * - `edit`: writes a file: `cat` into a file, `sed` or `perl` in place, `patch`, `Set-Content`, `Out-File`, or a
 *   node script given on the line (`-e`, `-p`) or on stdin that calls `writeFileSync`.
 * - `gitPatch`: `git apply`, which patches the work tree's files.
 * - `gitWrite`: any other git step that changes a repository, such as `git commit` or `git push`.
 * - `testFull`: a whole test suite: `npm test`, an npm test, verify, check or coverage script, jest, vitest, or
 *   `node --test` with no files or over all of `src/` or `tools/`.
 * - `testTargeted`: `node --test` of the files it names.
 * - `build`: an npm build, typecheck or lint script, or `tsc`.
 * - `search`: grep, rg, find, Select-String or `git grep` over files; one that reads a pipe filters output instead.
 * - `teamrig`: a teamrig command that reads or writes the register, such as `teamrig list` or `teamrig set`.
 */
export type RunWork = 'edit' | 'gitPatch' | 'gitWrite' | 'testFull' | 'testTargeted' | 'build' | 'search' | 'teamrig';

/** The shells whose calls start programs, by tool name. */
export const SHELL_DIALECTS: ReadonlyMap<string, ShellDialect> = new Map<string, ShellDialect>([
  ['Bash', 'bash'],
  ['PowerShell', 'powershell'],
]);
/** A command is read long after it ran, in no known folder: no work here depends on one. */
const NO_FOLDER: Omit<ProgramsContext, 'dialect'> = { cwd: undefined, home: '/' };

/** git's options before its subcommand that take the next word as their value. */
export const GIT_VALUED: ReadonlySet<string> = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env']);
/** git subcommands that change a repository; `apply` also patches the work tree. */
const GIT_WRITES: ReadonlySet<string> = new Set(['commit', 'push', 'merge', 'rebase', 'cherry-pick', 'revert', 'reset', 'apply', 'am']);
/** npm's own test command and its aliases. */
const NPM_TESTS: ReadonlySet<string> = new Set(['test', 't', 'tst']);
const NPM_RUN: ReadonlySet<string> = new Set(['run', 'run-script', 'rum', 'urn']);
/** An npm script that runs tests, such as `test:unit`. */
const TEST_SCRIPT = /^(?:test|verify|check|coverage)(?::[\w:-]+)?$/;
/** An npm script that builds or checks the code without running tests, such as `build:dist`. */
const BUILD_SCRIPT = /^(?:build|typecheck|lint)(?::[\w:-]+)?$/;
/** Programs that are a test run or a build wherever they start: on the path, through `npx`, or as node's script. */
const CHECK_PROGRAMS: ReadonlyMap<string, RunWork> = new Map<string, RunWork>([
  ['jest', 'testFull'],
  ['vitest', 'testFull'],
  ['tsc', 'build'],
]);
/** node's options whose value is a script it runs. */
const NODE_EVAL: ReadonlySet<string> = new Set(['-e', '--eval', '-p', '--print']);
/** A `node --test` file pattern over a whole source folder: the full suite. */
const FULL_SUITE = /^(?:\.\/)?(?:src|tools)\/\*\*/;
/** teamrig's own build, run by node from a checkout. */
const TEAMRIG_BUILD = /(?:^|\/)dist\/cli\/main\.js$/;
/** A node script's extension, dropped to name the program it is. */
const SCRIPT_EXTENSION = /\.[cm]?js$/;
/** teamrig subcommands that read or write the register. */
const TEAMRIG_REGISTER: ReadonlySet<string> = new Set(['list', 'show', 'check', 'inbox', 'add', 'set', 'who', 'plan', 'doctor', 'refresh', 'open', 'status', 'config', 'history']);
/** PowerShell cmdlets that write a file. */
const WRITE_CMDLETS: ReadonlySet<string> = new Set(['set-content', 'out-file']);
/** An in-place option of sed or perl: `-i`, `-i.bak`, `-pi`, `--in-place`. */
const IN_PLACE = /^-[A-Za-z]*i|^--in-place\b/;
/** A redirection that writes stdout to a file: `>`, `>>`, `>|`, `1>`, `&>`. */
const FILE_WRITE = /^[1&]?>[>|]?$/;
/** A redirection target that is no file: a device such as `/dev/null`, or cmd's `NUL`. */
const DEVICE = /^\/dev\/|^nul$/i;
/** Programs that search files; one that reads a pipe filters output instead. */
const SEARCHES: ReadonlySet<string> = new Set(['grep', 'rg', 'find', 'select-string']);
const NO_VALUED: ReadonlySet<string> = new Set();

/** The programs a shell tool call starts, in the order it starts them; none for any other tool or a call without a command. */
export function shellRunsOf(tool: Pick<ToolUse, 'name' | 'command'>): readonly ProgramRun[] {
  const dialect = SHELL_DIALECTS.get(tool.name);
  return dialect === undefined || tool.command === undefined ? [] : programsOf(tool.command, { ...NO_FOLDER, dialect });
}

/** The first word that is not an option, skipping the value of each option in `valued`, with its index. */
function firstOperand(args: readonly ShellWord[], valued: ReadonlySet<string>): { readonly word: ShellWord; readonly index: number } | undefined {
  let value = false;
  for (const [index, word] of args.entries()) {
    if (!value && (word.dynamic || !word.text.startsWith('-'))) {
      return { word, index };
    }
    value = !value && valued.has(word.text);
  }
  return undefined;
}

/** The first operand's text; undefined when there is none or it is only known when the line runs. */
function operandText(args: readonly ShellWord[], valued: ReadonlySet<string>): string | undefined {
  const operand = firstOperand(args, valued)?.word;
  return operand === undefined || operand.dynamic ? undefined : operand.text;
}

/** npm: `npm test` (`t`, `tst`) and `npm run` of a test script run tests; `npm run` of a build script builds. */
function npmWork(args: readonly ShellWord[]): RunWork | undefined {
  const found = firstOperand(args, NPM_VALUED);
  if (found === undefined || found.word.dynamic) {
    return undefined;
  }
  if (NPM_TESTS.has(found.word.text)) {
    return 'testFull';
  }
  const script = NPM_RUN.has(found.word.text) ? operandText(args.slice(found.index + 1), NPM_VALUED) : undefined;
  if (script === undefined) {
    return undefined;
  }
  if (TEST_SCRIPT.test(script)) {
    return 'testFull';
  }
  return BUILD_SCRIPT.test(script) ? 'build' : undefined;
}

/** A script node runs from a file: a test or build program's own (`node_modules/typescript/bin/tsc`), or teamrig's build. */
function nodeScriptWork(script: ShellWord): RunWork | undefined {
  if (script.dynamic) {
    return undefined;
  }
  const path = script.text.replace(/\\/g, '/');
  return TEAMRIG_BUILD.test(path) ? 'teamrig' : CHECK_PROGRAMS.get(programName(path).replace(SCRIPT_EXTENSION, ''));
}

/** A script node reads on stdin, such as a heredoc's body, edits when it calls `writeFileSync`. */
function stdinScriptWork(stdin: ShellWord | undefined): RunWork | undefined {
  return stdin !== undefined && stdin.text.includes('writeFileSync') ? 'edit' : undefined;
}

/**
 * node: `--test` among its options runs tests, the full suite with no files or a pattern over a whole source
 * folder; a script given on the line (`-e`, `-p`) or on stdin (`node -`, or no script) that calls `writeFileSync`
 * edits; a script file is the work of the program it is (`nodeScriptWork`).
 */
function nodeWork(args: readonly ShellWord[], stdin: ShellWord | undefined): RunWork | undefined {
  let tests = false;
  let inline = false;
  let evaluates = false;
  for (const [index, word] of args.entries()) {
    const { text } = word;
    if (inline) {
      if (text.includes('writeFileSync')) {
        return 'edit';
      }
      inline = false;
      continue;
    }
    if (text === '-' || !text.startsWith('-')) {
      if (tests) {
        return args.slice(index).some((file) => !file.dynamic && FULL_SUITE.test(file.text)) ? 'testFull' : 'testTargeted';
      }
      if (evaluates) {
        return undefined;
      }
      return text === '-' ? stdinScriptWork(stdin) : nodeScriptWork(word);
    }
    const equals = text.indexOf('=');
    const option = equals === -1 ? text : text.slice(0, equals);
    if (NODE_EVAL.has(option) && equals !== -1 && text.includes('writeFileSync', equals)) {
      return 'edit';
    }
    inline = NODE_EVAL.has(option) && equals === -1;
    evaluates ||= NODE_EVAL.has(option);
    tests ||= option === '--test';
  }
  if (tests) {
    return 'testFull';
  }
  return evaluates ? undefined : stdinScriptWork(stdin);
}

/** The run's stdout goes to a file (one only known when the line runs counts), not to a device. */
function writesFile(run: ProgramRun): boolean {
  return run.redirections.some(
    (redirection) => FILE_WRITE.test(redirection.operator) && redirection.target !== undefined && (redirection.target.dynamic || !DEVICE.test(redirection.target.text)),
  );
}

function gitWork(run: ProgramRun): RunWork | undefined {
  const subcommand = operandText(run.args, GIT_VALUED);
  if (subcommand === 'apply') {
    return 'gitPatch';
  }
  if (subcommand !== undefined && GIT_WRITES.has(subcommand)) {
    return 'gitWrite';
  }
  return subcommand === 'grep' && !run.piped ? 'search' : undefined;
}

/** A teamrig command's own arguments: `teamrig`'s, or those after teamrig's build when node runs it; undefined for any other program. */
export function teamrigArgsOf(run: ProgramRun): readonly ShellWord[] | undefined {
  if (run.name === 'teamrig') {
    return run.args;
  }
  const script = run.name === 'node' ? firstOperand(run.args, NO_VALUED) : undefined;
  return script !== undefined && !script.word.dynamic && TEAMRIG_BUILD.test(script.word.text.replace(/\\/g, '/')) ? run.args.slice(script.index + 1) : undefined;
}

/** What one program a shell call starts does (`RunWork`); undefined for anything else, a plain read among them. */
export function runWorkOf(run: ProgramRun): RunWork | undefined {
  switch (run.name) {
    case 'git':
      return gitWork(run);
    case 'cat':
      return writesFile(run) ? 'edit' : undefined;
    case 'sed':
    case 'perl':
      return run.args.some((arg) => !arg.dynamic && IN_PLACE.test(arg.text)) ? 'edit' : undefined;
    case 'patch':
      return 'edit';
    case 'npm':
      return npmWork(run.args);
    case 'npx': {
      const bin = operandText(run.args, EXEC_VALUED);
      return bin === undefined ? undefined : CHECK_PROGRAMS.get(programName(bin));
    }
    case 'node':
      return nodeWork(run.args, run.stdin);
    case 'teamrig': {
      const subcommand = operandText(run.args, NO_VALUED);
      return subcommand !== undefined && TEAMRIG_REGISTER.has(subcommand) ? 'teamrig' : undefined;
    }
    default:
      if (WRITE_CMDLETS.has(run.name)) {
        return 'edit';
      }
      return CHECK_PROGRAMS.get(run.name) ?? (SEARCHES.has(run.name) && run.args.length > 0 && !run.piped ? 'search' : undefined);
  }
}
