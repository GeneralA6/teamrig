import assert from 'node:assert/strict';
import type { Sleep } from '../core/lock.ts';
import { join, resolve } from 'node:path';
import { runCli } from '../cli/run.ts';
import type { ExitCode } from '../cli/runtime.ts';
import { CONFIG_LIMITS, RULE_CONFLICT_LIMITS } from '../config/limits.ts';
import { formatConfig } from '../config/load.ts';
import type { ConfigFormat } from '../config/migrate.ts';
import type { FileBytes } from '../core/file-bytes.ts';
import type { Files } from '../core/files.ts';
import { isRecord, stringField, type JsonRecord } from '../core/guards.ts';
import type { Env } from '../core/home.ts';
import { SECRET_DENY_LINES } from '../doctor/deny-lines.ts';
import type { PathProbe } from '../core/path-probe.ts';
import type { StoreFolders } from '../core/plugin-store.ts';
import type { TranscriptSource } from '../budget/discover.ts';
import type { RequirementsCheck } from '../requirements/requirements.ts';
import type { WorktreePorts } from '../worktree/remove.ts';
import type { RestorePorts } from '../restore/ports.ts';
import type { Processes } from '../open/processes.ts';
import type { SessionProcesses } from '../open/session-processes.ts';
import type { CommitLog } from '../push-guard/commit-size.ts';
import type { RepoState } from '../push-guard/push.ts';
import type { SecretsGit } from '../secret-guard/secrets-git.ts';
import type { CredentialStore } from '../github/credentials.ts';
import type { GhRunner } from '../github/gh.ts';
import type { ShellRunner } from '../test-run/shell.ts';
import type { HostMemory } from '../delivery/memory.ts';
import type { StarterWatch } from '../delivery/starter-watch.ts';
import type { StepRunner } from '../delivery/steps.ts';
import type { HookRunner } from '../deploy/hooks.ts';
import type { MergeGit } from '../merge/git.ts';
import type { TreeState } from '../delivery/push-pass.ts';
import type { PackageRegistry } from '../package-guard/registry.ts';
import { CONTEXT_MAX_CHARS, TEAM_RULES_MAX_CHARS } from '../rules/pack.ts';
import type { ExecPorts } from '../exec/ports.ts';
import type { ChatWebhook } from '../core/webhook.ts';
import type { PointerGit } from '../setup/pointer-ignore.ts';
import { FakeClock } from './fake-clock.ts';
import { FakeSessionProcesses } from './fake-session-processes.ts';
import { MemoryFiles } from './memory-files.ts';
import { quietWorld } from './quiet-world.ts';
import { textFileBytes } from './text-file-bytes.ts';

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
/** The user's Claude Code settings, where doctor tells the user to paste the secret deny lines no settings file holds. */
export const USER_SETTINGS = join(USER_HOME, '.claude', 'settings.json');
/** Claude Code settings that hold every secret deny line, for a spec that writes the user's settings itself. */
export const HELD_DENY: JsonRecord = { permissions: { deny: [...SECRET_DENY_LINES] } };
/** The project folder the CLI runs in, tied to team `app` by its pointer. */
export const APP = resolve('/', 'work', 'app');
export const POINTER = join(APP, '.teamrig.json');
export const CLAUDE_SESSION = '0123abcd-0000-4000-8000-00000000000a';
/** The pid of every run of the CLI. */
export const CLI_PID = 4242;
export const TEAM: JsonRecord = { sessions: ['lead', 'alpha', 'bravo'], roles: { lead: 'lead' } };
/** {@link TEAM} with the context refresh's automatic restart on (`refresh.autoRestart`, off by default). */
export const AUTO_RESTART_TEAM: JsonRecord = { ...TEAM, refresh: { autoRestart: true } };
const longestList = (limit: { readonly maxItems: number; readonly maxLength: number }, letter: string) =>
  Array.from({ length: limit.maxItems }, () => letter.repeat(limit.maxLength));
/**
 * {@link TEAM} with the owner gates, protected branches and kept local rules at their longest, all printed in the core
 * rules: the lead's start then nears the context cap, so a team rules file ({@link rulesToOverflow}) pushes its long
 * notes out.
 */
