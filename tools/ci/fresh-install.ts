import { delimiter, join } from 'node:path';
import { hookCommandsOf, type RunRequest, type RunResult } from './dist-smoke.ts';

/**
 * A new developer's first run, as far as it goes without Claude Code: clone the repo with no git login (what
 * `claude plugin marketplace add` does), put the plugin's bin folder on PATH (what Claude Code does for a tab's
 * shell), set up a new team on a new project, run start, add, list, set and inbox, then fire every hook against
 * that team. Each step names the text its output must hold, so a step that exits 0 but did nothing still fails.
 */
export interface InstallInput {
  readonly platform: NodeJS.Platform;
  /** What git clones: the repo's URL, or a `file://` URL of a checkout. */
  readonly source: string;
  /** An empty folder that stands in for the developer's home; everything is written under it. */
  readonly home: string;
  /** The PATH the developer already has, which the plugin's bin folder goes in front of. */
  readonly path: string;
  readonly nodePath: string;
  /** cmd.exe, which runs the `.cmd` launcher on Windows, as cmd and PowerShell do. */
  readonly comspec: string;
}

/** Runs one program with no shell in between, in `cwd`, with the developer's environment. */
export type InstallRunner = (request: RunRequest, cwd: string) => RunResult;

export interface InstallStep {
  readonly label: string;
  readonly request: RunRequest;
  readonly cwd: string;
  /** Text the step's stdout must hold; a step without one needs only exit 0. */
  readonly expect?: string;
}

export interface InstallReport {
  /** One line per step: its exit code and label. */
  readonly log: readonly string[];
  /** What went wrong, empty when nothing did. */
  readonly findings: readonly string[];
}

export const TEAM = 'demo';
export const LEAD = 'lead';
export const WORKER = 'web';
export const TASK_TITLE = 'Build the signup form';

/** The hook payloads' session id: a fresh tab, which no session has claimed. */
const SESSION_ID = '00000000-0000-4000-8000-0000000000f1';

/** Where the clone, the plugin in it and the new project go under `home`. */
export function layoutOf(home: string): { readonly clone: string; readonly plugin: string; readonly project: string } {
  const clone = join(home, 'teamrig');
  return { clone, plugin: join(clone, 'plugins', 'teamrig'), project: join(home, 'demo-project') };
}

/**
 * The inherited variable `name` under whichever case this OS spells it (Windows hands Node `Path`, Git Bash
 * `COMSPEC`), or `fallback` when it is not set.
 */
export function inheritedValue(inherited: Readonly<Record<string, string | undefined>>, name: string, fallback: string): string {
  const key = Object.keys(inherited).find((each) => each.toUpperCase() === name.toUpperCase());
  return (key === undefined ? undefined : inherited[key]) ?? fallback;
}

/**
 * The developer's environment: the scratch home for every tool, git with no system config and no login
 * prompt, a commit identity, and the plugin's bin folder first on PATH. Every other variable is left out, so
 * the runner's own kit home or team never leaks in.
 */
