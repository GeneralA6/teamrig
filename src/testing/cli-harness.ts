import assert from 'node:assert/strict';
import type { Sleep } from '../core/lock.ts';
import { join, resolve } from 'node:path';
import { runCli } from '../cli/run.ts';
import type { ExitCode } from '../cli/runtime.ts';
import { formatConfig } from '../config/load.ts';
import type { ConfigFormat } from '../config/migrate.ts';
import type { Files } from '../core/files.ts';
import { isRecord, stringField, type JsonRecord } from '../core/guards.ts';
import type { Env } from '../core/home.ts';
import type { PathProbe } from '../core/path-probe.ts';
import type { TranscriptSource } from '../budget/discover.ts';
import type { RequirementsCheck } from '../requirements/requirements.ts';
import type { WorktreePorts } from '../worktree/remove.ts';
import type { RestorePorts } from '../restore/ports.ts';
import type { Processes } from '../open/processes.ts';
import type { SessionProcesses } from '../open/session-processes.ts';
import type { CommitLog } from '../push-guard/commit-size.ts';
import type { RepoState } from '../push-guard/push.ts';
import type { CredentialStore } from '../github/credentials.ts';
import type { GhRunner } from '../github/gh.ts';
import type { ShellRunner } from '../test-run/shell.ts';
import type { HostMemory } from '../coordinator/memory.ts';
import type { StarterWatch } from '../coordinator/starter-watch.ts';
import type { StepRunner } from '../coordinator/steps.ts';
import type { HookRunner } from '../roll/hooks.ts';
import type { IntegrateGit } from '../integrate/git.ts';
import { FakeClock } from './fake-clock.ts';
import { MemoryFiles } from './memory-files.ts';
import { quietWorld } from './quiet-world.ts';

/** The user's home folder the CLI sees; the default skills folder lives under it. */
export const USER_HOME = join('/', 'u');
/** The kit home, set through `$TEAMRIG_HOME`. */
export const KIT = join('/', 'kit');
export const TEAM_HOME = join(KIT, 'teams', 'app');
export const CONFIG_PATH = join(TEAM_HOME, 'config.json');
export const EVENTS_PATH = join(TEAM_HOME, 'state', 'events.jsonl');
export const EVENTS_LOCK_PATH = join(TEAM_HOME, 'state', 'events.lock');
export const RENAMES_PATH = join(TEAM_HOME, 'state', 'renames.jsonl');
export const SKILLS_DIR = join(USER_HOME, '.claude', 'skills');
/** The project folder the CLI runs in, tied to team `app` by its pointer. */
export const APP = resolve('/', 'work', 'app');
export const POINTER = join(APP, '.teamrig.json');
export const CLAUDE_SESSION = '0123abcd-0000-4000-8000-00000000000a';
export const TEAM: JsonRecord = { sessions: ['lead', 'alpha', 'bravo'], roles: { lead: 'lead' } };
/** {@link TEAM} with the context refresh's automatic restart on (`refresh.autoRestart`, off by default). */
export const AUTO_RESTART_TEAM: JsonRecord = { ...TEAM, refresh: { autoRestart: true } };

export interface CliResult {
  readonly code: ExitCode;
  readonly stdout: readonly string[];
  readonly stderr: readonly string[];
}

export interface RunOptions {
  readonly env?: Env;
  readonly stdin?: string;
  readonly branch?: string;
  /** The repository git reads, such as one on a detached HEAD; default one on `branch` with no push target or config. */
  readonly git?: RepoState;
  readonly cwd?: string;
  /** The files the CLI sees for this run, such as a `FaultyFiles` over `files`; default `files`. */
  readonly files?: Files;
  /** The config format the CLI reads, such as a newer release's; default the shipped one. */
  readonly configFormat?: ConfigFormat;
  /** The commits git lists for any range; default none. */
  readonly commitLog?: CommitLog;
  /** The operating system the CLI sees; default Linux. */
  readonly platform?: NodeJS.Platform;
  /** The machine's time zone; default UTC. */
  readonly timeZone?: string;
  /** The programs the CLI starts; default none is installed. */
  readonly processes?: Processes;
  /** The running session's processes; default none runs. */
  readonly sessionProcesses?: SessionProcesses;
  /** How the CLI waits, such as one that changes the world mid-wait; default the clock's, which only moves time. */
  readonly sleep?: Sleep;
  /** The shell `teamrig test` runs in; default one that prints nothing and exits 0. */
  readonly shell?: ShellRunner;
  /** The GitHub CLI `gh sync` reads through; default one that sees no repository. */
  readonly gh?: GhRunner;
  /** The saved secrets `gh sync` reads tokens from; default a store with none. */
  readonly credentials?: CredentialStore;
  /** The folders and programs the CLI sees; default none. */
  readonly probe?: PathProbe;
  /** What the requirements check finds; default nothing is missing. */
  readonly requirements?: RequirementsCheck;
  /** The Claude Code transcripts `budget` measures; default none. */
  readonly transcripts?: TranscriptSource;
  /** The worktrees `worktree remove` sees; default none. */
  readonly worktrees?: WorktreePorts;
  /** The shutdown log and countdown `restore` sees; default no shutdown on record and a countdown that goes at once. */
  readonly restore?: RestorePorts;
  /** The runner `teamrig heavy` runs its step in; default one whose steps exit 0 at once. */
  readonly steps?: StepRunner;
  /** The host memory `teamrig heavy` watches its step with; default one that measures nothing. */
  readonly memory?: HostMemory;
  /** The processes that started a `teamrig heavy` run; default a shell and its Claude Code, which never end. */
  readonly starters?: StarterWatch;
  /** The git `teamrig integrate` drives; default the fake repository at /w/feat (testing/fake-integrate-git.ts). */
  readonly integrateGit?: IntegrateGit;
  /** The runner `teamrig roll` runs its gates, afterPull hooks and roll command in; default one whose programs print nothing and exit 0. */
  readonly hooks?: HookRunner;
}

