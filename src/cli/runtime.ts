import type { TranscriptSource } from '../budget/discover.ts';
import type { ConfigFormat } from '../config/migrate.ts';
import type { Files } from '../core/files.ts';
import type { Env } from '../core/home.ts';
import type { Clock, Sleep } from '../core/lock.ts';
import type { PathProbe } from '../core/path-probe.ts';
import type { GhRunner } from '../github/gh.ts';
import type { RequirementsCheck } from '../requirements/requirements.ts';
import type { Processes } from '../open/processes.ts';
import type { CommitLog } from '../push-guard/commit-size.ts';
import type { RepoState } from '../push-guard/push.ts';
import type { ShellRunner } from '../test-run/shell.ts';

export interface Output {
  stdout(line: string): void;
  stderr(line: string): void;
}

/** Where this CLI runs from, so `teamrig open` can start it again in a new tab, where the plugin's bin folder is not on PATH. */
export interface SelfLocation {
  /** The Node.js program running this CLI. */
  readonly node: string;
  /** This CLI's entry script. */
  readonly script: string;
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
  /** The commits of a range, for the small-commits rule. */
  readonly commitLog: CommitLog;
  readonly out: Output;
  readonly platform: NodeJS.Platform;
  /** Terminal launchers and Claude Code, for `teamrig open` and `teamrig launch`. */
  readonly processes: Processes;
  /** The shell `teamrig test` runs its command line in. */
  readonly shell: ShellRunner;
  /** The GitHub CLI, for `teamrig gh sync`; it runs reads only (github/gh.ts). */
  readonly gh: GhRunner;
  /** Whether a folder or a program is there. */
  readonly probe: PathProbe;
  readonly self: SelfLocation;
  /** The Claude Code transcripts `teamrig budget` measures: their folders and bytes. */
  readonly transcripts: TranscriptSource;
  /** What teamrig needs beside itself (git, Claude Code, Node.js) and lacks: told at session start, by `team create` and by `doctor`. */
  readonly requirements: RequirementsCheck;
  /** The config format the run reads and migrates to; default the shipped one (tests give a newer release's). */
  readonly configFormat?: ConfigFormat;
  /** All of stdin, for hooks, which Claude Code feeds one JSON object. */
  readStdin(): Promise<string>;
}

/**
 * Exit codes: 0 done, 1 failed, 2 refused by a team rule, 3 `teamrig open` found no terminal to open and
 * printed the command to run instead, 64 a command line it cannot read.
 */
export const EXIT = { ok: 0, failed: 1, refused: 2, printed: 3, usage: 64 } as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/** A request the team's rules or state refuse: printed as `REFUSED <reason>`, exit 2. */
export class RefusedError extends Error {
  override readonly name = 'RefusedError';
}
