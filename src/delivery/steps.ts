import { spawn } from 'node:child_process';
import type { Env } from '../core/home.ts';
import { endOf, type ShellEnd } from '../test-run/shell.ts';
import { lowerStep, NODE_PRIORITIES, type Priorities } from './priority.ts';
import { nodeTreeKill, type RunKill, type TreeKill } from './tree-kill.ts';

export interface StepRequest {
  /** One command line, read by the platform's shell: `sh` on POSIX, `cmd.exe` on Windows. */
  readonly command: string;
  readonly cwd: string;
  readonly env: Env;
  /** Past this, the step is killed with every process it started. */
  readonly timeoutMs: number;
  /** Once this aborts, the step is killed with every process it started, as at its time limit. */
  readonly stop?: AbortSignal;
}

/** How a program run with a time limit ended: as a shell command does, or killed at that limit. */
export type LimitedEnd = ShellEnd | { readonly kind: 'timedOut' };

/** How a step ended: as a limited program does, or killed when its `stop` aborted. */
export type StepEnd = LimitedEnd | { readonly kind: 'stopped' };

/** Runs a queued step with this process's stdin, stdout and stderr, so its output streams as it comes. */
export interface StepRunner {
  run(request: StepRequest): Promise<StepEnd>;
}

/** The exit code recorded for a step killed at its time limit, as `timeout(1)` reports one. */
export const TIMED_OUT_EXIT = 124;

/** The exit code recorded for a step killed by its `stop`, as a shell reports a command a closed terminal hung up (128 + SIGHUP). */
export const STOPPED_EXIT = 129;

/** The exit code a step's ledger record carries: its own, 124 when killed at its limit, 129 when killed by its `stop`, 1 when a signal stopped it. */
export function exitCodeOf(end: StepEnd): number {
  switch (end.kind) {
    case 'exited':
      return end.code;
    case 'timedOut':
      return TIMED_OUT_EXIT;
    case 'stopped':
      return STOPPED_EXIT;
    case 'signal':
      return 1;
  }
}

/**
 * The real runner: Node's `spawn` in the platform's shell, with inherited stdio, lowered to below-normal priority as
 * it starts, before its shell starts anything; its time limit or its `stop` kills the tree. A killed step is reported
 * once the kill is done, so the next holder never shares the host with it.
 */
export function nodeStepRunner(platform: NodeJS.Platform, kill: TreeKill = nodeTreeKill(platform), priorities: Priorities = NODE_PRIORITIES): StepRunner {
  return {
    run: (request) =>
      new Promise((resolve, reject) => {
        const child = spawn(request.command, {
          shell: true,
          cwd: request.cwd,
          env: { ...request.env },
          stdio: 'inherit',
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
        const settled = (): void => {
          clearTimeout(timer);
          request.stop?.removeEventListener('abort', onStop);
        };
        if (request.stop?.aborted === true) {
          onStop();
        } else {
          request.stop?.addEventListener('abort', onStop, { once: true });
        }
        child.once('error', (error) => {
          settled();
          reject(error);
        });
        child.once('close', (code, signal) => {
          settled();
          if (killed === undefined) {
            resolve(endOf(code, signal));
          } else {
            const { why, done } = killed;
            void done.then(() => resolve({ kind: why }));
          }
        });
      }),
  };
}
