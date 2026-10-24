import { resolve } from 'node:path';
import { describeLaunch, launchOf } from '../../config/launch.ts';
import type { Roster } from '../../config/roster.ts';
import { isEffortLevel, isTerminalChoice, TERMINALS, type EffortLevel, type KitConfig, type TerminalChoice } from '../../config/types.ts';
import { splitAddress } from '../../core/address.ts';
import { ENV, KIT_NAME, type Env, type TeamPaths } from '../../core/home.ts';
import { ID_PATTERN, ID_RULE } from '../../core/ids.ts';
import { HiringLog, rehiredFrom, type RetireRecord } from '../../hiring/log.ts';
import type { ResumeVerdict } from '../../hiring/rehire.ts';
import { CLAUDE_SESSION_ID } from '../../inbox/marks.ts';
import { findClaude, type ClaudeProgram } from '../../open/claude.ts';
import { launchFlags } from '../../open/launch-flags.ts';
import { openTab, type OpenOutcome } from '../../open/open-tab.ts';
import { decodePrompt, defaultPrompt, encodePrompt, PROMPT_MAX, promptProblem, refreshPrompt, rehirePrompt, reopenPrompt, resumePrompt } from '../../open/prompt.ts';
import { shellCommand } from '../../open/quote.ts';
import { sessionEnv } from '../../open/session-env.ts';
import type { RunOutcome } from '../../open/processes.ts';
import { RefreshStore } from '../../refresh/store.ts';
import { noRoomText } from '../../sessions/headroom.ts';
import { closedOf, SessionLog } from '../../sessions/log.ts';
import type { Terminal } from '../../open/terminals.ts';
import { urgentFirstPrompt, type WakeAsk } from '../../wake/asks.ts';
import { onePositional, requiredFlag, UsageError, type ParsedArgs } from '../args.ts';
import { headroomOf } from '../headroom.ts';
import { findTeam, openKit, requireConfig, rosterOf, sessionIdOf, teamZone, type Kit } from '../kit.ts';
import { EXIT, RefusedError, type CliRuntime, type ExitCode } from '../runtime.ts';
import { loadTree } from '../tree.ts';
import { claudeSessionVerdict, freshOpenOf, resumeVerdictOf } from './rehire.ts';
import { sessionProjectOf } from './setup.ts';

/** The terminal names a person reads, for the OPENED line. */
export const TERMINAL_LABELS: Readonly<Record<Terminal, string>> = {
  tmux: 'tmux window',
  'windows-terminal': 'Windows Terminal tab',
  'macos-terminal': 'Terminal window',
  'gnome-terminal': 'GNOME Terminal tab',
  konsole: 'Konsole tab',
  'x-terminal-emulator': 'terminal window',
};

/** The terminal `--terminal` names; undefined when it names none. */
export function terminalFlag(flag: string | undefined): TerminalChoice | undefined {
  if (flag !== undefined && !isTerminalChoice(flag)) {
    throw new UsageError(`--terminal "${flag}" is not one of ${TERMINALS.join(', ')}`);
  }
  return flag;
}

function checkedPrompt(prompt: string): string {
  const problem = promptProblem(prompt);
  if (problem !== undefined) {
    throw new UsageError(`--prompt: ${problem}`);
  }
  return prompt;
}

/**
 * The team a session to open is on: the project's own team, or, for `<team>/<id>`, another team of
 * the same tree, whose sessions share the project folder and get their team from `$TEAMRIG_TEAM`.
 */
async function openTeamOf(runtime: CliRuntime, own: string, named: string | undefined): Promise<string> {
  if (named === undefined || named === own) {
    return own;
  }
  const { tree } = await loadTree(runtime);
  if (tree.node(named) === undefined || !tree.sameTree(own, named)) {
    throw new RefusedError(`team ${named} is not in the tree of team ${own}; open its sessions from its own project folder`);
  }
  return named;
}

/**
 * `--home <dir>` for a command a new tab runs, when this one runs on a kit home other than the default:
 * the tab's own environment may not carry `$TEAMRIG_HOME` (a Windows Terminal tab gets the terminal's).
 */
