import { join, resolve } from 'node:path';
import { claudeProjectsDir } from '../../budget/discover.ts';
import type { TerminalChoice } from '../../config/types.ts';
import { errorMessage } from '../../core/guards.ts';
import { ENV, resolveKitHome } from '../../core/home.ts';
import { PlainLogFile } from '../../core/log-file.ts';
import { indexMarks } from '../../inbox/marks.ts';
import { JsonlMarkLog } from '../../inbox/store.ts';
import { openTab, type OpenOutcome } from '../../open/open-tab.ts';
import { teamWindowOf } from '../../open/terminals.ts';
import { encodePrompt } from '../../open/prompt.ts';
import { shellCommand } from '../../open/quote.ts';
import { plainSessionEnv } from '../../open/session-env.ts';
import { runsClaude } from '../../open/session-processes.ts';
import { RestoreArchive, restoreArchiveDir } from '../../restore/archive.ts';
import { RestoreRegistry, restoreSessionsDir } from '../../restore/registry.ts';
import { checkRestore, previewRestore, runRestore, type ReopenOutcome, type ReopenTab, type RestoreDeps, type RestoreRun } from '../../restore/run.ts';
import type { RestoreTeam } from '../../restore/teams.ts';
import { TranscriptFinder } from '../../restore/transcripts.ts';
import { onePositional, requiredFlag, UsageError, type ParsedArgs } from '../args.ts';
import { EXIT, RefusedError, type CliRuntime, type ExitCode } from '../runtime.ts';
import { loadTree } from '../tree.ts';
import { claudeExit, claudeProgramOf, claudeSessionArg, effortFlag, encodedPromptFlag, homeArgs, openSessionTab, TERMINAL_LABELS, terminalFlag } from './open.ts';

/** The title of the tab `restore check` opens for the restore. */
export const RESTORE_TAB_TITLE = 'Restore Claude sessions';
/** How long the restore's own tab stays once it reopened every session: the last one starts meanwhile. */
export const TAB_SETTLE_MS = 2_000;
/** How long the restore's own tab stays when it reopened nothing or something failed, so its lines can be read. */
export const TAB_CLOSE_DELAY_MS = 8_000;

/** The restore's log, beside its sessions folder: what each check and run decided, for the morning after. */
export function restoreLogPath(kitHome: string): string {
  return join(kitHome, 'restore', 'restore.log');
}

/** The runtime on the kit home `--home` names, which a new tab's own environment may not carry. */
function homeRuntimeOf(args: ParsedArgs, runtime: CliRuntime): CliRuntime {
  const home = args.flags.get('home');
  return home === undefined ? runtime : { ...runtime, env: { ...runtime.env, [ENV.home]: resolve(runtime.cwd, home) } };
}

/** Every team of the kit home as the restore sees it; a team whose config does not load is left out. */
async function restoreTeamsOf(runtime: CliRuntime): Promise<RestoreTeam[]> {
  const { teams } = await loadTree(runtime);
  const found: RestoreTeam[] = [];
  for (const [team, { kit, config, roster }] of teams) {
    const { marks } = await new JsonlMarkLog(new PlainLogFile(runtime.files, kit.paths.inboxMarks)).read();
    found.push({
      team,
      lead: config.roles.lead,
      names: new Map(roster.ids.map((id) => [id, roster.nameOf(id) ?? id])),
      terminal: config.open.terminal,
      teamWindow: config.open.teamWindow,
      areaBySession: indexMarks(marks).areaBySession,
    });
  }
  return found;
}

function reopenOutcomeOf(runtime: CliRuntime, outcome: OpenOutcome, folder: string, argv: readonly string[]): ReopenOutcome {
  if (outcome.kind === 'opened') {
    return { kind: 'opened' };
  }
  return { kind: 'failed', why: `no terminal opened (${outcome.reasons.join('; ')}); run: ${shellCommand(runtime.platform, folder, argv)}` };
}

/**
 * Opens the tab of one restored session. A session `launch` ran comes back through `launch` again, as its team
 * session, on its effort; any other resumes through `restore resume`, outside any team, as it ran before.
 */