export const LONG_RULES_TEAM: JsonRecord = {
  ...TEAM,
  ownerGates: longestList(CONFIG_LIMITS.ownerGates, 'g'),
  pushGuard: { protectedBranches: longestList(CONFIG_LIMITS.protectedBranches, 'b') },
  ruleConflicts: Array.from({ length: CONFIG_LIMITS.ruleConflicts.maxItems }, (_, index) => ({
    file: 'f'.repeat(RULE_CONFLICT_LIMITS.fileMaxLength),
    text: String(index).padStart(RULE_CONFLICT_LIMITS.textMaxLength, 't'),
    rule: 'worktrees',
    wins: 'teamrig',
  })),
};
/** The heading a session's own team rules file comes under in its start context (`teamRulesPart`). */
const OWN_RULES_HEADING = "\n\n# Your team's rules\n";

/**
 * A team rules file one character too long to fit beside `roomy`, a start context with its long notes in full and no
 * rules file, so the rules file fits only once a long note comes as its pointer (T1376). Sized from the start itself,
 * its margin hangs on no rule's length; it asserts the start leaves such a file within TEAM_RULES_MAX_CHARS.
 */
export function rulesToOverflow(roomy: string): string {
  const length = CONTEXT_MAX_CHARS - roomy.length - OWN_RULES_HEADING.length + 1;
  assert.ok(length > 0 && length <= TEAM_RULES_MAX_CHARS, `a start ${roomy.length} characters long needs a rules file ${length} long`);
  return 'x'.repeat(length);
}

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
  /** Where git puts the team pointer `team create` writes; default outside any repository. */
  readonly pointerGit?: PointerGit;
  readonly cwd?: string;
  /** The files the CLI sees for this run, such as a `FaultyFiles` over `files`; default `files`. */
  readonly files?: Files;
  /** The byte-exact files the CLI sees, such as one that fails on a path; default the run's files as UTF-8 text. */
  readonly fileBytes?: FileBytes;
  /** The config format the CLI reads, such as a newer release's; default the shipped one. */
  readonly configFormat?: ConfigFormat;
  /** cmd.exe's command line the `teamrig.cmd` shim passes; default none, as from Bash. */
  readonly cmdShimLine?: string;
  /** The commits git lists for any range; default none. */
  readonly commitLog?: CommitLog;
  /** The repository `teamrig secrets` scans, such as a `FakeSecretsGit`; default none it can read. */
  readonly secretsGit?: SecretsGit;
  /** The operating system the CLI sees; default Linux. */
  readonly platform?: NodeJS.Platform;
  /** The machine's time zone; default UTC. */
  readonly timeZone?: string;
  /** The programs the CLI starts; default none is installed. */
  readonly processes?: Processes;
  /** The running session's processes; default the kit's own (`CliHarness.sessionProcesses`). */
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
  /** The plugin store the idle pass dates; default one with nothing in it. */
  readonly pluginStore?: StoreFolders;
  /** What the requirements check finds; default nothing is missing. */
  readonly requirements?: RequirementsCheck;
  /** The Claude Code transcripts `budget` measures; default none. */
  readonly transcripts?: TranscriptSource;
  /** The worktrees `worktree remove` sees; default none. */
  readonly worktrees?: WorktreePorts;
  /** The shutdown log and countdown `restore` sees; default no shutdown on record and a countdown that goes at once. */
  readonly restore?: RestorePorts;
  /** The runner `teamrig queue` runs its step in; default one whose steps exit 0 at once. */
  readonly steps?: StepRunner;
  /** The host memory (queue's watch, `teamrig sessions`); default one that lists no process and measures nothing. */
  readonly memory?: HostMemory;
  /** The processes that started a `teamrig queue` run; default a shell and its Claude Code, which never end. */
  readonly starters?: StarterWatch;
  /** The git `teamrig merge` drives; default the fake repository at /w/feat (testing/fake-merge-git.ts). */
  readonly mergeGit?: MergeGit;
  /** The working tree `teamrig queue --pre-push` reads; default no repository. */
  readonly trees?: TreeState;
  /** The runner `teamrig deploy` runs its checks, afterPull hooks and deploy command in; default one whose programs print nothing and exit 0. */
  readonly hooks?: HookRunner;
  /** The registry the package guard asks about an install; default one that holds no package. */
  readonly packageRegistry?: PackageRegistry;
  /** The process `teamrig exec` runs a command in and the checkout it binds to; default a spawner whose command exits 0 and a clean checkout of the fixture request's repository. */
  readonly exec?: ExecPorts;
  /** The chat webhook posts go to; default one that keeps them and answers each as posted. */
  readonly webhook?: ChatWebhook;
}