export function homeArgs(runtime: CliRuntime): string[] {
  const customHome = runtime.env[ENV.home]?.trim();
  return customHome === undefined || customHome === '' ? [] : ['--home', resolve(runtime.cwd, customHome)];
}

/** A new tab for a session: where it opens, in which terminal, and the first prompt. */
export interface SessionTab {
  readonly team: string;
  readonly id: string;
  readonly name: string;
  readonly project: string;
  /** The first prompt; undefined starts Claude Code with none. */
  readonly prompt: string | undefined;
  readonly terminal: TerminalChoice;
  /** The Claude Code session to resume (`open --resume`); the automatic restart never resumes one. */
  readonly resume?: string;
  /** The effort to start on instead of the configured one: the restore after a reboot reopens a session at its last. */
  readonly effort?: EffortLevel;
}

export interface SessionTabOutcome {
  readonly outcome: OpenOutcome;
  /** The command line the tab runs, for a person to run when no terminal opened. */
  readonly argv: readonly string[];
}

/**
 * Opens a terminal tab titled with the session's name that runs `launch` for it, by absolute paths,
 * since the plugin's bin folder is on PATH only inside Claude Code: `open` and the automatic restart.
 */
export async function openSessionTab(runtime: CliRuntime, tab: SessionTab): Promise<SessionTabOutcome> {
  const argv = [
    runtime.self.node,
    runtime.self.script,
    'launch',
    tab.id,
    '--team',
    tab.team,
    '--project',
    tab.project,
    ...homeArgs(runtime),
    ...(tab.resume === undefined ? [] : ['--resume', tab.resume]),
    ...(tab.effort === undefined ? [] : ['--effort', tab.effort]),
    ...(tab.prompt === undefined ? ['--no-prompt'] : ['--encoded-prompt', encodePrompt(tab.prompt)]),
  ];
  return { outcome: await openTab(runtime, tab.terminal, { title: tab.name, folder: tab.project, argv }), argv };
}

/**
 * `open <id|name> [--prompt <text>] [--terminal <name>] [--project <dir>] [--resume]`: a new terminal tab in
 * the session's project folder (by default its `launch.<id>.project`, else the team's `team.project`, else the
 * folder holding the team's pointer) that runs `launch`, so Claude Code starts there as the session. The command
 * runs by absolute paths, since the plugin's bin folder is on PATH only inside Claude Code. When no terminal opens it prints the command to run instead and exits 3. A rehired session opens
 * on the handover its retire left, or, with --resume, in its last Claude Code session when that is small and
 * recent enough (`hiring.resumeMaxTokens`, `hiring.resumeMaxIdleDays`). It refuses any session but the lead when
 * the host has no room for one more (`open.headroom`, src/sessions/headroom.ts). A session `teamrig close` ended
 * goes on in its last Claude Code session by the same limits, else opens fresh, and the reopen is logged.
 */
export async function open(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  const target = onePositional(args, 'id|name');
  const address = splitAddress(target);
  const found = await findTeam(runtime);
  const team = await openTeamOf(runtime, found.team, address?.team);
  const kit = await openKit(runtime, team);
  const config = requireConfig(kit, runtime, 'read');
  const roster = await rosterOf(runtime, kit, config);
  const id = sessionIdOf(roster, address?.session ?? target);
  const terminal = terminalFlag(args.flags.get('terminal')) ?? config.open.terminal;
  const project = await sessionProjectOf(runtime, config, id, args.flags.get('project'), found.from);
  const prompt = args.flags.get('prompt');
  const opened = await openSession(runtime, kit, config, roster, { team, id, project, terminal, asked: args.switches.has('resume'), ...(prompt === undefined ? {} : { prompt }) });
  if (opened.kind === 'opened') {
    runtime.out.stdout(opened.line);
    return EXIT.ok;
  }
  const shell = runtime.platform === 'win32' ? ' in PowerShell' : '';
  runtime.out.stdout(`MANUAL no terminal opened (${opened.reasons.join('; ')}); open a new terminal and run this${shell}:`);
  runtime.out.stdout(shellCommand(runtime.platform, project, opened.argv));
  return EXIT.printed;
}

