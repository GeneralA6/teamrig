import { spawn } from 'node:child_process';
import type { Env } from '../core/home.ts';
import { endOf, type ShellEnd } from '../test-run/shell.ts';

/**
 * The `gh` commands teamrig may run: reads only. The import never writes to GitHub (no issue, label,
 * comment or assignee change), so the runner refuses any other command line before it starts.
 */
export const READ_COMMANDS: readonly (readonly [string, string])[] = [['issue', 'list']];

/** True when the arguments start with one of READ_COMMANDS. */
export function isReadCommand(args: readonly string[]): boolean {
  return READ_COMMANDS.some(([group, verb]) => args[0] === group && args[1] === verb);
}

/** One `gh` run: its arguments, passed as a list and never read by a shell, and the environment. */
export interface GhRequest {
  readonly args: readonly string[];
  readonly env: Env;
}

export interface GhResult {
  readonly end: ShellEnd;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs the GitHub CLI to its end with no stdin. It rejects when `gh` cannot start, such as when it is not installed. */
export interface GhRunner {
  run(request: GhRequest): Promise<GhResult>;
}

/** How long one `gh` run may take before it is stopped: a list of a few hundred issues takes seconds. */
export const GH_TIMEOUT_MS = 60_000;

/** A command line the runner will not start, because it is not a read. */
export class GhNotReadError extends Error {
  override readonly name = 'GhNotReadError';

  constructor(args: readonly string[]) {
    super(`teamrig only reads GitHub: it does not run gh ${args.slice(0, 2).join(' ')}`);
  }
}

/**
 * The real runner: `spawn` with no shell, so an issue title or a repository name can never become a
 * command. gh is told never to prompt, as nobody is there to answer. `program` and `leading` let a test
 * stand a Node script in for gh.
 */
export function nodeGhRunner(program = 'gh', leading: readonly string[] = [], timeoutMs = GH_TIMEOUT_MS): GhRunner {
  return {
    run: (request) => {
      if (!isReadCommand(request.args)) {
        return Promise.reject(new GhNotReadError(request.args));
      }
      return new Promise((resolve, reject) => {
        const child = spawn(program, [...leading, ...request.args], {
          env: { ...request.env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' },
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: timeoutMs,
          windowsHide: true,
        });
        const stdout: string[] = [];
        const stderr: string[] = [];
        child.stdout.setEncoding('utf8').on('data', (chunk: string) => stdout.push(chunk));
        child.stderr.setEncoding('utf8').on('data', (chunk: string) => stderr.push(chunk));
        child.once('error', reject);
        child.once('close', (code, signal) => resolve({ end: endOf(code, signal), stdout: stdout.join(''), stderr: stderr.join('') }));
      });
    },
  };
}