/**
 * The CLI over in-memory files, a fixed clock and a fake git, with the kit home at /kit and the
 * working folder in project /work/app, which a pointer ties to team `app`.
 */
export class CliHarness {
  readonly files: MemoryFiles;
  readonly clock = new FakeClock('2030-01-08T10:00:00Z');
  /** The processes a run sees unless it brings its own: none runs until a spec adds one, such as a lock's holder. */
  readonly sessionProcesses = new FakeSessionProcesses();

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

  /**
   * Writes the user's Claude Code settings with every secret deny line, as on a machine whose owner pasted the lines
   * doctor prints: a spec of another doctor or check finding then starts with no `deny-missing`.
   */
  async holdSecretDeny(): Promise<void> {
    await this.files.write(USER_SETTINGS, formatConfig(HELD_DENY));
  }

  async run(argv: readonly string[], options: RunOptions = {}): Promise<CliResult> {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await runCli(argv, {
      env: { TEAMRIG_HOME: KIT, ...options.env },
      userHome: USER_HOME,
      cwd: options.cwd ?? APP,
      pid: CLI_PID,
      files: options.files ?? this.files,
      fileBytes: options.fileBytes ?? textFileBytes(options.files ?? this.files),
      clock: this.clock,
      timeZone: options.timeZone ?? 'UTC',
      sleep: options.sleep ?? this.clock.sleep,
      ...quietWorld(options.branch, options.stdin),
      ...(options.git === undefined ? {} : { git: options.git }),
      ...(options.pointerGit === undefined ? {} : { pointerGit: options.pointerGit }),
      ...(options.commitLog === undefined ? {} : { commitLog: options.commitLog }),
      ...(options.secretsGit === undefined ? {} : { secretsGit: options.secretsGit }),
      ...(options.platform === undefined ? {} : { platform: options.platform }),
      ...(options.processes === undefined ? {} : { processes: options.processes }),
      sessionProcesses: options.sessionProcesses ?? this.sessionProcesses,
      ...(options.shell === undefined ? {} : { shell: options.shell }),
      ...(options.gh === undefined ? {} : { gh: options.gh }),
      ...(options.credentials === undefined ? {} : { credentials: options.credentials }),
      ...(options.probe === undefined ? {} : { probe: options.probe }),
      ...(options.pluginStore === undefined ? {} : { pluginStore: options.pluginStore }),
      ...(options.requirements === undefined ? {} : { requirements: options.requirements }),
      ...(options.transcripts === undefined ? {} : { transcripts: options.transcripts }),
      ...(options.worktrees === undefined ? {} : { worktrees: options.worktrees }),
      ...(options.restore === undefined ? {} : { restore: options.restore }),
      ...(options.steps === undefined ? {} : { steps: options.steps }),
      ...(options.memory === undefined ? {} : { memory: options.memory }),
      ...(options.starters === undefined ? {} : { starters: options.starters }),
      ...(options.mergeGit === undefined ? {} : { mergeGit: options.mergeGit }),
      ...(options.trees === undefined ? {} : { trees: options.trees }),
      ...(options.hooks === undefined ? {} : { hooks: options.hooks }),
      ...(options.packageRegistry === undefined ? {} : { packageRegistry: options.packageRegistry }),
      ...(options.exec === undefined ? {} : { exec: options.exec }),
      ...(options.webhook === undefined ? {} : { webhook: options.webhook }),
      out: { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) },
      ...(options.configFormat === undefined ? {} : { configFormat: options.configFormat }),
      ...(options.cmdShimLine === undefined ? {} : { cmdShimLine: options.cmdShimLine }),
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
