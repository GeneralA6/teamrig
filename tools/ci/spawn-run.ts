import { spawnSync } from 'node:child_process';
import type { RunRequest, RunResult } from './dist-smoke.ts';

export interface SpawnOptions {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd: string;
  /** Milliseconds before the program is killed. */
  readonly timeout: number;
}

/** Starts `request` with no shell in between, as Claude Code starts an exec-form hook, and waits for its end. */
export function spawnRun(request: RunRequest, options: SpawnOptions): RunResult {
  const result = spawnSync(request.file, request.args, {
    input: request.input,
    encoding: 'utf8',
    env: options.env,
    cwd: options.cwd,
    timeout: options.timeout,
    windowsVerbatimArguments: request.verbatim ?? false,
  });
  // A file that cannot start (missing, or not executable) has no output, only an error.
  return { status: result.status, stdout: result.stdout, stderr: result.error === undefined ? result.stderr : result.error.message };
}