/** One session to open: where, in which terminal, the first prompt `--prompt` gave, and whether `--resume` was given. */
export interface OpenRequest {
  readonly team: string;
  readonly id: string;
  readonly project: string;
  readonly terminal: TerminalChoice;
  /** The first prompt in place of the one the session's state gives. */
  readonly prompt?: string;
  readonly asked: boolean;
  /** Urgent lines posted while the session was closed, quoted ahead of its first prompt (the idle pass's reopen). */
  readonly urgent?: readonly WakeAsk[];
}

/** A tab that opened, with its OPENED line, or no terminal, with why and the command line to run instead. */
export type OpenResult =
  | { readonly kind: 'opened'; readonly line: string }
  | { readonly kind: 'manual'; readonly reasons: readonly string[]; readonly argv: readonly string[] };

/**
 * Opens the session's tab as `open` describes: a rehired one on its handover, a closed one in its last Claude Code
 * session or fresh, refused (`RefusedError`) for any session but the lead when the host has no room, and a closed
 * one's reopen logged once its tab opened.
 */
export async function openSession(runtime: CliRuntime, kit: Kit, config: KitConfig, roster: Roster, request: OpenRequest): Promise<OpenResult> {
  const { team, id, project, terminal, asked } = request;
  const from = rehiredFrom((await new HiringLog(runtime.files, kit.paths.hires).read()).records, id);
  const sessionLog = new SessionLog(runtime.files, kit.paths.sessionLog);
  const closed = closedOf((await sessionLog.read()).records, id);
  const reopen = closed === undefined ? undefined : await claudeSessionVerdict(runtime, config.hiring, closed.claudeSession, project);
  const resume = await resumeOf(runtime, kit.paths, config, { id, project, from, reopen, asked });
  const own = request.prompt ?? firstPromptOf(team, id, from, resume, reopen);
  const prompt = checkedPrompt(urgentFirstPrompt(request.urgent ?? [], own, teamZone(config, runtime), PROMPT_MAX));
  const name = roster.nameOf(id) ?? id;
  // The lead opens whatever the room: it is the session that decides which others run.
  if (id !== roster.holderOf('lead')) {
    const headroom = await headroomOf(runtime, kit.paths, config, roster.ids);
    if (headroom.short.length > 0) {
      throw new RefusedError(noRoomText(`open ${name} (session ${id})`, headroom));
    }
  }
  const { outcome, argv } = await openSessionTab(runtime, { team, id, name, project, prompt, terminal, ...(resume === undefined ? {} : { resume }) });
  if (outcome.kind !== 'opened') {
    return { kind: 'manual', reasons: outcome.reasons, argv };
  }
  if (closed !== undefined) {
    await sessionLog.append({ kind: 'reopen', session: id, at: new Date(runtime.clock.now()).toISOString(), ...(resume === undefined ? {} : { resumed: resume }) });
  }
  return { kind: 'opened', line: `OPENED ${name} (session ${id}) in a new ${TERMINAL_LABELS[outcome.terminal]} in ${project}, on ${describeLaunch(launchOf(config, id))}${startNoteOf(resume, reopen)}` };
}

/** What decides which Claude Code session a tab goes on in. */
interface ResumeFacts {
  readonly id: string;
  readonly project: string;
  /** The retire a rehired session comes back from. */
  readonly from: RetireRecord | undefined;
  /** Whether a session `teamrig close` ended can go on in its last Claude Code session; undefined when it was not closed. */
  readonly reopen: ResumeVerdict | undefined;
  /** `--resume` was given. */
  readonly asked: boolean;
}

/**
 * The Claude Code session the tab resumes, undefined for a new one. A closed session resumes its last one when that
 * is small and recent enough, else opens fresh (and `--resume` refuses); any other resumes only with `--resume`, and
 * only a rehired session's.
 */
