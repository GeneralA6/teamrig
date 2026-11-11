import { join } from 'node:path';
import type { Git } from '../lib/git.ts';
import { isRecord, stringField, type JsonRecord } from '../lib/guards.ts';

/** The placeholder Claude Code fills with the installed plugin's folder. */
export const PLUGIN_ROOT_VAR = '${CLAUDE_PLUGIN_ROOT}';

export interface RunRequest {
  readonly file: string;
  readonly args: readonly string[];
  readonly input: string;
  /** Pass the args to cmd.exe as written, the way Node itself starts a command through cmd. */
  readonly verbatim?: boolean;
}

export interface RunResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Starts a program with no shell in between, as Claude Code starts an exec-form hook. */
export type Runner = (request: RunRequest) => RunResult;

export interface SmokeInput {
  readonly platform: NodeJS.Platform;
  /** The plugin folder, as Claude Code would fill in `${CLAUDE_PLUGIN_ROOT}`. */
  readonly pluginRoot: string;
  /** The parsed `hooks/hooks.json`. */
  readonly manifest: unknown;
  /** The version `plugin.json` declares, which `--version` must print. */
  readonly version: string;
  readonly nodePath: string;
  /** cmd.exe, which runs the `.cmd` launcher on Windows. */
  readonly comspec: string;
}

export interface HookCommand {
  readonly event: string;
  readonly args: readonly string[];
}

/** Why the hook's stdout is wrong, or undefined when it is right. */
type Check = (stdout: string) => string | undefined;

