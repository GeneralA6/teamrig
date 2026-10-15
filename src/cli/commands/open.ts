import { dirname, resolve } from 'node:path';
import { describeLaunch, launchOf } from '../../config/launch.ts';
import { isTerminalChoice, TERMINALS, type TerminalChoice } from '../../config/types.ts';
import { splitAddress } from '../../core/address.ts';
import { ENV } from '../../core/home.ts';
import { ID_PATTERN, ID_RULE } from '../../core/ids.ts';
import { ENV_SOURCE } from '../../core/team.ts';
import { findClaude } from '../../open/claude.ts';
import { launchFlags } from '../../open/launch-flags.ts';
import { openTab } from '../../open/open-tab.ts';
import { decodePrompt, defaultPrompt, encodePrompt, promptProblem } from '../../open/prompt.ts';
import { shellCommand } from '../../open/quote.ts';
import { sessionEnv } from '../../open/session-env.ts';
import type { Terminal } from '../../open/terminals.ts';
import { onePositional, requiredFlag, UsageError, type ParsedArgs } from '../args.ts';
import { findTeam, openKit, requireConfig, rosterOf, sessionIdOf } from '../kit.ts';
import { EXIT, RefusedError, type CliRuntime, type ExitCode } from '../runtime.ts';
import { loadTree } from '../tree.ts';
import { projectOf } from './setup.ts';

/** The terminal names a person reads, for the OPENED line. */
const TERMINAL_LABELS: Readonly<Record<Terminal, string>> = {
  tmux: 'tmux window',
  'windows-terminal': 'Windows Terminal tab',
  'macos-terminal': 'Terminal window',
  'gnome-terminal': 'GNOME Terminal tab',
  konsole: 'Konsole tab',
  'x-terminal-emulator': 'terminal window',
};

function terminalOf(flag: string | undefined, configured: TerminalChoice): TerminalChoice {
  if (flag === undefined) {
    return configured;
  }
  if (!isTerminalChoice(flag)) {
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

/** The folder a session opens in: `--project`, else the folder holding the team's pointer. */
function projectFlagOf(flag: string | undefined, from: string): string | undefined {
  return flag ?? (from === ENV_SOURCE ? undefined : dirname(from));
}

/**
 * `open <id|name> [--prompt <text>] [--terminal <name>] [--project <dir>]`: a new terminal tab in the
 * project folder that runs `launch`, so Claude Code starts there as the session. The command runs by
 * absolute paths, since the plugin's bin folder is on PATH only inside Claude Code. When no terminal
 * opens it prints the command to run instead and exits 3.
 */
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

export async function open(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  const target = onePositional(args, 'id|name');
  const address = splitAddress(target);
  const found = await findTeam(runtime);
  const team = await openTeamOf(runtime, found.team, address?.team);
  const kit = await openKit(runtime, team);
  const config = requireConfig(kit, runtime, 'read');
  const roster = await rosterOf(runtime, kit, config);
  const id = sessionIdOf(roster, address?.session ?? target);
  const terminal = terminalOf(args.flags.get('terminal'), config.open.terminal);
  const prompt = checkedPrompt(args.flags.get('prompt') ?? defaultPrompt(team, id));
  const project = await projectOf(runtime, projectFlagOf(args.flags.get('project'), found.from));
  const customHome = runtime.env[ENV.home]?.trim();
  const argv = [
    runtime.self.node,
    runtime.self.script,
    'launch',
    id,
    '--team',
    team,
    '--project',
    project,
    ...(customHome === undefined || customHome === '' ? [] : ['--home', resolve(runtime.cwd, customHome)]),
    '--encoded-prompt',
    encodePrompt(prompt),
  ];
  const name = roster.nameOf(id) ?? id;
  const outcome = await openTab(runtime, terminal, { title: name, folder: project, argv });
  if (outcome.kind === 'opened') {
    runtime.out.stdout(`OPENED ${name} (session ${id}) in a new ${TERMINAL_LABELS[outcome.terminal]} in ${project}, on ${describeLaunch(launchOf(config, id))}`);
    return EXIT.ok;
  }
  const shell = runtime.platform === 'win32' ? ' in PowerShell' : '';
  runtime.out.stdout(`MANUAL no terminal opened (${outcome.reasons.join('; ')}); open a new terminal and run this${shell}:`);
  runtime.out.stdout(shellCommand(runtime.platform, project, argv));
  return EXIT.printed;
}

function idFlag(flag: string, value: string): string {
  if (!ID_PATTERN.test(value)) {
    throw new UsageError(`${flag} "${value}" is not an id (${ID_RULE})`);
  }
  return value;
}

function launchPrompt(encoded: string | undefined, team: string, id: string): string {
  if (encoded === undefined) {
    return defaultPrompt(team, id);
  }
  const prompt = decodePrompt(encoded);
  if (prompt === undefined) {
    throw new UsageError('--encoded-prompt is not a prompt that teamrig open wrote');
  }
  return checkedPrompt(prompt);
}

/**
 * `launch <id> --team <team> --project <dir> [--home <dir>] [--encoded-prompt <text>]`: what a tab
 * that `open` started runs. It sets the session's variables and starts Claude Code under the
 * session's name, on its model and effort from the team config's `launch`, with its first prompt,
 * its input and output on this terminal.
 */
export async function launch(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  const id = idFlag('session', onePositional(args, 'id'));
  const team = idFlag('--team', requiredFlag(args.flags, 'team'));
  const project = requiredFlag(args.flags, 'project');
  if ((await runtime.probe.kind(project)) !== 'folder') {
    throw new RefusedError(`the project folder ${project} does not exist`);
  }
  const prompt = launchPrompt(args.flags.get('encoded-prompt'), team, id);
  const env = sessionEnv(runtime.env, { id, team, home: args.flags.get('home') });
  const sessionRuntime: CliRuntime = { ...runtime, env };
  const kit = await openKit(sessionRuntime, team);
  const config = requireConfig(kit, sessionRuntime, 'read');
  const roster = await rosterOf(sessionRuntime, kit, config);
  if (!roster.ids.includes(id)) {
    throw new RefusedError(`${id} is not a session of team ${team}`);
  }
  const claude = await findClaude({ env, platform: runtime.platform, probe: runtime.probe, files: runtime.files, node: runtime.self.node });
  if (claude.kind === 'missing') {
    const skipped = claude.skipped.length === 0 ? '' : ` (skipped: ${claude.skipped.join('; ')})`;
    throw new RefusedError(`Claude Code (claude) is not on PATH${skipped}; install it, then run this again`);
  }
  const name = roster.nameOf(id) ?? id;
  const settings = launchOf(config, id);
  runtime.out.stdout(`Starting Claude Code as ${name} (session ${id} of team ${team}) in ${project}, on ${describeLaunch(settings)}`);
  const { command, prefix } = claude.program;
  const result = await runtime.processes.run({ command, args: [...prefix, ...launchFlags(settings), '--name', name, prompt], cwd: project, env });
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
