import { launch, programName, staticWord, type Launch } from '../push-guard/launchers.ts';
import { Location } from '../push-guard/location.ts';
import { redirectsInput, stdinUse } from '../push-guard/stdin.ts';
import { parseShell, type Redirection, type ShellCommand, type ShellDialect, type ShellWord } from '../push-guard/tokenizer.ts';
import { resolveLiteralVariables } from '../push-guard/variables.ts';

/**
 * Every program a command line starts, read the way the push guard reads its git commands: as the shell would
 * (`parseShell`), following `cd` and friends, through launchers (`launch`) into nested scripts, and down a
 * `cat <<EOF | bash` pipe. It keeps no doubts: a part it cannot read starts no program it can name.
 */

/** One program a command line starts. */
export interface ProgramRun {
  /** The program as the guards compare it (`programName`): `npx` for `C:\nodejs\npx.cmd`. */
  readonly name: string;
  readonly args: readonly ShellWord[];
  /** The folder it starts in; undefined when that is only known when the line runs. */
  readonly dir: string | undefined;
  /** The redirections of the command that starts it, such as `> out.log`. */
  readonly redirections: readonly Redirection[];
  /** True when the command that starts it reads the output of the command before it through a pipe. */
  readonly piped: boolean;
}

export interface ProgramsContext {
  /** The folder the line starts in; undefined when it is not known. */
  readonly cwd: string | undefined;
  readonly home: string;
  readonly dialect: ShellDialect;
}

/** Nested scripts deeper than this are not read, as in the push guard. */
const MAX_SCRIPT_DEPTH = 8;
/** A separator that pipes a command's output into the next one: `|`, `|&`, or `)|` after a group, not `||`. */
const PIPE_END = /(?:^|[^|])\|&?\n*$/;

/** The programs `command` starts, in the order it starts them. */
export function programsOf(command: string, context: ProgramsContext): ProgramRun[] {
  const runs: ProgramRun[] = [];
  visitScript(staticWord(command), context.dialect, new Location(context.cwd, context.home), 0, runs);
  return runs;
}

/** Visits each command of a script; a plain `cat` hands its stdin down a pipe, so `cat <<EOF | bash` runs the body. */
function visitScript(script: ShellWord, dialect: ShellDialect, location: Location, depth: number, runs: ProgramRun[]): void {
  if (depth > MAX_SCRIPT_DEPTH) {
    return;
  }
  const parsed = parseShell(script.text, dialect);
  const commands = dialect === 'bash' ? resolveLiteralVariables(parsed) : parsed.commands;
  let piped: { readonly body: ShellWord; readonly nesting: number } | undefined;
  /** Per nesting depth: whether the last command read at that depth pipes into the next. */
  const pipes = new Map<number, boolean>();
  for (const command of commands) {
    const fromPipe = pipes.get(command.nesting) === true;
    pipes.set(command.nesting, PIPE_END.test(command.terminator));
    let stdin = command.stdin;
    if (piped !== undefined && command.nesting <= piped.nesting) {
      stdin ??= command.nesting === piped.nesting && !redirectsInput(command) ? piped.body : undefined;
      piped = undefined;
    }
    location.enter(command.subshells);
    const launched = visitCommand(command, fromPipe, dialect, location, depth, stdin, runs);
    if (stdin !== undefined) {
      piped = launched !== undefined && stdinUse(command, launched) === 'passed' ? { body: stdin, nesting: command.nesting } : undefined;
    }
  }
}

/** Visits one simple command; returns what it starts, or undefined for a `cd`. */
function visitCommand(
  command: ShellCommand,
  fromPipe: boolean,
  dialect: ShellDialect,
  location: Location,
  depth: number,
  stdin: ShellWord | undefined,
  runs: ProgramRun[],
): Launch | undefined {
  if (location.apply(command.words, dialect)) {
    return undefined;
  }
  const launched = launch(command.words, dialect, stdin);
  if (launched.kind === 'script') {
    const inner = location.child();
    launched.chdirs.forEach((chdir) => inner.moveTo(chdir));
    visitScript(launched.script, launched.dialect, inner, depth + 1, runs);
    if (launched.sameShell) {
      location.adopt(inner);
    }
  } else if (launched.kind === 'program' && !launched.program.dynamic) {
    const inner = location.child();
    launched.chdirs.forEach((chdir) => inner.moveTo(chdir));
    runs.push({ name: programName(launched.program.text), args: launched.args, dir: inner.dir, redirections: command.redirections, piped: fromPipe });
  }
  return launched;
}
