import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { NOT_STARTED_EXIT } from '../coordinator/recorded-step.ts';
import { exitCodeOf, nodeTreeKill, type LimitedEnd, type TreeKill } from '../coordinator/steps.ts';
import type { Env } from '../core/home.ts';
import { endOf } from '../test-run/shell.ts';

/** One hook a roll runs: a gate, an afterPull command or the roll command. */
export interface HookRequest {
  /**
   * A program and its arguments, run without a shell, so no word is read twice: the program is an executable on the
   * PATH or a path to one, never a shell built-in or, on Windows, a `.cmd` script.
   */
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Env;
  /** Past this, the hook is killed with every process it started. */
  readonly timeoutMs: number;
  /** Hears each line the hook prints on stdout, as it comes; its stdin is closed and its stderr is this process's. */
  readonly onLine: (line: string) => void;
}

/** How a hook ended: as a step does, or not started at all (no such program, or a missing folder). */
export type HookEnd = LimitedEnd | { readonly kind: 'notStarted'; readonly error: string };

export interface HookRunner {
  run(request: HookRequest): Promise<HookEnd>;
}

/** True when the hook exited 0. */
export function succeeded(end: HookEnd): boolean {
  return end.kind === 'exited' && end.code === 0;
}

/** The exit code a hook's end is recorded as: its own, 124 at its time limit, 1 when a signal stopped it or it did not start. */
export function hookExitCode(end: HookEnd): number {
  return end.kind === 'notStarted' ? NOT_STARTED_EXIT : exitCodeOf(end);
}

/** How the hook ended, as a refusal or a ledger note says it: `exited 3`, `could not start (ENOENT)`. */
export function hookEndText(end: HookEnd): string {
  switch (end.kind) {
    case 'exited':
      return `exited ${end.code}`;
    case 'signal':
      return `was stopped by ${end.signal}`;
    case 'timedOut':
      return 'was killed at its time limit';
    case 'notStarted':
      return `could not start (${end.error})`;
  }
}

/** The real runner: Node's `spawn` with no shell, stdout read line by line, and a timer that kills the tree. */
export function nodeHookRunner(platform: NodeJS.Platform, kill: TreeKill = nodeTreeKill(platform)): HookRunner {
  return {
    run: (request) =>
      new Promise((resolve) => {
        const [program, ...args] = request.argv;
        if (program === undefined) {
          resolve({ kind: 'notStarted', error: 'no program to run' });
          return;
        }
        let settled = false;
        const settle = (end: HookEnd): void => {
          if (!settled) {
            settled = true;
            resolve(end);
          }
        };
        const child = spawn(program, args, {
          shell: false,
          cwd: request.cwd,
          env: { ...request.env },
          stdio: ['ignore', 'pipe', 'inherit'],
          windowsHide: true,
          detached: platform !== 'win32',
        });
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          if (child.pid !== undefined) {
            kill(child.pid);
          }
        }, request.timeoutMs);
        const lines = createInterface({ input: child.stdout, crlfDelay: Number.POSITIVE_INFINITY });
        lines.on('line', request.onLine);
        const read = new Promise<void>((done) => lines.once('close', done));
        child.once('error', (error) => {
          clearTimeout(timer);
          settle({ kind: 'notStarted', error: error.message });
        });
        child.once('close', (code, signal) => {
          clearTimeout(timer);
          void read.then(() => settle(timedOut ? { kind: 'timedOut' } : endOf(code, signal)));
        });
      }),
  };
}
