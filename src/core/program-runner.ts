import { spawn } from 'node:child_process';
import type { Env } from './home.ts';
import { endOf, type ShellEnd } from './shell-end.ts';

/**
 * One run of a command-line tool: the program and its arguments, passed as a list and never read by a shell, and the
 * environment it runs in when the caller sets one (a connector hands its tool a key there); else this process's own.
 */
export interface ProgramRequest {
  readonly program: string;
  readonly args: readonly string[];
  readonly env?: Env;
}

export interface ProgramResult {
  readonly end: ShellEnd;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs a program to its end with no stdin. It rejects when the program cannot start, such as when it is not installed. */
export type ProgramRunner = (request: ProgramRequest) => Promise<ProgramResult>;

/** A run stopped for printing more than its cap; nothing it printed is used. */
export class ProgramOutputCapError extends Error {
  override readonly name = 'ProgramOutputCapError';

  constructor(program: string, maxBytes: number) {
    super(`${program} printed more than ${maxBytes} bytes, so teamrig stopped it and used none of it`);
  }
}

/**
 * The real runner: `spawn` with no shell, stdin closed, and the caller's time limit. With `maxBytes`, a run that
 * prints more than that, stdout and stderr together, is stopped and rejects with ProgramOutputCapError: the cap of a
 * tool whose output holds text people post, so no run's memory grows without bound. Without it nothing is capped.
 */
export function nodeProgramRunner(timeoutMs: number, maxBytes: number = Number.POSITIVE_INFINITY): ProgramRunner {
  return (request) =>
    new Promise((resolve, reject) => {
      const env = request.env === undefined ? {} : { env: request.env };
      const child = spawn(request.program, [...request.args], { ...env, stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs, windowsHide: true });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let printed = 0;
      let over = false;
      const keep =
        (into: Buffer[]) =>
        (chunk: Buffer): void => {
          if (over) {
            return;
          }
          printed += chunk.length;
          if (printed > maxBytes) {
            over = true;
            stdout.length = 0;
            stderr.length = 0;
            child.kill();
            return;
          }
          into.push(chunk);
        };
      child.stdout.on('data', keep(stdout));
      child.stderr.on('data', keep(stderr));
      child.once('error', reject);
      child.once('close', (code, signal) => {
        if (over) {
          reject(new ProgramOutputCapError(request.program, maxBytes));
          return;
        }
        // Joined before decoding, so a character split across two chunks reads whole.
        resolve({ end: endOf(code, signal), stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') });
      });
    });
}
