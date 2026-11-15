import { launch, programName, staticWord, type Launch } from '../push-guard/launchers.ts';
import { Location } from '../push-guard/location.ts';
import { redirectsInput, stdinUse } from '../push-guard/stdin.ts';
import { parseShell, type Redirection, type ShellCommand, type ShellDialect, type ShellWord } from '../push-guard/tokenizer.ts';
import { resolveLiteralVariables } from '../push-guard/variables.ts';

/**
 * Every program a command line starts, read the way the push guard reads its git commands: as the shell would
 * (`parseShell`), following `cd` and friends, through launchers (`launch`) into nested scripts, and down a
 * `cat <<EOF | bash` pipe. It keeps no doubts: a part it cannot read starts no program it can name. It does note a
 * shell a pipe feeds with commands it cannot read (`fedShells`), for a guard that refuses what it cannot see.
 */

/** One program a command line starts. */
export interface ProgramRun {
  /** The program as the guards compare it (`programName`): `npx` for `C:\nodejs\npx.cmd`. */
  readonly name: string;
  /** The program word as the line writes it, after its literal variables: `C:\nodejs\npx.cmd`, or `npx` for a PATH lookup. */
  readonly program: ShellWord;
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
  /** True when `teamrig queue` or `teamrig test` starts it, at any depth, so it runs under the host lock. */
  readonly runner: boolean;
  /** Set when the command that starts it pipes its output on: `echo "$T" | docker login --password-stdin`. */
  readonly pipe: PipeOut | undefined;
  /** True when a PowerShell assignment takes its output: `$x = Get-Content f`. */
  readonly captured: boolean;
  /** Set when it runs inside a substitution or a PowerShell `( )`: its output becomes a value of the command holding it. */
  readonly substitution: Substitution | undefined;
}

/** Where a command's output goes when it pipes it on to the next command. */
export interface PipeOut {
  /** The program the next command starts; undefined when that is only known when it runs, or is a nested script. */
  readonly into: ProgramRun | undefined;
}

/** Where the output of a command inside a substitution goes: `cat t` in `curl -H "$(cat t)"`, or in `$x = (cat t)`. */
export interface Substitution {
  /** The command that takes the output as a value; undefined when that is only known when it runs, or is a `cd`. */
  readonly holder: ProgramRun | BareCommand | undefined;
}

/** A command that starts no program: a PowerShell expression such as `$env:HOME`, or a wrapper with nothing to run, such as a bare `env`. */
export interface BareCommand {
  readonly words: readonly ShellWord[];
  readonly dialect: ShellDialect;
  readonly redirections: readonly Redirection[];
  readonly pipe: PipeOut | undefined;
  readonly substitution: Substitution | undefined;
}

/** A pipe while the walker has not yet read the command it feeds. */
interface OpenPipe {
  into: ProgramRun | undefined;
}

/** A substitution while the walker has not yet read the command holding it, which bash reads after it. */
interface OpenSubstitution {
  holder: ProgramRun | BareCommand | undefined;
}

/** Where a nested script's own commands send their output: the pipe and the substitution of the command running it. */
interface Outlet {
  readonly pipe: OpenPipe | undefined;
  readonly substitution: OpenSubstitution | undefined;
}

/** What a command reads on stdin. */
interface Inlet {
  /** True when it reads the output of the command before it through a pipe. */
  readonly fromPipe: boolean;
  /** The text the line itself gives it; see {@link ProgramRun.stdin}. */
  readonly text: ShellWord | undefined;
  /** True when something feeds its stdin: its own pipe or text, or those of the command that starts its script. */
  readonly fed: boolean;
}

/** A run or a bare command while the walker may still learn where its output goes. */
type Draft<T> = { -readonly [K in keyof T]: T[K] };

/** What one command starts: its launch, and the program run or the bare command it adds, if any. */
interface Visited {
  readonly launched: Launch;
  readonly run: Draft<ProgramRun> | undefined;
  readonly bare: Draft<BareCommand> | undefined;
}

/** PowerShell: a `(` the reader is inside. */
interface Group {
  /** The command before the `(`, which takes the group's value; undefined when that is only known when it runs. */
  readonly holder: Draft<ProgramRun> | Draft<BareCommand> | undefined;
  /** False for a group that starts its command, as in `(gc f) | wc`, whose value is the command's own output. */
  readonly held: boolean;
}