interface Sample {
  readonly payload: JsonRecord;
  readonly check: Check;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** The named field of the `hookSpecificOutput` the hook printed, if it printed one. */
function outputField(stdout: string, field: string): string | undefined {
  const parsed = parseJson(stdout);
  const output = isRecord(parsed) ? parsed['hookSpecificOutput'] : undefined;
  return isRecord(output) ? stringField(output, field) : undefined;
}

/** The hook printed nothing; `when` names what keeps it quiet, if the message should say. */
function quiet(when?: string): Check {
  const expected = when === undefined ? 'expected no output' : `expected no output ${when}`;
  return (stdout) => (stdout === '' ? undefined : `${expected}, got ${JSON.stringify(stdout)}`);
}

/** The hook denied the call, which `what` names. */
function denies(what: string): Check {
  return (stdout) => (outputField(stdout, 'permissionDecision') === 'deny' ? undefined : `expected a deny for ${what}`);
}

/** The hook added context for its `event`. */
function addsContext(event: string): Check {
  return (stdout) => (outputField(stdout, 'hookEventName') === event ? undefined : `expected ${event} additionalContext`);
}

/** The hook replaced the tool's result with one that no longer holds `value`. */
function redacts(value: string): Check {
  return (stdout) => {
    const parsed = parseJson(stdout);
    const output = isRecord(parsed) ? parsed['hookSpecificOutput'] : undefined;
    const updated = isRecord(output) ? output['updatedToolOutput'] : undefined;
    return isRecord(updated) && !JSON.stringify(updated).includes(value) ? undefined : 'expected the result back with its secret redacted';
  };
}

const SESSION_ID = '0123abcd-0000-4000-8000-00000000000a';

/** A token the write-time shapes know, built at run time so no file holds one. */
const SMOKE_TOKEN = ['gh', 'p_', 'a1'.repeat(18)].join('');

/**
 * One payload per hook the plugin runs, by its command (one event can run several), run inside team
 * `smoke`, which has no config: session start and a helper's start say so, the push guard still refuses a force-push of
 * main, the package guard refuses an npx of a tool not installed, the secret guard refuses a read of .env, the exec guard refuses a review it cannot tie to a session, the cold-send hook lets a message go, the failed-send hook stays quiet, the missing-cli hook answers a shell that did not find the bare command, the route reminder, the loop nudge and the reminder stay quiet, the secret redactor gives a Bash result back without the token it held, the Stop and
 * SubagentStop hooks print nothing (any output there would block the turn), the refresh wake wakes nothing, and the
 * restore tracker prints nothing, and so do tab status, the compaction hold, the read-only allow and the picker guard,
 * all off without a config.
 */
const SAMPLES: Readonly<Record<string, Sample>> = {
  'hook session-start': {
    payload: { hook_event_name: 'SessionStart', session_id: SESSION_ID, source: 'startup' },
    check: addsContext('SessionStart'),
  },
  'hook push-guard': {
    payload: { hook_event_name: 'PreToolUse', session_id: SESSION_ID, tool_name: 'Bash', tool_input: { command: 'git push --force origin main' } },
    check: denies('a force-push of main'),
  },
  'hook package-guard': {
    payload: { hook_event_name: 'PreToolUse', session_id: SESSION_ID, tool_name: 'Bash', tool_input: { command: 'npx teamrig-smoke-not-installed' } },
    check: denies('an npx of a tool not installed'),
  },
  'hook secret-guard': {
    payload: { hook_event_name: 'PreToolUse', session_id: SESSION_ID, tool_name: 'Bash', tool_input: { command: 'cat .env' } },
    check: denies('a read of .env'),
  },
  'hook exec-guard': {
    payload: { hook_event_name: 'PreToolUse', session_id: SESSION_ID, tool_name: 'Bash', tool_input: { command: 'teamrig exec approve R1' } },
    check: denies('a review that names no --session'),
  },
  'hook pass-record-guard': {
    payload: { hook_event_name: 'PreToolUse', session_id: SESSION_ID, tool_name: 'Write', tool_input: { file_path: '.git/local-ci/abc.json', content: '{}' } },
    check: (stdout) => (outputField(stdout, 'permissionDecision') === 'deny' ? undefined : 'expected a deny for a write of a pass record'),
  },
  'hook cold-send': {
    payload: { hook_event_name: 'PreToolUse', session_id: SESSION_ID, tool_name: 'SendMessage', tool_input: { to: 'lead', message: 'hello' } },
    check: quiet(),
  },
  'hook failed-send': {
    payload: {
      hook_event_name: 'PostToolUse',
      session_id: SESSION_ID,
      tool_name: 'SendMessage',
      tool_use_id: 'toolu_2',
      tool_input: { to: 'lead', message: 'hello' },
      tool_response: { success: false, message: "No agent named 'lead' is reachable." },
    },
    check: quiet(),
  },
  'hook missing-cli': {
    payload: {
      hook_event_name: 'PostToolUseFailure',
      session_id: SESSION_ID,
      tool_name: 'Bash',
      tool_use_id: 'toolu_3',
      tool_input: { command: 'teamrig list' },
      error: 'Exit code 127\nbash: teamrig: command not found',
    },
    check: addsContext('PostToolUseFailure'),
  },
  'hook route-reminder': {
    payload: {
      hook_event_name: 'PostToolUse',
      session_id: SESSION_ID,
      tool_name: 'SendMessage',
      tool_use_id: 'toolu_4',
      tool_input: { to: 'lead', message: 'hello' },
      tool_response: { success: true, message: "Message sent to lead's inbox" },
    },
    check: quiet(),
  },
  'hook loop-nudge': {
    payload: { hook_event_name: 'PostToolUse', session_id: SESSION_ID, tool_name: 'Read', tool_use_id: 'toolu_1', tool_input: { file_path: 'a.ts' } },
    check: quiet(),
  },
  'hook secret-redact': {
    payload: {
      hook_event_name: 'PostToolUse',
      session_id: SESSION_ID,
      tool_name: 'Bash',
      tool_use_id: 'toolu_5',
      tool_input: { command: 'gh auth token' },
      tool_response: { stdout: SMOKE_TOKEN, stderr: '', interrupted: false, isImage: false },
    },
    check: redacts(SMOKE_TOKEN),
  },
  'hook helper-gate': {
    payload: { hook_event_name: 'PreToolUse', session_id: SESSION_ID, tool_name: 'Agent', tool_input: { description: 'search', prompt: 'find it' } },
    check: quiet(),
  },
  'hook inbox-reminder': {
    payload: { hook_event_name: 'UserPromptSubmit', session_id: SESSION_ID, prompt: 'hello' },
    check: () => undefined,
  },
  'hook stop': {
    payload: { hook_event_name: 'Stop', session_id: SESSION_ID, stop_hook_active: false },
    check: quiet(),
  },
  'hook subagent-start': {
    payload: { hook_event_name: 'SubagentStart', session_id: SESSION_ID, agent_id: 'a1', agent_type: 'general-purpose' },
    check: addsContext('SubagentStart'),
  },
  'hook subagent-stop': {
    payload: { hook_event_name: 'SubagentStop', session_id: SESSION_ID, stop_hook_active: false, agent_id: 'a1', agent_type: 'general-purpose' },
    check: quiet(),
  },
  'hook refresh-wake': {
    payload: { hook_event_name: 'SessionStart', session_id: SESSION_ID, source: 'clear' },
    check: quiet(),
  },
  'hook restore-track': {
    payload: { hook_event_name: 'Stop', session_id: SESSION_ID, cwd: 'smoke-project', stop_hook_active: false },
    check: quiet(),
  },
  'hook effort-writeback': {
    payload: { hook_event_name: 'SessionEnd', session_id: SESSION_ID, cwd: 'smoke-project', transcript_path: 'smoke-transcript.jsonl', reason: 'prompt_input_exit' },
    check: quiet(),
  },
  'hook tab-status': {
    payload: { hook_event_name: 'UserPromptSubmit', session_id: SESSION_ID, cwd: 'smoke-project', prompt: 'hello' },
    check: quiet(),
  },
  'hook pre-compact': {
    payload: { hook_event_name: 'PreCompact', session_id: SESSION_ID, cwd: 'smoke-project', transcript_path: 'smoke-transcript.jsonl', trigger: 'auto' },
    check: quiet(),
  },
  'hook tool-end': {
    payload: { hook_event_name: 'PostToolUse', session_id: SESSION_ID, cwd: 'smoke-project', tool_name: 'Bash', tool_input: { command: 'ls' } },
    check: quiet(),
  },
  'hook readonly-allow': {
    payload: { hook_event_name: 'PreToolUse', session_id: SESSION_ID, tool_name: 'Bash', tool_input: { command: 'cat package.json' } },
    check: quiet('with the hook off'),
  },
  'hook picker-guard': {
    payload: { hook_event_name: 'PreToolUse', session_id: SESSION_ID, tool_name: 'AskUserQuestion', tool_input: { questions: [] } },
    check: quiet('with the guard off'),
  },
  'hook prompt-refuse': {
    payload: { hook_event_name: 'PermissionRequest', session_id: SESSION_ID, tool_name: 'Bash', tool_input: { command: 'git push origin main' } },
    check: quiet('with asks on'),
  },
  'hook route-allow': {
    payload: { hook_event_name: 'PreToolUse', session_id: SESSION_ID, tool_name: 'Bash', tool_input: { command: 'teamrig merge --session smoke' } },
    check: quiet('with asks on'),
  },
};

function isStringList(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/**
 * Every hook in hooks.json with the plugin folder filled in. A hook must be exec form (`node` and
 * an args list): a command string goes through whichever shell Claude Code picks, which differs by OS.
 */
export function hookCommandsOf(manifest: unknown, pluginRoot: string): { readonly commands: HookCommand[]; readonly findings: string[] } {
  const commands: HookCommand[] = [];
  const findings: string[] = [];
  const events = isRecord(manifest) ? manifest['hooks'] : undefined;
  if (!isRecord(events)) {
    return { commands, findings: ['hooks.json has no "hooks" object'] };
  }
  for (const [event, groups] of Object.entries(events)) {
    for (const group of Array.isArray(groups) ? groups : []) {
      const hooks: unknown = isRecord(group) ? group['hooks'] : undefined;
      for (const hook of Array.isArray(hooks) ? hooks : []) {
        const args: unknown = isRecord(hook) ? hook['args'] : undefined;
        if (!isRecord(hook) || stringField(hook, 'command') !== 'node' || !isStringList(args)) {
          findings.push(`${event}: a hook is not exec form ("command": "node" with an "args" list): ${JSON.stringify(hook)}`);
          continue;
        }
        commands.push({ event, args: args.map((arg) => arg.replaceAll(PLUGIN_ROOT_VAR, pluginRoot)) });
      }
    }
  }
  return { commands, findings };
}

function failed(what: string, result: RunResult): string | undefined {
  if (result.status !== 0) {
    return `${what}: exit ${result.status ?? 'none'}${result.stderr.trim() === '' ? '' : `: ${result.stderr.trim()}`}`;
  }
  return result.stderr.trim() === '' ? undefined : `${what}: wrote to stderr: ${result.stderr.trim()}`;
}

/** The launcher on the Bash PATH. A checkout takes its executable bit from the commit, never the disk. */
export const POSIX_LAUNCHER = 'plugins/teamrig/bin/teamrig';

/** Checks the committed mode, which a Windows run cannot see on disk: anything but 100755 fails to start on Linux and macOS. */
export async function launcherModeFinding(git: Git): Promise<string | undefined> {
  const [mode] = (await git.text(['ls-files', '--stage', '--', POSIX_LAUNCHER])).split(' ');
  if (mode === undefined || mode.trim() === '') {
    return `${POSIX_LAUNCHER} is not committed`;
  }
  return mode === '100755' ? undefined : `${POSIX_LAUNCHER} is committed with mode ${mode}, not 100755; run git update-index --chmod=+x ${POSIX_LAUNCHER}`;
}

/** An argument holding a line break, which the launcher must hand the CLI whole: cmd.exe ends `%*` at the first one. */
export const MULTI_LINE_ARG = 'no\nsuch';

/** The CLI's usage exit, which an unknown command gets. */
const USAGE_EXIT = 64;

/** The launcher on the Bash PATH (POSIX), or cmd.exe running the one for cmd and PowerShell (Windows), given `args`. */
function launcherRequest(input: SmokeInput, args: readonly string[]): RunRequest {
  const bin = join(input.pluginRoot, 'bin');
  if (input.platform !== 'win32') {
    return { file: join(bin, 'teamrig'), args, input: '' };
  }
  const line = [`"${join(bin, 'teamrig.cmd')}"`, ...args.map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg))].join(' ');
  return { file: input.comspec, args: ['/d', '/s', '/c', `"${line}"`], input: '', verbatim: true };
}