/**
 * The CLI over in-memory files, a fixed clock and a fake git, with the kit home at /kit and the
 * working folder in project /work/app, which a pointer ties to team `app`.
 */
export class CliHarness {
  readonly files: MemoryFiles;
  readonly clock = new FakeClock('2030-01-08T10:00:00Z');

  /** `null` leaves out the team config or the project's team pointer; `undefined` takes the default. */
  constructor(config: JsonRecord | string | null = TEAM, pointer: string | null = '{"team": "app"}') {
    const text = config === null || typeof config === 'string' ? config : formatConfig(config);
    this.files = new MemoryFiles(
      {
        ...(text === null ? {} : { [CONFIG_PATH]: text }),
        ...(pointer === null ? {} : { [POINTER]: pointer }),
      },
      this.clock,
    );
  }

  async run(argv: readonly string[], options: RunOptions = {}): Promise<CliResult> {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await runCli(argv, {
      env: { TEAMRIG_HOME: KIT, ...options.env },
      userHome: USER_HOME,
      cwd: options.cwd ?? APP,
      pid: 4242,
      files: options.files ?? this.files,
      clock: this.clock,
      timeZone: options.timeZone ?? 'UTC',
      sleep: options.sleep ?? this.clock.sleep,
      ...quietWorld(options.branch, options.stdin),
      ...(options.git === undefined ? {} : { git: options.git }),
      ...(options.commitLog === undefined ? {} : { commitLog: options.commitLog }),
      ...(options.platform === undefined ? {} : { platform: options.platform }),
      ...(options.processes === undefined ? {} : { processes: options.processes }),
      ...(options.sessionProcesses === undefined ? {} : { sessionProcesses: options.sessionProcesses }),
      ...(options.shell === undefined ? {} : { shell: options.shell }),
      ...(options.gh === undefined ? {} : { gh: options.gh }),
      ...(options.credentials === undefined ? {} : { credentials: options.credentials }),
      ...(options.probe === undefined ? {} : { probe: options.probe }),
      ...(options.requirements === undefined ? {} : { requirements: options.requirements }),
      ...(options.transcripts === undefined ? {} : { transcripts: options.transcripts }),
      ...(options.worktrees === undefined ? {} : { worktrees: options.worktrees }),
      ...(options.restore === undefined ? {} : { restore: options.restore }),
      ...(options.steps === undefined ? {} : { steps: options.steps }),
      ...(options.memory === undefined ? {} : { memory: options.memory }),
      ...(options.starters === undefined ? {} : { starters: options.starters }),
      ...(options.integrateGit === undefined ? {} : { integrateGit: options.integrateGit }),
      ...(options.hooks === undefined ? {} : { hooks: options.hooks }),
      out: { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) },
      ...(options.configFormat === undefined ? {} : { configFormat: options.configFormat }),
    });
    return { code, stdout, stderr };
  }
}

/** A PreToolUse payload for a Bash call in the project folder. */
export function bash(command: string): string {
  return JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd: APP });
}

/** A PreToolUse hook's permission field `key`, or undefined when it printed nothing or only added context. */
function permissionField(result: CliResult, key: 'permissionDecision' | 'permissionDecisionReason'): string | undefined {
  const [line] = result.stdout;
  if (line === undefined) {
    return undefined;
  }
  const parsed: unknown = JSON.parse(line);
  const output = isRecord(parsed) ? parsed['hookSpecificOutput'] : undefined;
  assert.ok(isRecord(output));
  return stringField(output, key);
}

/** A PreToolUse hook's permission decision, or undefined when it printed nothing or only added context. */
export function decisionOf(result: CliResult): string | undefined {
  return permissionField(result, 'permissionDecision');
}

/** The reason a PreToolUse hook gave for its permission decision, or undefined when it gave none. */
export function reasonOf(result: CliResult): string | undefined {
  return permissionField(result, 'permissionDecisionReason');
}

/** The SessionStart hook's context, from its one output line. */
export function contextOf(result: CliResult): string {
  assert.equal(result.stdout.length, 1);
  const parsed: unknown = JSON.parse(result.stdout[0] ?? '');
  assert.ok(typeof parsed === 'object' && parsed !== null && 'hookSpecificOutput' in parsed);
  const output = parsed.hookSpecificOutput;
  assert.ok(typeof output === 'object' && output !== null && 'additionalContext' in output);
  return String(output.additionalContext);
}

/** The prompt hook's one JSON line, printed when it titles the tab: the title, and its context when it has one. */
export function titledPromptOf(result: CliResult): { readonly title: string | undefined; readonly context: string | undefined } {
  assert.equal(result.stdout.length, 1);
  const parsed: unknown = JSON.parse(result.stdout[0] ?? '');
  assert.ok(isRecord(parsed));
  const output = parsed['hookSpecificOutput'];
  assert.ok(isRecord(output) && output['hookEventName'] === 'UserPromptSubmit');
  return { title: stringField(output, 'sessionTitle'), context: stringField(output, 'additionalContext') };
}

/** The team's rename log as `[id, from, to, by]` per record; empty when it does not exist. */
export async function renameRecordsOf(kit: CliHarness): Promise<string[][]> {
  const text = (await kit.files.read(RENAMES_PATH)) ?? '';
  return text
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => {
      const record: unknown = JSON.parse(line);
      assert.ok(typeof record === 'object' && record !== null && 'id' in record && 'from' in record && 'to' in record && 'by' in record);
      return [String(record.id), String(record.from), String(record.to), String(record.by)];
    });
}