async function reopen(runtime: CliRuntime, tab: ReopenTab, terminal: TerminalChoice | undefined): Promise<ReopenOutcome> {
  const { team } = tab;
  if (team?.launched === true) {
    const { outcome, argv } = await openSessionTab(runtime, {
      team: team.team,
      id: team.session,
      name: team.name,
      project: tab.folder,
      prompt: tab.prompt,
      terminal: terminal ?? team.terminal,
      teamWindow: team.teamWindow,
      resume: tab.claudeSession,
      ...(tab.effort === undefined ? {} : { effort: tab.effort }),
    });
    return reopenOutcomeOf(runtime, outcome, tab.folder, argv);
  }
  const argv = [
    runtime.self.node,
    runtime.self.script,
    'restore',
    'resume',
    tab.claudeSession,
    '--project',
    tab.folder,
    ...homeArgs(runtime),
    ...(tab.effort === undefined ? [] : ['--effort', tab.effort]),
    ...(tab.prompt === undefined ? [] : ['--encoded-prompt', encodePrompt(tab.prompt)]),
  ];
  const window = team === undefined ? undefined : teamWindowOf(team.teamWindow, team.team);
  const outcome = await openTab(runtime, terminal ?? team?.terminal ?? 'auto', { title: tab.title, folder: tab.folder, argv, window });
  return reopenOutcomeOf(runtime, outcome, tab.folder, argv);
}

/** The restore over this machine: the kit home's sessions folder, every team on it, its processes and terminals. */
async function restoreDepsOf(runtime: CliRuntime, terminal: TerminalChoice | undefined): Promise<RestoreDeps> {
  const kitHome = resolveKitHome(runtime.env, runtime.userHome);
  const projectsDir = claudeProjectsDir(runtime.env, runtime.userHome);
  const finder = new TranscriptFinder(runtime.files, runtime.probe, projectsDir);
  const logPath = restoreLogPath(kitHome);
  return {
    registry: new RestoreRegistry(runtime.files, restoreSessionsDir(kitHome)),
    archive: new RestoreArchive(runtime.files, restoreArchiveDir(kitHome)),
    clock: runtime.clock,
    sleep: runtime.sleep,
    probe: runtime.probe,
    shutdowns: runtime.restore.shutdowns,
    countdown: runtime.restore.countdown,
    stops: runtime.restore.stops,
    teams: await restoreTeamsOf(runtime),
    home: runtime.userHome,
    projectsDir,
    platform: runtime.platform,
    stillRunning: (entry) => runsClaude(runtime.sessionProcesses, entry.pid),
    transcriptOf: (entry) => finder.find(entry),
    readTail: (path, maxBytes) => runtime.files.readTail(path, maxBytes),
    reopen: (tab) => reopen(runtime, tab, terminal),
    print: (line) => runtime.out.stdout(line),
    log: async (line) => {
      try {
        await runtime.files.append(logPath, `${new Date(runtime.clock.now()).toISOString()} ${line}\n`);
      } catch (error) {
        runtime.out.stderr(`WARN could not write the restore log ${logPath}: ${errorMessage(error)}`);
      }
    },
  };
}

/** `restore`: what a restore now would do with each recorded Claude Code session, changing nothing. */
export async function restorePreview(_args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  await previewRestore(await restoreDepsOf(runtime, undefined));
  return EXIT.ok;
}

/**
 * `restore check [--terminal <name>] [--home <dir>]`, at logon: drops the recorded sessions no restore needs and,
 * when the last shutdown killed some, opens a tab that runs `restore run` for them, so the person sees the list
 * and the countdown. When no terminal opens it prints the command to run instead and exits 3.
 */
