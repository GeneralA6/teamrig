import { spawn } from 'node:child_process';
import { errorCode, errorMessage } from '../core/guards.ts';
import type { Env } from '../core/home.ts';

/** A program started with no shell in between, so each argument reaches it exactly as written. */
export interface ProgramRequest {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
}

/**
 * How a terminal's launcher behaves. `exit`: it returns once the tab is open, so its exit code says
 * whether that worked. `spawn`: it is the terminal window itself, so starting it is all there is.
 */
export type StartMode = 'exit' | 'spawn';

export interface StartRequest extends ProgramRequest {
  readonly mode: StartMode;
}

/**
 * How a started program's launch ended: an `exit` launcher `exited` 0 once its tab was open, or was still `running`
 * when the wait ended (some stay up as the window); a `spawn` launcher or a hidden program was `spawned`, which is all
 * there is to know of it.
 */
export type LaunchEnd = 'exited' | 'running' | 'spawned';

export type StartOutcome =
  | { readonly kind: 'started'; readonly end: LaunchEnd }
  /** The program is not installed (or not on PATH). */
  | { readonly kind: 'missing' }
  | { readonly kind: 'failed'; readonly error: string };

export interface RunRequest extends ProgramRequest {
  readonly env: Env;
}

/** A hidden background program; nobody reads its output unless it goes to a log. */
export interface HiddenRequest extends RunRequest {
  /** The file its output and errors are appended to, made with its folder when missing; without it they are dropped. */
  readonly log?: string;
  /**
   * A console program that runs nothing without a console, as Windows PowerShell 5.1 exits 0 at once when started
   * detached. On Windows it starts with a hidden console of its own, beside one more node process that keeps that
   * console until the program exits.
   */
  readonly needsConsole?: boolean;
}

export type RunOutcome = { readonly kind: 'exited'; readonly code: number } | { readonly kind: 'missing' } | { readonly kind: 'failed'; readonly error: string };

/** The child processes `teamrig open`, `teamrig launch` and the hooks start, as one port so all run in tests. */
export interface Processes {
  /** Starts a terminal launcher in the background; its output is not shown. */
  start(request: StartRequest): Promise<StartOutcome>;
  /** Runs a program in this terminal, its input and output this process's own, until it exits. */
  run(request: RunRequest): Promise<RunOutcome>;
  /**
   * Starts a program with no window that runs on after this process ends, or is killed with every process it
   * started, with the given variables; its output goes to the request's log, or is dropped without one.
   */
  startHidden(request: HiddenRequest): Promise<StartOutcome>;
}

/** The interrupt signal this process gets; `process` itself in production. */
export interface Interrupts {
  on(event: 'SIGINT', listener: () => void): unknown;
  off(event: 'SIGINT', listener: () => void): unknown;
}

export interface NodeProcessesOptions {
  /** How long an `exit` launcher may run before it counts as started; some stay up as the window. */
  readonly exitWaitMs?: number;
  readonly interrupts?: Interrupts;
}

/** Long enough for any launcher that returns at all; one that is still running is then left alone. */
export const EXIT_WAIT_MS = 10_000;
/** The most of a failed launcher's error output a report repeats. */
const ERROR_TEXT_MAX = 300;

/** A program that could not start: not installed, or another reason in words. */
export function outcomeOfError(error: unknown): { readonly kind: 'missing' } | { readonly kind: 'failed'; readonly error: string } {
  return errorCode(error) === 'ENOENT' ? { kind: 'missing' } : { kind: 'failed', error: errorMessage(error) };
}

/** Why a launcher failed: its exit code or signal, and the first line it wrote to stderr. */
export function exitText(code: number | null, stderr: string): string {
  const [first = ''] = stderr.trim().split(/\r?\n/);
  const why = code === null ? 'ended by a signal' : `exited with code ${code}`;
  return first === '' ? why : `${why}: ${first.slice(0, ERROR_TEXT_MAX)}`;
}

