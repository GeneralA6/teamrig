import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { runCli } from '../cli/run.ts';
import type { ExitCode } from '../cli/runtime.ts';
import { formatConfig } from '../config/load.ts';
import type { ConfigFormat } from '../config/migrate.ts';
import type { Files } from '../core/files.ts';
import type { JsonRecord } from '../core/guards.ts';
import type { Env } from '../core/home.ts';
import type { CommitLog } from '../push-guard/commit-size.ts';
import type { RepoState } from '../push-guard/push.ts';
import { FakeClock } from './fake-clock.ts';
import { MemoryFiles } from './memory-files.ts';

/** The user's home folder the CLI sees; the default skills folder lives under it. */
export const USER_HOME = join('/', 'u');
/** The kit home, set through `$TEAMRIG_HOME`. */
export const KIT = join('/', 'kit');
export const TEAM_HOME = join(KIT, 'teams', 'app');
export const CONFIG_PATH = join(TEAM_HOME, 'config.json');
export const EVENTS_PATH = join(TEAM_HOME, 'state', 'events.jsonl');
export const EVENTS_LOCK_PATH = join(TEAM_HOME, 'state', 'events.lock');
export const SKILLS_DIR = join(USER_HOME, '.claude', 'skills');
/** The project folder the CLI runs in, tied to team `app` by its pointer. */
export const APP = resolve('/', 'work', 'app');
export const POINTER = join(APP, '.teamrig.json');
export const CLAUDE_SESSION = '0123abcd-0000-4000-8000-00000000000a';
export const TEAM: JsonRecord = { sessions: ['lead', 'alpha', 'bravo'], roles: { lead: 'lead' } };

export interface CliResult {
  readonly code: ExitCode;
  readonly stdout: readonly string[];
  readonly stderr: readonly string[];
}

export interface RunOptions {
  readonly env?: Env;
  readonly stdin?: string;
  readonly branch?: string;
  readonly cwd?: string;
  /** The files the CLI sees for this run, such as a `FaultyFiles` over `files`; default `files`. */
  readonly files?: Files;
  /** The config format the CLI reads, such as a newer release's; default the shipped one. */
  readonly configFormat?: ConfigFormat;
  /** The commits git lists for any range; default none. */
  readonly commitLog?: CommitLog;
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
    this.files = new MemoryFiles({
      ...(text === null ? {} : { [CONFIG_PATH]: text }),
      ...(pointer === null ? {} : { [POINTER]: pointer }),
    });
  }

  async run(argv: readonly string[], options: RunOptions = {}): Promise<CliResult> {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const git = {
      branch: () => options.branch ?? 'dev',
      pushTarget: () => undefined,
    } satisfies RepoState;
    const code = await runCli(argv, {
      env: { TEAMRIG_HOME: KIT, ...options.env },
      userHome: USER_HOME,
      cwd: options.cwd ?? APP,
      pid: 4242,
      files: options.files ?? this.files,
      clock: this.clock,
      sleep: this.clock.sleep,
      git,
      commitLog: options.commitLog ?? { between: () => [] },
      out: { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) },
      readStdin: async () => options.stdin ?? '',
      ...(options.configFormat === undefined ? {} : { configFormat: options.configFormat }),
    });
    return { code, stdout, stderr };
  }
}

/** A PreToolUse payload for a Bash call in the project folder. */
export function bash(command: string): string {
  return JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd: APP });
}

/** The push guard's permission decision, or undefined when it printed nothing. */
export function decisionOf(result: CliResult): string | undefined {
  const [line] = result.stdout;
  if (line === undefined) {
    return undefined;
  }
  const parsed: unknown = JSON.parse(line);
  assert.ok(typeof parsed === 'object' && parsed !== null && 'hookSpecificOutput' in parsed);
  const output = parsed.hookSpecificOutput;
  assert.ok(typeof output === 'object' && output !== null && 'permissionDecision' in output);
  return String(output.permissionDecision);
}