export async function restoreCheck(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  const terminal = terminalFlag(args.flags.get('terminal'));
  const homeRuntime = homeRuntimeOf(args, runtime);
  const { since, count } = await checkRestore(await restoreDepsOf(homeRuntime, terminal));
  if (count === 0) {
    runtime.out.stdout('No Claude Code sessions to restore.');
    return EXIT.ok;
  }
  const argv = [
    runtime.self.node,
    runtime.self.script,
    'restore',
    'run',
    '--since',
    new Date(since).toISOString(),
    '--tab',
    ...(terminal === undefined ? [] : ['--terminal', terminal]),
    ...homeArgs(homeRuntime),
  ];
  const outcome = await openTab(runtime, terminal ?? 'auto', { title: RESTORE_TAB_TITLE, folder: runtime.userHome, argv, window: undefined });
  if (outcome.kind === 'opened') {
    runtime.out.stdout(`OPENED the restore of ${count} Claude Code session${count === 1 ? '' : 's'} in a new ${TERMINAL_LABELS[outcome.terminal]}`);
    return EXIT.ok;
  }
  const shell = runtime.platform === 'win32' ? ' in PowerShell' : '';
  runtime.out.stdout(`MANUAL no terminal opened (${outcome.reasons.join('; ')}); open a new terminal and run this${shell}:`);
  runtime.out.stdout(shellCommand(runtime.platform, runtime.userHome, argv));
  return EXIT.printed;
}

/** The logon time `--since` names; sessions active after it were reopened by hand and are left alone. */
function sinceFlag(value: string | undefined, now: number): number {
  if (value === undefined) {
    return now;
  }
  const since = Date.parse(value);
  if (Number.isNaN(since)) {
    throw new UsageError(`--since "${value}" is not a time`);
  }
  return since;
}

/**
 * `restore run [--since <time>] [--terminal <name>] [--home <dir>] [--tab]`: reopens the Claude Code sessions the
 * last shutdown killed, after a countdown. `--tab` is for the tab `restore check` opened: it stays a moment once
 * every session is open, and longer when nothing opened or something failed, so its lines can be read.
 */
export async function restoreRun(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  const terminal = terminalFlag(args.flags.get('terminal'));
  const since = sinceFlag(args.flags.get('since'), runtime.clock.now());
  const deps = await restoreDepsOf(homeRuntimeOf(args, runtime), terminal);
  const run = args.switches.has('tab') ? await runInTab(runtime, deps, since) : await runRestore(deps, since);
  return run.failed === 0 ? EXIT.ok : EXIT.failed;
}

/** The run in the restore's own tab: a stop is printed there rather than lost with the tab, which stays to be read. */
async function runInTab(runtime: CliRuntime, deps: RestoreDeps, since: number): Promise<RestoreRun> {
  let run: RestoreRun;
  try {
    run = await runRestore(deps, since);
  } catch (error) {
    runtime.out.stdout(`FAILED the restore stopped: ${errorMessage(error)}`);
    await deps.log(`run: stopped (${errorMessage(error)})`);
    run = { opened: 0, failed: 1 };
  }
  if (run.opened > 0 && run.failed === 0) {
    await runtime.sleep(TAB_SETTLE_MS);
  } else {
    runtime.out.stdout(`This tab closes in ${TAB_CLOSE_DELAY_MS / 1_000} s.`);
    await runtime.sleep(TAB_CLOSE_DELAY_MS);
  }
  return run;
}

/**
 * `restore resume <claude-session> --project <dir> [--home <dir>] [--effort <level>] [--encoded-prompt <text>]`: what
 * the tab of a restored session outside any team runs. It resumes that Claude Code session in its folder, at its
 * last effort, with the restore's prompt or none, its input and output on this terminal, and none of the opener's
 * session variables, so it comes back as it ran before.
 */
export async function restoreResume(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  const claudeSession = claudeSessionArg('claude-session', onePositional(args, 'claude-session'));
  const project = requiredFlag(args.flags, 'project');
  if ((await runtime.probe.kind(project)) !== 'folder') {
    throw new RefusedError(`the project folder ${project} does not exist`);
  }
  const effort = effortFlag(args.flags.get('effort'));
  const encoded = args.flags.get('encoded-prompt');
  const prompt = encoded === undefined ? undefined : encodedPromptFlag(encoded);
  const env = plainSessionEnv(runtime.env, args.flags.get('home'), runtime.platform);
  const { command, prefix } = await claudeProgramOf(runtime, env);
  runtime.out.stdout(`Resuming Claude Code session ${claudeSession} in ${project}${effort === undefined ? '' : ` at ${effort} effort`}`);
  const claudeArgs = [...prefix, '--resume', claudeSession, ...(effort === undefined ? [] : ['--effort', effort]), ...(prompt === undefined ? [] : [prompt])];
  return claudeExit(runtime, command, await runtime.processes.run({ command, args: claudeArgs, cwd: project, env }));
}
