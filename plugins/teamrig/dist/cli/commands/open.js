import { dirname, resolve } from 'node:path';
import { describeLaunch, launchOf } from "../../config/launch.js";
import { isTerminalChoice, TERMINALS } from "../../config/types.js";
import { splitAddress } from "../../core/address.js";
import { ENV } from "../../core/home.js";
import { ID_PATTERN, ID_RULE } from "../../core/ids.js";
import { ENV_SOURCE } from "../../core/team.js";
import { findClaude } from "../../open/claude.js";
import { launchFlags } from "../../open/launch-flags.js";
import { openTab } from "../../open/open-tab.js";
import { decodePrompt, defaultPrompt, encodePrompt, promptProblem, refreshPrompt } from "../../open/prompt.js";
import { shellCommand } from "../../open/quote.js";
import { sessionEnv } from "../../open/session-env.js";
import { RefreshStore } from "../../refresh/store.js";
import { onePositional, requiredFlag, UsageError } from "../args.js";
import { findTeam, openKit, requireConfig, rosterOf, sessionIdOf } from "../kit.js";
import { EXIT, RefusedError } from "../runtime.js";
import { loadTree } from "../tree.js";
import { projectOf } from "./setup.js";
/** The terminal names a person reads, for the OPENED line. */
const TERMINAL_LABELS = {
    tmux: 'tmux window',
    'windows-terminal': 'Windows Terminal tab',
    'macos-terminal': 'Terminal window',
    'gnome-terminal': 'GNOME Terminal tab',
    konsole: 'Konsole tab',
    'x-terminal-emulator': 'terminal window',
};
function terminalOf(flag, configured) {
    if (flag === undefined) {
        return configured;
    }
    if (!isTerminalChoice(flag)) {
        throw new UsageError(`--terminal "${flag}" is not one of ${TERMINALS.join(', ')}`);
    }
    return flag;
}
function checkedPrompt(prompt) {
    const problem = promptProblem(prompt);
    if (problem !== undefined) {
        throw new UsageError(`--prompt: ${problem}`);
    }
    return prompt;
}
/** The folder a session opens in: `--project`, else the folder holding the team's pointer. */
function projectFlagOf(flag, from) {
    return flag ?? (from === ENV_SOURCE ? undefined : dirname(from));
}
/**
 * The team a session to open is on: the project's own team, or, for `<team>/<id>`, another team of
 * the same tree, whose sessions share the project folder and get their team from `$TEAMRIG_TEAM`.
 */
async function openTeamOf(runtime, own, named) {
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
 * Opens a terminal tab titled with the session's name that runs `launch` for it, by absolute paths,
 * since the plugin's bin folder is on PATH only inside Claude Code: `open` and the automatic restart.
 */
export async function openSessionTab(runtime, tab) {
    const customHome = runtime.env[ENV.home]?.trim();
    const argv = [
        runtime.self.node,
        runtime.self.script,
        'launch',
        tab.id,
        '--team',
        tab.team,
        '--project',
        tab.project,
        ...(customHome === undefined || customHome === '' ? [] : ['--home', resolve(runtime.cwd, customHome)]),
        '--encoded-prompt',
        encodePrompt(tab.prompt),
    ];
    return { outcome: await openTab(runtime, tab.terminal, { title: tab.name, folder: tab.project, argv }), argv };
}
/**
 * `open <id|name> [--prompt <text>] [--terminal <name>] [--project <dir>]`: a new terminal tab in the
 * project folder that runs `launch`, so Claude Code starts there as the session. The command runs by
 * absolute paths, since the plugin's bin folder is on PATH only inside Claude Code. When no terminal
 * opens it prints the command to run instead and exits 3.
 */
export async function open(args, runtime) {
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
    const name = roster.nameOf(id) ?? id;
    const { outcome, argv } = await openSessionTab(runtime, { team, id, name, project, prompt, terminal });
    if (outcome.kind === 'opened') {
        runtime.out.stdout(`OPENED ${name} (session ${id}) in a new ${TERMINAL_LABELS[outcome.terminal]} in ${project}, on ${describeLaunch(launchOf(config, id))}`);
        return EXIT.ok;
    }
    const shell = runtime.platform === 'win32' ? ' in PowerShell' : '';
    runtime.out.stdout(`MANUAL no terminal opened (${outcome.reasons.join('; ')}); open a new terminal and run this${shell}:`);
    runtime.out.stdout(shellCommand(runtime.platform, project, argv));
    return EXIT.printed;
}
export function idFlag(flag, value) {
    if (!ID_PATTERN.test(value)) {
        throw new UsageError(`${flag} "${value}" is not an id (${ID_RULE})`);
    }
    return value;
}
function launchPrompt(encoded, team, id) {
    if (encoded === undefined) {
        return defaultPrompt(team, id);
    }
    const prompt = decodePrompt(encoded);
    if (prompt === undefined) {
        throw new UsageError('--encoded-prompt is not a prompt that teamrig open wrote');
    }
    return checkedPrompt(prompt);
}
/** Whether the automatic restart ended this session's Claude Code for launch to start again; takes its request if so. */
async function restartTaken(store, id) {
    const request = await store.restart(id);
    if (request?.phase !== 'ending' || !request.supervised) {
        return false;
    }
    await store.clearRestart(id);
    return true;
}
/** Launch's exit for how Claude Code ended. */
function claudeExit(runtime, command, result) {
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
 * `launch <id> --team <team> --project <dir> [--home <dir>] [--encoded-prompt <text>]`: what a tab
 * that `open` started runs. It sets the session's variables and starts Claude Code under the
 * session's name, on its model and effort from the team config's `launch`, with its first prompt,
 * its input and output on this terminal. `$TEAMRIG_LAUNCHED` tells the Stop hook that launch runs it:
 * when the automatic context refresh ended Claude Code for a fresh start, launch starts it again in
 * this tab with the default prompt, and the new session reads its handover first.
 */
export async function launch(args, runtime) {
    const id = idFlag('session', onePositional(args, 'id'));
    const team = idFlag('--team', requiredFlag(args.flags, 'team'));
    const project = requiredFlag(args.flags, 'project');
    if ((await runtime.probe.kind(project)) !== 'folder') {
        throw new RefusedError(`the project folder ${project} does not exist`);
    }
    const prompt = launchPrompt(args.flags.get('encoded-prompt'), team, id);
    const env = { ...sessionEnv(runtime.env, { id, team, home: args.flags.get('home') }), [ENV.launched]: id };
    const sessionRuntime = { ...runtime, env };
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
    const store = new RefreshStore(runtime.files, kit.paths);
    let first = prompt;
    for (;;) {
        const result = await runtime.processes.run({ command, args: [...prefix, ...launchFlags(settings), '--name', name, first], cwd: project, env });
        if (!(await restartTaken(store, id))) {
            return claudeExit(runtime, command, result);
        }
        runtime.out.stdout(`Starting Claude Code again as ${name} with a fresh context: it reads its handover first`);
        first = refreshPrompt(team, id, store.handoverPath(id));
    }
}