export function installEnv(input: InstallInput, inherited: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const env: Record<string, string> = {};
  // Windows needs these to start programs at all; neither names the developer's kit or team.
  for (const key of ['SystemRoot', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP', 'TMPDIR']) {
    const value = inherited[key];
    if (value !== undefined) env[key] = value;
  }
  return {
    ...env,
    HOME: input.home,
    USERPROFILE: input.home,
    PATH: [join(layoutOf(input.home).plugin, 'bin'), input.path].join(delimiter),
    TEAMRIG_HOME: join(input.home, '.teamrig'),
    TEAMRIG_TEAM: TEAM,
    TEAMRIG_SESSION: LEAD,
    CLAUDE_CONFIG_DIR: join(input.home, '.claude'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'dev',
    GIT_AUTHOR_EMAIL: 'dev@example.com',
    GIT_COMMITTER_NAME: 'dev',
    GIT_COMMITTER_EMAIL: 'dev@example.com',
  };
}

/** An argument cmd.exe takes as written: quoted when it holds a space or comma, refused when it holds a character cmd reads. */
export function cmdArg(arg: string): string {
  if (!/^[\w\-.,:\\/=@~+ ]*$/.test(arg)) {
    throw new Error(`fresh-install: ${JSON.stringify(arg)} holds a character cmd.exe would read`);
  }
  return arg === '' || /[ ,]/.test(arg) ? `"${arg}"` : arg;
}

/**
 * A bare `teamrig`, found on the PATH as a developer's shell finds it: the POSIX launcher directly, the `.cmd`
 * one through cmd.exe on Windows, since Node starts no `.cmd` file without a shell.
 */
export function teamrigRequest(input: InstallInput, args: readonly string[]): RunRequest {
  if (input.platform !== 'win32') {
    return { file: 'teamrig', args, input: '' };
  }
  const line = ['teamrig', ...args.map(cmdArg)].join(' ');
  return { file: input.comspec, args: ['/d', '/s', '/c', `"${line}"`], input: '', verbatim: true };
}

function git(args: readonly string[]): RunRequest {
  return { file: 'git', args, input: '' };
}

/** Every step of the first run but the hooks, which hooks.json in the clone names. */
export function installSteps(input: InstallInput): readonly InstallStep[] {
  const { clone, project } = layoutOf(input.home);
  const teamrig = (label: string, args: readonly string[], expect: string): InstallStep => ({
    label,
    request: teamrigRequest(input, args),
    cwd: project,
    expect,
  });
  return [
    { label: 'git clone, no login', request: git(['clone', '-q', '--depth', '1', input.source, clone]), cwd: input.home },
    { label: 'teamrig --version, bare on the PATH', request: teamrigRequest(input, ['--version']), cwd: input.home, expect: 'teamrig ' },
    { label: 'git init the project', request: git(['init', '-q', project]), cwd: input.home },
    // A new project holds no file yet, and team create needs a first commit to cut worktrees from.
    { label: 'git commit the project', request: git(['commit', '-q', '--allow-empty', '-m', 'init']), cwd: project },
    teamrig('team create', ['team', 'create', TEAM, '--sessions', `${LEAD},${WORKER}`, '--project', project], 'ADDED T1 Set up the team'),
    teamrig('start', ['start', '--session', LEAD], `START ${LEAD}`),
    teamrig(
      'add',
      ['add', '--session', LEAD, '--owner', WORKER, '--priority', 'p1', '--title', TASK_TITLE, '--description', 'A form for new users, so they can sign up'],
      `ADDED T2 open, p1, owner ${WORKER}`,
    ),
    teamrig('list', ['list'], `T2 open, Improvements`),
    teamrig('set', ['set', 'T2', '--session', WORKER, '--status', 'in-progress', '--note', 'started'], 'SET T2 in-progress'),
    teamrig('inbox read', ['inbox', 'read', '--session', WORKER], `T2 is yours (p1): ${TASK_TITLE}`),
  ];
}

/** What is wrong with a step's result, or undefined when it ran as expected. */
function stepFinding(step: InstallStep, result: RunResult): string | undefined {
  if (result.status !== 0) {
    const said = `${result.stdout}${result.stderr}`.trim();
    return `${step.label}: exit ${result.status ?? 'none'}${said === '' ? '' : `: ${said}`}`;
  }
  if (step.expect !== undefined && !result.stdout.includes(step.expect)) {
    return `${step.label}: expected ${JSON.stringify(step.expect)} in its output, got ${JSON.stringify(result.stdout.trim())}`;
  }
  return undefined;
}

/** A tool call from a fresh tab in the new project, which every hook event reads its own fields from. */
function hookPayload(event: string, project: string): string {
  return JSON.stringify({
    session_id: SESSION_ID,
    transcript_path: join(project, 'transcript.jsonl'),
    cwd: project,
    hook_event_name: event,
    tool_name: 'Bash',
    tool_input: { command: 'git status' },
    tool_response: { stdout: '', stderr: '', exitCode: 0 },
    prompt: 'hello',
    source: 'startup',
    stop_hook_active: false,
  });
}

/**
 * Runs the first run step by step and stops at the first failed one, since each needs the one before; then,
 * with the team set up, fires every hook of the cloned plugin in the new project, each of which must exit 0.
 */
export function freshInstall(input: InstallInput, run: InstallRunner, readManifest: (plugin: string) => unknown): InstallReport {
  const log: string[] = [];
  for (const step of installSteps(input)) {
    const result = run(step.request, step.cwd);
    log.push(`exit ${result.status ?? 'none'} ${step.label}`);
    const finding = stepFinding(step, result);
    if (finding !== undefined) {
      return { log, findings: [finding] };
    }
  }
  const { plugin, project } = layoutOf(input.home);
  const { commands, findings } = hookCommandsOf(readManifest(plugin), plugin);
  for (const { event, args } of commands) {
    const step: InstallStep = { label: `${event} hook (${args.slice(1).join(' ')})`, request: { file: input.nodePath, args, input: hookPayload(event, project) }, cwd: project };
    const result = run(step.request, step.cwd);
    log.push(`exit ${result.status ?? 'none'} ${step.label}`);
    const finding = stepFinding(step, result);
    if (finding !== undefined) {
      findings.push(finding);
    }
  }
  return { log, findings };
}
