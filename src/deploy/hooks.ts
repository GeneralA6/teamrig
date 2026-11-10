import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { lowerStep, NODE_PRIORITIES, type Priorities } from '../delivery/priority.ts';
import { NOT_STARTED_EXIT } from '../delivery/recorded-step.ts';
import { exitCodeOf, type StepEnd } from '../delivery/steps.ts';
import { nodeTreeKill, type RunKill, type TreeKill } from '../delivery/tree-kill.ts';
import type { Env } from '../core/home.ts';
import { endOf } from '../test-run/shell.ts';

/**
 * Every hook's exit codes say the same: 0 done, this one (`EX_TEMPFAIL`) wait and come back later, anything else
 * failed; a deploy check also reads 2 as a refusal.
 */
export const HOOK_WAIT_EXIT = 75;

/** One hook a deploy or merge runs: a deploy check, a dependency check, an afterPull command or the deploy command. */
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
  /** Once this aborts, the hook is killed with every process it started, as at its time limit. */
  readonly stop?: AbortSignal;
  /** Hears each line the hook prints on stdout, as it comes; its stdin is closed and its stderr is this process's. */
  readonly onLine: (line: string) => void;
}

/** How a hook ended: as a step does, killed by its stop too, or not started at all (no such program, or a missing folder). */
export type HookEnd = StepEnd | { readonly kind: 'notStarted'; readonly error: string };

export interface HookRunner {
  run(request: HookRequest): Promise<HookEnd>;
}

/** True when the hook exited 0. */
export function succeeded(end: HookEnd): boolean {
  return end.kind === 'exited' && end.code === 0;
}

/** The exit code a hook's end is recorded as: its own, 124 at its time limit, 129 when its stop killed it, 1 when a signal stopped it or it did not start. */
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
    case 'stopped':
      return 'was killed when its launching shell ended';
    case 'notStarted':
      return `could not start (${end.error})`;
  }
}

/**
 * The real runner: Node's `spawn` with no shell, stdout read line by line, lowered to below-normal priority as it
 * starts, as a queued step is (a merge or deploy command is one); its time limit or its `stop` kills the tree. A killed
 * hook is reported once the kill is done.
 */
export function nodeHookRunner(platform: NodeJS.Platform, kill: TreeKill = nodeTreeKill(platform), priorities: Priorities = NODE_PRIORITIES): HookRunner {
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
        if (child.pid !== undefined) {
          lowerStep(priorities, child.pid);
        }
        let killed: RunKill | undefined;
        const killAs = (why: RunKill['why']): void => {
          if (killed !== undefined) {
            return;
          }
          killed = { why, done: kill(child) };
        };
        const timer = setTimeout(() => killAs('timedOut'), request.timeoutMs);
        const onStop = (): void => killAs('stopped');
        const ended = (): void => {
          clearTimeout(timer);
          request.stop?.removeEventListener('abort', onStop);
        };
        if (request.stop?.aborted === true) {
          onStop();
        } else {
          request.stop?.addEventListener('abort', onStop, { once: true });
        }
        const lines = createInterface({ input: child.stdout, crlfDelay: Number.POSITIVE_INFINITY });
        lines.on('line', request.onLine);
        const read = new Promise<void>((done) => lines.once('close', done));
        child.once('error', (error) => {
          ended();
          settle({ kind: 'notStarted', error: error.message });
        });
        child.once('close', (code, signal) => {
          ended();
          const stopping = killed;
          void Promise.all([read, stopping?.done]).then(() => settle(stopping === undefined ? endOf(code, signal) : { kind: stopping.why }));
        });
      }),
  };
}
