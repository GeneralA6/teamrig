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

interface Sample {
  readonly payload: JsonRecord;
  /** Why the hook's stdout is wrong, or undefined when it is right. */
  readonly check: (stdout: string) => string | undefined;
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

const SESSION_ID = '0123abcd-0000-4000-8000-00000000000a';

/**
 * One payload per hook the plugin runs, by its command (one event can run several), run inside team
 * `smoke`, which has no config: session start says so, the push guard still refuses a force-push of
 * main, the cold-send hook lets a message go, the reminder stays quiet, and the Stop hook prints
 * nothing (any output there would block the turn).
 */
const SAMPLES: Readonly<Record<string, Sample>> = {
  'hook session-start': {
    payload: { hook_event_name: 'SessionStart', session_id: SESSION_ID, source: 'startup' },
    check: (stdout) => (outputField(stdout, 'hookEventName') === 'SessionStart' ? undefined : 'expected SessionStart additionalContext'),
  },
  'hook push-guard': {
    payload: { hook_event_name: 'PreToolUse', session_id: SESSION_ID, tool_name: 'Bash', tool_input: { command: 'git push --force origin main' } },
    check: (stdout) => (outputField(stdout, 'permissionDecision') === 'deny' ? undefined : 'expected a deny for a force-push of main'),
  },
  'hook cold-send': {
    payload: { hook_event_name: 'PreToolUse', session_id: SESSION_ID, tool_name: 'SendMessage', tool_input: { to: 'lead', message: 'hello' } },
    check: (stdout) => (stdout === '' ? undefined : `expected no output, got ${JSON.stringify(stdout)}`),
  },
  'hook inbox-reminder': {
    payload: { hook_event_name: 'UserPromptSubmit', session_id: SESSION_ID, prompt: 'hello' },
    check: () => undefined,
  },
  'hook stop': {
    payload: { hook_event_name: 'Stop', session_id: SESSION_ID, stop_hook_active: false },
    check: (stdout) => (stdout === '' ? undefined : `expected no output, got ${JSON.stringify(stdout)}`),
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

/** The launcher on the Bash PATH (POSIX) or for cmd and PowerShell (Windows) prints the version. */
function launcherFinding(input: SmokeInput, run: Runner): string | undefined {
  const bin = join(input.pluginRoot, 'bin');
  const request: RunRequest =
    input.platform === 'win32'
      ? { file: input.comspec, args: ['/d', '/s', '/c', `""${join(bin, 'teamrig.cmd')}" --version"`], input: '', verbatim: true }
      : { file: join(bin, 'teamrig'), args: ['--version'], input: '' };
  const result = run(request);
  const expected = `teamrig ${input.version}`;
  return failed('bin launcher --version', result) ?? (result.stdout.trim() === expected ? undefined : `bin launcher --version: printed "${result.stdout.trim()}", expected "${expected}"`);
}

/** Runs the built plugin the way an installed copy runs; returns what is wrong, empty when nothing is. */
export function smokeDist(input: SmokeInput, run: Runner): string[] {
  const { commands, findings } = hookCommandsOf(input.manifest, input.pluginRoot);
  const launcher = launcherFinding(input, run);
  if (launcher !== undefined) {
    findings.push(launcher);
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