async function resumeOf(runtime: CliRuntime, paths: TeamPaths, config: KitConfig, facts: ResumeFacts): Promise<string | undefined> {
  const { id, project, from, reopen, asked } = facts;
  if (reopen !== undefined) {
    if (reopen.kind === 'resume') {
      return reopen.claudeSession;
    }
    if (asked) {
      throw new RefusedError(`not resumed: ${reopen.detail}; ${KIT_NAME} open ${id} opens it fresh`);
    }
    return undefined;
  }
  if (!asked) {
    return undefined;
  }
  if (from === undefined) {
    throw new RefusedError(`${id} was neither hired back after a retire nor closed: --resume resumes only a rehired session's last Claude Code session`);
  }
  const verdict = await resumeVerdictOf(runtime, paths, config.hiring, id, project);
  if (verdict.kind === 'fresh') {
    throw new RefusedError(`not resumed: ${verdict.detail}; ${freshOpenOf(from)}: ${KIT_NAME} open ${id}`);
  }
  return verdict.claudeSession;
}

/** What the OPENED line adds: the Claude Code session the tab resumes, or why a closed session opens fresh. */
function startNoteOf(resume: string | undefined, reopen: ResumeVerdict | undefined): string {
  if (resume !== undefined) {
    return `, resuming Claude Code session ${resume}`;
  }
  return reopen?.kind === 'fresh' ? `, fresh (${reopen.detail})` : '';
}

/**
 * The first prompt unless --prompt gives one: a reopened or resumed session's moved tasks, a closed one opened fresh
 * the default, a rehired one's handover first.
 */
function firstPromptOf(team: string, id: string, from: RetireRecord | undefined, resume: string | undefined, reopen: ResumeVerdict | undefined): string {
  if (reopen !== undefined) {
    return resume === undefined ? defaultPrompt(team, id) : reopenPrompt(team, id);
  }
  if (resume !== undefined) {
    return resumePrompt(team, id);
  }
  return from?.handover === undefined ? defaultPrompt(team, id) : rehirePrompt(team, id, from.handover);
}

export function idFlag(flag: string, value: string): string {
  if (!ID_PATTERN.test(value)) {
    throw new UsageError(`${flag} "${value}" is not an id (${ID_RULE})`);
  }
  return value;
}

/** Launch's first prompt: the encoded one, none with --no-prompt, else the default. */
function launchPrompt(args: ParsedArgs, team: string, id: string): string | undefined {
  const encoded = args.flags.get('encoded-prompt');
  if (args.switches.has('no-prompt')) {
    if (encoded !== undefined) {
      throw new UsageError('--no-prompt and --encoded-prompt cannot go together');
    }
    return undefined;
  }
  return encoded === undefined ? defaultPrompt(team, id) : encodedPromptFlag(encoded);
}

/** The prompt `--encoded-prompt` carries, as `open` or the restore encoded it for a new tab. */
export function encodedPromptFlag(encoded: string): string {
  const prompt = decodePrompt(encoded);
  if (prompt === undefined) {
    throw new UsageError('--encoded-prompt is not a prompt that teamrig open wrote');
  }
  return checkedPrompt(prompt);
}

/** The Claude Code session id `launch --resume` names, checked so nothing but an id reaches Claude Code. */
function resumeFlag(value: string | undefined): string | undefined {
  return value === undefined ? undefined : claudeSessionArg('--resume', value);
}

/** A Claude Code session id an argument names, checked so nothing but an id reaches Claude Code. */
export function claudeSessionArg(name: string, value: string): string {
  if (!CLAUDE_SESSION_ID.test(value)) {
    throw new UsageError(`${name} "${value}" is not a Claude Code session id`);
  }
  return value;
}

/** The effort `--effort` names, checked against Claude Code's levels. */
export function effortFlag(value: string | undefined): EffortLevel | undefined {
  if (value !== undefined && !isEffortLevel(value)) {
    throw new UsageError(`--effort "${value}" is not an effort level`);
  }
  return value;
}

/** Whether the automatic restart ended this session's Claude Code for launch to start again; takes its request if so. */
async function restartTaken(store: RefreshStore, id: string): Promise<boolean> {
  const request = await store.restart(id);
  if (request?.phase !== 'ending' || !request.supervised) {
    return false;
  }
  await store.clearRestart(id);
  return true;
}

