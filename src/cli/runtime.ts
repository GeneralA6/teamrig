import type { TranscriptSource } from '../budget/discover.ts';
import type { ConfigFormat } from '../config/migrate.ts';
import type { Files } from '../core/files.ts';
import type { Env } from '../core/home.ts';
import type { Clock, Sleep } from '../core/lock.ts';
import type { PathProbe } from '../core/path-probe.ts';
import type { CredentialStore } from '../github/credentials.ts';
import type { GhRunner } from '../github/gh.ts';
import type { RequirementsCheck } from '../requirements/requirements.ts';
import type { WorktreePorts } from '../worktree/remove.ts';
import type { Processes } from '../open/processes.ts';
import type { SessionProcesses } from '../open/session-processes.ts';
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
  /** The running session's Claude Code process and its tab, which the automatic context refresh ends. */
  readonly sessionProcesses: SessionProcesses;
  /** The shell `teamrig test` runs its command line in. */
  readonly shell: ShellRunner;
  /** The GitHub CLI, for `teamrig gh sync`; it runs reads only (github/gh.ts). */
  readonly gh: GhRunner;
  /** The system's saved secrets, where `teamrig gh sync` finds each owner's read-only GitHub token; only ever read. */
  readonly credentials: CredentialStore;
  /** Whether a folder or a program is there. */
  readonly probe: PathProbe;
  readonly self: SelfLocation;
  /** The Claude Code transcripts `teamrig budget` measures: their folders and bytes. */
  readonly transcripts: TranscriptSource;
  /** What teamrig needs beside itself (git, Claude Code, Node.js) and lacks: told at session start, by `team create` and by `doctor`. */
  readonly requirements: RequirementsCheck;
  /** The git and file steps `teamrig worktree remove` takes. */
  readonly worktrees: WorktreePorts;
  /** The config format the run reads and migrates to; default the shipped one (tests give a newer release's). */
  readonly configFormat?: ConfigFormat;
  /** All of stdin, for hooks, which Claude Code feeds one JSON object. */
  readStdin(): Promise<string>;
}

/**
 * Exit codes: 0 done, 1 failed, 2 refused by a team rule, 3 `teamrig open` found no terminal to open and
 * printed the command to run instead, 4 `/teamrig` printed the line the person must agree to before it runs
 * (`hook slash-command`, src/mod/slash-hand.ts asks), 64 a command line it cannot read.
 */
/** `wake` is a background hook's exit 2: with `asyncRewake`, Claude Code gives the model what it printed to stderr as a new turn. */
export const EXIT = { ok: 0, failed: 1, refused: 2, wake: 2, printed: 3, ask: 4, usage: 64 } as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/** A request the team's rules or state refuse: printed as `REFUSED <reason>`, exit 2. */
export class RefusedError extends Error {
  override readonly name = 'RefusedError';
}