/**
 * A command whose program word is only known when it runs (`$T exec approve R1`, with `T` set outside the line), or a
 * teamrig call whose subcommand is (`teamrig "$G" approve R1`).
 */
export interface OpaqueRun {
  readonly program: ShellWord;
  readonly args: readonly ShellWord[];
  readonly dialect: ShellDialect;
}

/** What a command line runs: the programs it starts, the commands of it that start none, and those whose program it cannot name. */
export interface LineRuns {
  readonly programs: ProgramRun[];
  readonly bare: BareCommand[];
  readonly opaque: OpaqueRun[];
  /** The dialect of the script holding each shell that takes its commands from a feed the walker cannot read: `x | bash`. */
  readonly fedShells: ShellDialect[];
}

export interface ProgramsContext {
  /** The folder the line starts in; undefined when it is not known. */
  readonly cwd: string | undefined;
  readonly home: string;
  readonly dialect: ShellDialect;
}

/** The outlet of the line's own commands: the screen. */
const SCREEN: Outlet = { pipe: undefined, substitution: undefined };

/** Nested scripts deeper than this are not read, as in the push guard. */
const MAX_SCRIPT_DEPTH = 8;
/** A separator that pipes a command's output into the next one: `|`, `|&`, `)|` after a group, or `|(` before a subshell, not `||`. */
const PIPE_END = /(?:^|[^|])\|&?[\n(]*$/;

/** What `command` runs, each in the order it runs. */
export function runsOf(command: string, context: ProgramsContext): LineRuns {
  const runs: LineRuns = { programs: [], bare: [], opaque: [], fedShells: [] };
  visitScript(staticWord(command), context.dialect, new Location(context.cwd, context.home), 0, false, runs, SCREEN, false);
  return runs;
}

/** The programs `command` starts, in the order it starts them. */
export function programsOf(command: string, context: ProgramsContext): ProgramRun[] {
  return runsOf(command, context).programs;
}

/**
 * Visits each command of a script; a plain `cat` hands its stdin down a pipe, so `cat <<EOF | bash` runs the body.
 * `runner` is true when a teamrig runner started the script; `outlet` takes the output of its commands that send it nowhere else;
 * `fed` is true when the command that started it has a fed stdin, which its own commands inherit.
 */
function visitScript(script: ShellWord, dialect: ShellDialect, location: Location, depth: number, runner: boolean, runs: LineRuns, outlet: Outlet, fed: boolean): void {
  if (depth > MAX_SCRIPT_DEPTH) {
    return;
  }
  const parsed = parseShell(script.text, dialect);
  // The line's own shell has the user's HOME; a script it starts may be handed another (`HOME=x bash -c`).
  const commands = dialect === 'bash' ? resolveLiteralVariables(parsed, depth === 0 ? location.home : undefined) : parsed.commands;
  let piped: { readonly body: ShellWord; readonly nesting: number } | undefined;
  /** Per nesting depth: the pipe the last command read at that depth sends its output into, if it pipes. */
  const pipes = new Map<number, OpenPipe>();
  /** Commands inside a substitution still waiting for the command after them that holds it, deepest last. */
  const unheld: Array<{ readonly nesting: number; readonly slot: OpenSubstitution }> = [];
  /** PowerShell: the groups the reader is inside, innermost last. */
  const groups: Group[] = [];
  for (const command of commands) {
    const pipeIn = pipes.get(command.nesting);
    const ownPipe: OpenPipe | undefined = PIPE_END.test(command.terminator) ? { into: undefined } : undefined;
    if (ownPipe === undefined) {
      pipes.delete(command.nesting);
    } else {
      pipes.set(command.nesting, ownPipe);
    }
    const ownSubstitution: OpenSubstitution | undefined = command.nesting > 0 ? { holder: undefined } : undefined;
    const grouped = dialect === 'powershell' && groups.length > 0;
    const outermost = command.nesting === 0 && !grouped;
    /** In `X (a) | y`, the pipe after the `)` takes the output of X, not of a. */
    const closed = dialect === 'powershell' && ownPipe !== undefined ? closedBeforePipe(command.terminator, groups) : undefined;
    const pipe = closed?.held === true ? undefined : (ownPipe ?? (outermost ? outlet.pipe : undefined));
    if (closed?.held === true && closed.holder !== undefined) {
      closed.holder.pipe = ownPipe;
    }
    const substitution = ownSubstitution ?? (grouped ? { holder: groups.at(-1)?.holder } : outlet.substitution);
    let stdin = command.stdin;
    if (piped !== undefined && command.nesting <= piped.nesting) {
      stdin ??= command.nesting === piped.nesting && !redirectsInput(command) ? piped.body : undefined;
      piped = undefined;
    }
    location.enter(command.subshells);
    const inlet: Inlet = { fromPipe: pipeIn !== undefined, text: stdin, fed: pipeIn !== undefined || stdin !== undefined || (fed && command.nesting === 0) };
    const visited = visitCommand(command, inlet, { pipe, substitution }, dialect, location, depth, runner, runs);
    if (pipeIn !== undefined) {
      pipeIn.into = visited?.run;
    }
    const holder = visited?.run ?? visited?.bare;
    for (let waiting = unheld.at(-1); waiting !== undefined && waiting.nesting > command.nesting; waiting = unheld.at(-1)) {
      waiting.slot.holder = holder;
      unheld.pop();
    }
    if (ownSubstitution !== undefined) {
      unheld.push({ nesting: command.nesting, slot: ownSubstitution });
    }
    if (dialect === 'powershell') {
      trackGroups(command.terminator, { holder, held: command.words.length > 0 }, groups);
    }
    if (stdin !== undefined) {
      piped = visited !== undefined && stdinUse(command, visited.launched) === 'passed' ? { body: stdin, nesting: command.nesting } : undefined;
    }
  }
}

/** Visits one simple command; returns what it starts, or undefined for a `cd`. */
function visitCommand(
  command: ShellCommand,
  inlet: Inlet,
  outlet: Outlet,
  dialect: ShellDialect,
  location: Location,
  depth: number,
  runner: boolean,
  runs: LineRuns,
): Visited | undefined {
  if (location.apply(command.words, dialect)) {
    return undefined;
  }
  const launched = launch(command.words, dialect, inlet.text);
  if (launched.kind === 'script') {
    const inner = location.child();
    launched.chdirs.forEach((chdir) => inner.moveTo(chdir, dialect));
    visitScript(launched.script, launched.dialect, inner, depth + 1, runner || launched.runner, runs, outlet, inlet.fed);
    if (launched.sameShell) {
      location.adopt(inner);
    }
  } else if (launched.kind === 'program' && !launched.program.dynamic) {
    const inner = location.child();
    launched.chdirs.forEach((chdir) => inner.moveTo(chdir, dialect));
    const run: Draft<ProgramRun> = {
      name: programName(launched.program.text),
      program: launched.program,
      args: launched.args,
      dialect,
      dir: inner.dir,
      redirections: command.redirections,
      stdin: inlet.text,
      piped: inlet.fromPipe,
      runner: runner || launched.runner,
      pipe: outlet.pipe,
      captured: launched.captured,
      substitution: outlet.substitution,
    };
    runs.programs.push(run);
    return { launched, run, bare: undefined };
  } else if (launched.kind === 'opaque' && launched.command !== undefined) {
    runs.opaque.push({ ...launched.command, dialect });
  } else if (launched.kind === 'opaque' && launched.stdinScript === true && inlet.fed) {
    runs.fedShells.push(dialect);
  } else if (launched.kind === 'nothing' && command.words.length > 0) {
    const bare: Draft<BareCommand> = { words: command.words, dialect, redirections: command.redirections, pipe: outlet.pipe, substitution: outlet.substitution };
    runs.bare.push(bare);
    return { launched, run: undefined, bare };
  }
  return { launched, run: undefined, bare: undefined };
}

/** PowerShell: opens `group` at each `(` of the terminator, and closes one at each `)`. */
function trackGroups(terminator: string, group: Group, groups: Group[]): void {
  for (const char of terminator) {
    if (char === '(') {
      groups.push(group);
    } else if (char === ')') {
      groups.pop();
    }
  }
}

/** PowerShell: the last group a terminator ending in a pipe closes before it, whose holder's output the pipe takes. */
function closedBeforePipe(terminator: string, groups: readonly Group[]): Group | undefined {
  const open = [...groups];
  let closed: Group | undefined;
  for (const char of terminator) {
    if (char === '(') {
      open.push({ holder: undefined, held: false });
    } else if (char === ')') {
      closed = open.pop();
    }
  }
  return closed;
}
