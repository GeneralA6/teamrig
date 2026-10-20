import type { TranscriptSource } from '../budget/discover.ts';
import type { ConfigFormat } from '../config/migrate.ts';
import type { HostMemory } from '../coordinator/memory.ts';
import type { TreeState } from '../coordinator/push-pass.ts';
import type { StarterWatch } from '../coordinator/starter-watch.ts';
import type { StepRunner } from '../coordinator/steps.ts';
import type { Files } from '../core/files.ts';
import type { Env } from '../core/home.ts';
import type { ExecPorts } from '../exec/ports.ts';
import type { Clock, Sleep } from '../core/lock.ts';
import type { PathProbe } from '../core/path-probe.ts';
import type { CredentialStore } from '../github/credentials.ts';
import type { GhRunner } from '../github/gh.ts';
import type { IntegrateGit } from '../integrate/git.ts';
import type { RequirementsCheck } from '../requirements/requirements.ts';
import type { HookRunner } from '../roll/hooks.ts';
import type { PackageRegistry } from '../package-guard/registry.ts';
import type { WorktreePorts } from '../worktree/remove.ts';
import type { RestorePorts } from '../restore/ports.ts';
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
  /** The machine's IANA time zone, which the team config's `timeZone` overrides. */
  readonly timeZone: string;
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
  /** The shell `teamrig heavy` runs its step in, with this process's stdio and a time limit. */
  readonly steps: StepRunner;
  /** The host's free memory, processes and commit charge, and a watch of a heavy step's process tree (its ledger record). */
  readonly memory: HostMemory;
  /** The processes that started this one, so a heavy step whose launching shell was ended stops too. */
  readonly starters: StarterWatch;
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
  /** The shutdown log and the countdown of the restore after a reboot. */
  readonly restore: RestorePorts;
  /** The working tree `teamrig heavy --pre-push` checks: clean or changed, and HEAD's tree. */
  readonly trees: TreeState;
  /** The git steps `teamrig integrate` takes. */
  readonly integrateGit: IntegrateGit;
  /** The programs `teamrig roll` runs, its gates, afterPull hooks and roll command: no shell, each with a time limit. */
  readonly hooks: HookRunner;
  /** The registry the package guard asks about the versions an install names: their publish times and advisories. */
  readonly packageRegistry: PackageRegistry;
  /** The process `teamrig exec` runs a reviewed command in, and the git checkout its binding check reads. */
  readonly exec: ExecPorts;
  /** The config format the run reads and migrates to; default the shipped one (tests give a newer release's). */
  readonly configFormat?: ConfigFormat;
  /** All of stdin, for hooks, which Claude Code feeds one JSON object. */
  readStdin(): Promise<string>;
  /** A new unique id, such as a host lock's token. */
  newId(): string;
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
