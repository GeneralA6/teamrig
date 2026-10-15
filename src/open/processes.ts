import { spawn, type SpawnOptions } from 'node:child_process';
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

export type StartOutcome =
  | { readonly kind: 'started' }
  /** The program is not installed (or not on PATH). */
  | { readonly kind: 'missing' }
  | { readonly kind: 'failed'; readonly error: string };

export interface RunRequest extends ProgramRequest {
  readonly env: Env;
}

export type RunOutcome = { readonly kind: 'exited'; readonly code: number } | { readonly kind: 'missing' } | { readonly kind: 'failed'; readonly error: string };

/** The child processes `teamrig open`, `teamrig launch` and the hooks start, as one port so all run in tests. */
export interface Processes {
  /** Starts a terminal launcher in the background; its output is not shown. */
  start(request: StartRequest): Promise<StartOutcome>;
  /** Runs a program in this terminal, its input and output this process's own, until it exits. */
  run(request: RunRequest): Promise<RunOutcome>;
  /** Starts a program with no window that runs on after this process ends, with the given variables; its output is dropped. */
  startHidden(request: RunRequest): Promise<StartOutcome>;
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
      resolve({ kind: 'started' });
    }, waitMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      resolve(outcomeOfError(error));
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? { kind: 'started' } : { kind: 'failed', error: exitText(code, stderr) });
    });
  });
}

/**
 * A program that runs on after this process ends, in its own process group: a `spawn` launcher, which is the new
 * window, or a hidden background program (`extra` hides the console window Windows would open for it).
 */
function startDetached(request: ProgramRequest, extra: SpawnOptions = {}): Promise<StartOutcome> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(request.command, request.args, { cwd: request.cwd, detached: true, stdio: 'ignore', ...extra });
    } catch (error) {
      resolve(outcomeOfError(error));
      return;
    }
    child.once('error', (error) => resolve(outcomeOfError(error)));
    child.once('spawn', () => {
      child.unref();
      resolve({ kind: 'started' });
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
    startHidden: (request) => startDetached(request, { env: { ...request.env }, windowsHide: true }),
  };
}