/** An `exit` launcher: waits for its exit code, or treats it as started once it outlives the wait. */
function startUntilExit(request: StartRequest, waitMs: number): Promise<StartOutcome> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(request.command, request.args, { cwd: request.cwd, stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (error) {
      resolve(outcomeOfError(error));
      return;
    }
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(0, ERROR_TEXT_MAX * 2);
    });
    const timer = setTimeout(() => {
      child.stderr.destroy();
      child.unref();
      resolve({ kind: 'started', end: 'running' });
    }, waitMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      resolve(outcomeOfError(error));
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? { kind: 'started', end: 'exited' } : { kind: 'failed', error: exitText(code, stderr) });
    });
  });
}

/** A `spawn` launcher, which is the new window: it runs on after this process ends, in its own process group. */
function startDetached(request: ProgramRequest): Promise<StartOutcome> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(request.command, request.args, { cwd: request.cwd, detached: true, stdio: 'ignore' });
    } catch (error) {
      resolve(outcomeOfError(error));
      return;
    }
    child.once('error', (error) => resolve(outcomeOfError(error)));
    child.once('spawn', () => {
      child.unref();
      resolve({ kind: 'started', end: 'spawned' });
    });
  });
}

/** The exit code of HIDDEN_LAUNCHER when the program it was given is not installed. */
const LAUNCH_MISSING = 9;

/** The launcher's word for a program it starts through a keeper, in a console of its own. */
const VIA_KEEPER = 'keeper';

/** The variable that hands the keeper its program's command and arguments, as JSON. */
const KEEPER_PROGRAM_VAR = 'TEAMRIG_HIDDEN_PROGRAM';

/**
 * A node script, on one line with no `"`, `%` or `!` so cmd passes it unchanged, that starts the program in
 * KEEPER_PROGRAM_VAR as its own child, sharing its console and its stderr (the log) for both outputs, then says on
 * stdout, as one JSON line, whether it spawned, and exits with it. The program gets the stdout pipe's handle too, as a
 * child inherits every inheritable handle on Windows, so the line ends with a newline instead of the pipe closing.
 */
const KEEPER = [
  `const r = JSON.parse(process.env.${KEEPER_PROGRAM_VAR});`,
  `delete process.env.${KEEPER_PROGRAM_VAR};`,
  "const say = (word) => process.stdout.write(JSON.stringify(word) + String.fromCharCode(10));",
  "const failed = (e) => say({ spawned: false, code: e.code, message: e.message });",
  'try {',
  "const c = require('node:child_process').spawn(r.command, r.args, { stdio: ['ignore', 2, 2] });",
  "c.once('spawn', () => say({ spawned: true }));",
  "c.once('error', failed);",
  "c.once('exit', (code) => process.exit(code ?? 1));",
  '} catch (e) { failed(e); }',
].join(' ');

/**
 * A node script that starts the program after its `--`, log path and way, hidden, then exits: 0 once the program runs,
 * LAUNCH_MISSING when it is not installed, 1 with the reason on stderr when it cannot start for another reason, its log
 * unopenable among them. The log is opened here, not by the caller, so the program holds its own handle to it once this
 * launcher is gone; an empty path drops the program's output.
 *
 * A program is started detached, outside the job node puts its other children in, which ends them with this launcher.
 * Detached means no console, so a program that needs one (`VIA_KEEPER`) starts another way: cmd, this launcher's child,
 * gets a hidden console, and its `start /b` starts KEEPER in that console and outside the job, since the job lets a
 * child's own children break away. The keeper holds the console and the program as its child until it exits. The
 * program's words go by variable, not through cmd's command line, which holds 8191 characters and changes some.
 */
