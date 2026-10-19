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
  /** The dialect of the script that starts it: a `pwsh -Command` inside a Bash line starts PowerShell programs. */
  readonly dialect: ShellDialect;
  /** The folder it starts in; undefined when that is only known when the line runs. */
  readonly dir: string | undefined;
  /** The redirections of the command that starts it, such as `> out.log`. */
  readonly redirections: readonly Redirection[];
  /** What it reads on stdin from the line itself: a here-document, a here-string, or one a plain `cat` pipes to it. */
  readonly stdin: ShellWord | undefined;
  /** True when the command that starts it reads the output of the command before it through a pipe. */
  readonly piped: boolean;
  /** True when `teamrig heavy` or `teamrig test` starts it, at any depth, so it runs under the host lock. */
  readonly runner: boolean;
  /** Set when the command that starts it pipes its output on: `echo "$T" | docker login --password-stdin`. */
  readonly pipe: PipeOut | undefined;
}

/** Where a command's output goes when it pipes it on to the next command. */
export interface PipeOut {
  /** The program the next command starts; undefined when that is only known when it runs, or is a nested script. */
  readonly into: ProgramRun | undefined;
}

/** A command that starts no program: a PowerShell expression such as `$env:HOME`, or a wrapper with nothing to run, such as a bare `env`. */
export interface BareCommand {
  readonly words: readonly ShellWord[];
  readonly dialect: ShellDialect;
  readonly redirections: readonly Redirection[];
  readonly pipe: PipeOut | undefined;
}

/** A pipe while the walker has not yet read the command it feeds. */
interface OpenPipe {
  into: ProgramRun | undefined;
}

/** What one command starts: its launch, and the program run it adds, if any. */
interface Visited {
  readonly launched: Launch;
  readonly run: ProgramRun | undefined;
}

/** What a command line runs: the programs it starts, and the commands of it that start none. */
export interface LineRuns {
  readonly programs: ProgramRun[];
  readonly bare: BareCommand[];
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

/** What `command` runs, each in the order it runs. */
export function runsOf(command: string, context: ProgramsContext): LineRuns {
  const runs: LineRuns = { programs: [], bare: [] };
  visitScript(staticWord(command), context.dialect, new Location(context.cwd, context.home), 0, false, runs);
  return runs;
}

/** The programs `command` starts, in the order it starts them. */
export function programsOf(command: string, context: ProgramsContext): ProgramRun[] {
  return runsOf(command, context).programs;
}

/**
 * Visits each command of a script; a plain `cat` hands its stdin down a pipe, so `cat <<EOF | bash` runs the body.
 * `runner` is true when a teamrig runner started the script.
 */
function visitScript(script: ShellWord, dialect: ShellDialect, location: Location, depth: number, runner: boolean, runs: LineRuns): void {
  if (depth > MAX_SCRIPT_DEPTH) {
    return;
  }
  const parsed = parseShell(script.text, dialect);
  const commands = dialect === 'bash' ? resolveLiteralVariables(parsed) : parsed.commands;
  let piped: { readonly body: ShellWord; readonly nesting: number } | undefined;
  /** Per nesting depth: the pipe the last command read at that depth sends its output into, if it pipes. */
  const pipes = new Map<number, OpenPipe>();
  for (const command of commands) {
    const pipeIn = pipes.get(command.nesting);
    const pipe: OpenPipe | undefined = PIPE_END.test(command.terminator) ? { into: undefined } : undefined;
    if (pipe === undefined) {
      pipes.delete(command.nesting);
    } else {
      pipes.set(command.nesting, pipe);
    }
    let stdin = command.stdin;
    if (piped !== undefined && command.nesting <= piped.nesting) {
      stdin ??= command.nesting === piped.nesting && !redirectsInput(command) ? piped.body : undefined;
      piped = undefined;
    }
    location.enter(command.subshells);
    const visited = visitCommand(command, pipeIn !== undefined, pipe, dialect, location, depth, stdin, runner, runs);
    if (pipeIn !== undefined) {
      pipeIn.into = visited?.run;
    }
    if (stdin !== undefined) {
      piped = visited !== undefined && stdinUse(command, visited.launched) === 'passed' ? { body: stdin, nesting: command.nesting } : undefined;
    }
  }
}

/** Visits one simple command; returns what it starts, or undefined for a `cd`. */
function visitCommand(
  command: ShellCommand,
  fromPipe: boolean,
  pipe: PipeOut | undefined,
  dialect: ShellDialect,
  location: Location,
  depth: number,
  stdin: ShellWord | undefined,
  runner: boolean,
  runs: LineRuns,
): Visited | undefined {
  if (location.apply(command.words, dialect)) {
    return undefined;
  }
  const launched = launch(command.words, dialect, stdin);
  if (launched.kind === 'script') {
    const inner = location.child();
    launched.chdirs.forEach((chdir) => inner.moveTo(chdir));
    visitScript(launched.script, launched.dialect, inner, depth + 1, runner || launched.runner, runs);
    if (launched.sameShell) {
      location.adopt(inner);
    }
  } else if (launched.kind === 'program' && !launched.program.dynamic) {
    const inner = location.child();
    launched.chdirs.forEach((chdir) => inner.moveTo(chdir));
    const run: ProgramRun = {
      name: programName(launched.program.text),
      args: launched.args,
      dialect,
      dir: inner.dir,
      redirections: command.redirections,
      stdin,
      piped: fromPipe,
      runner: runner || launched.runner,
      pipe,
    };
    runs.programs.push(run);
    return { launched, run };
  } else if (launched.kind === 'nothing' && command.words.length > 0) {
    runs.bare.push({ words: command.words, dialect, redirections: command.redirections, pipe });
  }
  return { launched, run: undefined };
}