/** The launcher prints the version. */
function versionFinding(input: SmokeInput, run: Runner): string | undefined {
  const result = run(launcherRequest(input, ['--version']));
  const expected = `teamrig ${input.version}`;
  return failed('bin launcher --version', result) ?? (result.stdout.trim() === expected ? undefined : `bin launcher --version: printed "${result.stdout.trim()}", expected "${expected}"`);
}

/** The launcher hands the CLI a multi-line argument whole, which the CLI names back as an unknown command. */
function multiLineFinding(input: SmokeInput, run: Runner): string | undefined {
  const result = run(launcherRequest(input, [MULTI_LINE_ARG]));
  const expected = `unknown command "${MULTI_LINE_ARG}"`;
  if (result.status === USAGE_EXIT && result.stderr.startsWith(expected)) {
    return undefined;
  }
  const said = result.stderr.split('\n').slice(0, 2).join('\n').trim();
  return `bin launcher with a multi-line argument: expected exit ${USAGE_EXIT} and ${JSON.stringify(expected)}, got exit ${result.status ?? 'none'} and ${JSON.stringify(said)}`;
}

/** Runs the built plugin the way an installed copy runs; returns what is wrong, empty when nothing is. */
export function smokeDist(input: SmokeInput, run: Runner): string[] {
  const { commands, findings } = hookCommandsOf(input.manifest, input.pluginRoot);
  for (const launcher of [versionFinding(input, run), multiLineFinding(input, run)]) {
    if (launcher !== undefined) {
      findings.push(launcher);
    }
  }
  for (const { event, args } of commands) {
    const hook = args.slice(1).join(' ');
    const sample = SAMPLES[hook];
    const what = `${event} (${hook})`;
    if (sample === undefined) {
      findings.push(`${what}: no smoke sample for ${hook}; add one to tools/ci/dist-smoke.ts`);
      continue;
    }
    const result = run({ file: input.nodePath, args, input: JSON.stringify(sample.payload) });
    const problem = failed(what, result) ?? sample.check(result.stdout);
    if (problem !== undefined) {
      findings.push(problem.startsWith(what) ? problem : `${what}: ${problem}`);
    }
  }
  return findings;
}