/** How to start Claude Code in `env`; refused when it is not on that PATH. */
export async function claudeProgramOf(runtime: CliRuntime, env: Env): Promise<ClaudeProgram> {
  const claude = await findClaude({ env, platform: runtime.platform, probe: runtime.probe, files: runtime.files, node: runtime.self.node });
  if (claude.kind === 'missing') {
    const skipped = claude.skipped.length === 0 ? '' : ` (skipped: ${claude.skipped.join('; ')})`;
    throw new RefusedError(`Claude Code (claude) is not on PATH${skipped}; install it, then run this again`);
  }
  return claude.program;
}

/** The exit for how Claude Code ended, for a command that ran it on this terminal. */
export function claudeExit(runtime: CliRuntime, command: string, result: RunOutcome): ExitCode {
  switch (result.kind) {
    case 'exited':
      if (result.code === 0) {
        return EXIT.ok;
      }
      runtime.out.stderr(`FAILED Claude Code exited with code ${result.code}`);
      return EXIT.failed;
    case 'missing':
      runtime.out.stderr(`FAILED ${command} is gone`);
      return EXIT.failed;
    case 'failed':
      runtime.out.stderr(`FAILED ${command}: ${result.error}`);
      return EXIT.failed;
  }
}

/**
 * `launch <id> --team <team> --project <dir> [--home <dir>] [--encoded-prompt <text> | --no-prompt] [--resume <session>] [--effort <level>]`:
 * what a tab that `open` started runs. It sets the session's variables and starts Claude Code under the
 * session's name, on its model and effort from the team config's `launch`, with its first prompt,
 * its input and output on this terminal. `$TEAMRIG_LAUNCHED` tells the Stop hook that launch runs it:
 * when the automatic context refresh ended Claude Code for a fresh start, launch starts it again in
 * this tab with the default prompt, and the new session reads its handover first. `--resume` resumes that
 * Claude Code session on the first start only: a restart is always fresh. `--effort` overrides the configured
 * effort and `--no-prompt` starts with no first prompt, as the restore after a reboot reopens an idle session.
 */
export async function launch(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  const id = idFlag('session', onePositional(args, 'id'));
  const team = idFlag('--team', requiredFlag(args.flags, 'team'));
  const project = requiredFlag(args.flags, 'project');
  if ((await runtime.probe.kind(project)) !== 'folder') {
    throw new RefusedError(`the project folder ${project} does not exist`);
  }
  const prompt = launchPrompt(args, team, id);
  const resume = resumeFlag(args.flags.get('resume'));
  const effort = effortFlag(args.flags.get('effort'));
  const env = { ...sessionEnv(runtime.env, { id, team, home: args.flags.get('home') }, runtime.platform), [ENV.launched]: id };
  const sessionRuntime: CliRuntime = { ...runtime, env };
  const kit = await openKit(sessionRuntime, team);
  const config = requireConfig(kit, sessionRuntime, 'read');
  const roster = await rosterOf(sessionRuntime, kit, config);
  if (!roster.ids.includes(id)) {
    throw new RefusedError(`${id} is not a session of team ${team}`);
  }
  const { command, prefix } = await claudeProgramOf(runtime, env);
  const name = roster.nameOf(id) ?? id;
  const settings = effort === undefined ? launchOf(config, id) : { ...launchOf(config, id), effort };
  const resumed = resume === undefined ? '' : `, resuming Claude Code session ${resume}`;
  runtime.out.stdout(`Starting Claude Code as ${name} (session ${id} of team ${team}) in ${project}, on ${describeLaunch(settings)}${resumed}`);
  const store = new RefreshStore(runtime.files, kit.paths);
  let first: string | undefined = prompt;
  let resuming = resume;
  for (;;) {
    const resumeArgs = resuming === undefined ? [] : ['--resume', resuming];
    const result = await runtime.processes.run({ command, args: [...prefix, ...launchFlags(settings), ...resumeArgs, '--name', name, ...(first === undefined ? [] : [first])], cwd: project, env });
    if (!(await restartTaken(store, id))) {
      return claudeExit(runtime, command, result);
    }
    runtime.out.stdout(`Starting Claude Code again as ${name} with a fresh context: it reads its handover first`);
    first = refreshPrompt(team, id, store.handoverPath(id));
    resuming = undefined;
  }
}
