import type { ConfigFormat } from '../config/migrate.ts';
import type { Files } from '../core/files.ts';
import type { Env } from '../core/home.ts';
import type { Clock, Sleep } from '../core/lock.ts';
import type { RepoState } from '../push-guard/push.ts';

export interface Output {
  stdout(line: string): void;
  stderr(line: string): void;
}

/** Everything the CLI takes from the process, as one port so every command runs in tests. */
export interface CliRuntime {
  readonly env: Env;
  readonly userHome: string;
  readonly cwd: string;
  readonly pid: number;
  readonly files: Files;
  readonly clock: Clock;
  readonly sleep: Sleep;
  readonly git: RepoState;
  readonly out: Output;
  /** The config format the run reads and migrates to; default the shipped one (tests give a newer release's). */
  readonly configFormat?: ConfigFormat;
  /** All of stdin, for hooks, which Claude Code feeds one JSON object. */
  readStdin(): Promise<string>;
}

/** Exit codes: 0 done, 1 failed, 2 refused by a team rule, 64 a command line it cannot read. */
export const EXIT = { ok: 0, failed: 1, refused: 2, usage: 64 } as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/** A request the team's rules or state refuse: printed as `REFUSED <reason>`, exit 2. */
export class RefusedError extends Error {
  override readonly name = 'RefusedError';
}
