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

/** The real runner: `spawn` with no shell, stdin closed, and the caller's time limit. */
export function nodeProgramRunner(timeoutMs: number): ProgramRunner {
  return (request) =>
    new Promise((resolve, reject) => {
      const env = request.env === undefined ? {} : { env: request.env };
      const child = spawn(request.program, [...request.args], { ...env, stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs, windowsHide: true });
      const stdout: string[] = [];
      const stderr: string[] = [];
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => stdout.push(chunk));
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => stderr.push(chunk));
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ end: endOf(code, signal), stdout: stdout.join(''), stderr: stderr.join('') }));
    });
}