const HIDDEN_LAUNCHER = `
const [log, way, command, ...args] = process.argv.slice(1);
const fs = require('node:fs');
const path = require('node:path');
const fail = (error) => {
  process.stderr.write(String(error instanceof Error ? error.message : error));
  process.exit(error instanceof Error && 'code' in error && error.code === 'ENOENT' ? ${LAUNCH_MISSING} : 1);
};
const viaKeeper = (output) => {
  const line = 'start "" /b "' + process.execPath + '" -e "' + ${JSON.stringify(KEEPER)} + '"';
  const cmd = require('node:child_process').spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/v:off', '/c', line], {
    env: { ...process.env, ${KEEPER_PROGRAM_VAR}: JSON.stringify({ command, args }) },
    stdio: ['ignore', 'pipe', output],
    windowsHide: true,
    windowsVerbatimArguments: true,
  });
  let said = '';
  cmd.stdout.setEncoding('utf8');
  cmd.stdout.on('data', (chunk) => {
    said += chunk;
    if (said.includes('\\n')) {
      const word = JSON.parse(said);
      word.spawned ? process.exit(0) : fail(Object.assign(new Error(word.message), { code: word.code }));
    }
  });
  cmd.stdout.once('end', () => fail(new Error("cmd's start started no keeper")));
  cmd.once('error', fail);
};
try {
  if (log !== '') {
    fs.mkdirSync(path.dirname(log), { recursive: true });
  }
  const output = log === '' ? 'ignore' : fs.openSync(log, 'a');
  if (way === '${VIA_KEEPER}') {
    viaKeeper(output);
  } else {
    const child = require('node:child_process').spawn(command, args, { detached: true, stdio: ['ignore', output, output], windowsHide: true });
    child.once('error', fail);
    child.once('spawn', () => {
      child.unref();
      process.exit(0);
    });
  }
} catch (error) {
  fail(error);
}`;

/**
 * A hidden background program, with no console window, started through HIDDEN_LAUNCHER: the launcher has exited
 * when this resolves, so the program is no longer a descendant of this process and outlives a kill of it with every
 * process it started. That is how Claude Code ends a hook past its timeout (taskkill /T on Windows), which took the
 * automatic restart a Stop hook had just started with it.
 */
function startHiddenProgram(request: HiddenRequest): Promise<StartOutcome> {
  const way = request.needsConsole === true && process.platform === 'win32' ? VIA_KEEPER : 'detached';
  return new Promise((resolve) => {
    let launcher;
    try {
      launcher = spawn(process.execPath, ['-e', HIDDEN_LAUNCHER, '--', request.log ?? '', way, request.command, ...request.args], {
        cwd: request.cwd,
        env: { ...request.env },
        detached: true,
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      resolve(outcomeOfError(error));
      return;
    }
    let stderr = '';
    launcher.stderr.setEncoding('utf8');
    launcher.stderr.on('data', (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(0, ERROR_TEXT_MAX * 2);
    });
    launcher.once('error', (error) => resolve(outcomeOfError(error)));
    launcher.once('close', (code) => {
      switch (code) {
        case 0:
          resolve({ kind: 'started', end: 'spawned' });
          break;
        case LAUNCH_MISSING:
          resolve({ kind: 'missing' });
          break;
        default:
          resolve({ kind: 'failed', error: exitText(code, stderr) });
      }
    });
  });
}

/**
 * Ctrl+C reaches every process in the terminal. Claude Code handles it itself, and this parent must
 * outlive it: the tab ends when its first process does.
 */
function runAttached(request: RunRequest, interrupts: Interrupts): Promise<RunOutcome> {
  return new Promise((resolve) => {
    const ignore = (): void => undefined;
    interrupts.on('SIGINT', ignore);
    const settle = (outcome: RunOutcome): void => {
      interrupts.off('SIGINT', ignore);
      resolve(outcome);
    };
    let child;
    try {
      child = spawn(request.command, request.args, { cwd: request.cwd, env: { ...request.env }, stdio: 'inherit' });
    } catch (error) {
      settle(outcomeOfError(error));
      return;
    }
    child.once('error', (error) => settle(outcomeOfError(error)));
    child.once('exit', (code) => settle({ kind: 'exited', code: code ?? 1 }));
  });
}

/** Real child processes, each started with no shell. */
export function nodeProcesses(options: NodeProcessesOptions = {}): Processes {
  const waitMs = options.exitWaitMs ?? EXIT_WAIT_MS;
  const interrupts = options.interrupts ?? process;
  return {
    start: (request) => (request.mode === 'exit' ? startUntilExit(request, waitMs) : startDetached(request)),
    run: (request) => runAttached(request, interrupts),
    startHidden: startHiddenProgram,
  };
}
