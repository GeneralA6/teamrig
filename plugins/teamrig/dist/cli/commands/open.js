import { resolve } from 'node:path';
import { describeLaunch, launchOf } from "../../config/launch.js";
import { isEffortLevel, isTerminalChoice, TERMINALS } from "../../config/types.js";
import { splitAddress } from "../../core/address.js";
import { ENV, KIT_NAME } from "../../core/home.js";
import { ID_PATTERN, ID_RULE, sessionDisplay } from "../../core/ids.js";
import { samePath } from "../../core/paths.js";
import { HiringLog } from "../../hiring/log.js";
import { rehiredFrom } from "../../hiring/record.js";
import { CLAUDE_SESSION_ID } from "../../inbox/marks.js";
import { findClaude } from "../../open/claude.js";
import { launchFlags } from "../../open/launch-flags.js";
import { openTab } from "../../open/open-tab.js";
import { decodePrompt, defaultPrompt, encodePrompt, PROMPT_MAX, promptProblem, refreshPrompt, rehirePrompt, reopenPrompt, resumePrompt } from "../../open/prompt.js";
import { shellCommand } from "../../open/quote.js";
import { sessionEnv } from "../../open/session-env.js";
import { RefreshStore } from "../../refresh/store.js";
import { noRoomText } from "../../sessions/headroom.js";
import { closedOf, SessionLog } from "../../sessions/log.js";
import { teamWindowOf } from "../../open/terminals.js";
import { urgentFirstPrompt } from "../../wake/asks.js";
import { onePositional, requiredFlag, UsageError } from "../args.js";
import { headroomOf } from "../headroom.js";
import { findTeam, openKit, requireConfig, rosterOf, sessionIdOf, teamZone } from "../kit.js";
import { liveRunOf, liveRunText } from "../live-run.js";
import { EXIT, RefusedError } from "../runtime.js";
import { launchListing } from "../skill-listing.js";
import { loadTree } from "../tree.js";
import { noteResumedTab } from "../wake-opened.js";
import { claudeSessionVerdict, freshOpenOf, resumeVerdictOf } from "./rehire.js";
import { sessionProjectOf } from "./setup.js";
/** The terminal names a person reads, for the OPENED line. */
export const TERMINAL_LABELS = {
    tmux: 'tmux window',
    'windows-terminal': 'Windows Terminal tab',
    'macos-terminal': 'Terminal window',
    'gnome-terminal': 'GNOME Terminal tab',
    konsole: 'Konsole tab',
    'x-terminal-emulator': 'terminal window',
};
/** The terminal `--terminal` names; undefined when it names none. */
export function terminalFlag(flag) {
    if (flag !== undefined && !isTerminalChoice(flag)) {
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
 * `--home <dir>` for a command a new tab runs, when this one runs on a kit home other than the default:
 * the tab's own environment may not carry `$TEAMRIG_HOME` (a Windows Terminal tab gets the terminal's).
 */
export function homeArgs(runtime) {
    const customHome = runtime.env[ENV.home]?.trim();
    return customHome === undefined || customHome === '' ? [] : ['--home', resolve(runtime.cwd, customHome)];
}
/**
 * Opens a terminal tab titled with the session's name that runs `launch` for it, by absolute paths,
 * since the plugin's bin folder is on PATH only inside Claude Code: `open` and the automatic restart.
 */
export async function openSessionTab(runtime, tab) {
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
    const window = teamWindowOf(tab.teamWindow, tab.team);
    return { outcome: await openTab(runtime, tab.terminal, { title: sessionDisplay(tab.team, tab.name), folder: tab.project, argv, window }), argv };
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
export async function open(args, runtime) {
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
    return printOpenResult(runtime, opened);
}
/** Prints what an open did: its OPENED line, or, when no terminal opened, why and the command to run in its folder (exit 3). */
export function printOpenResult(runtime, opened) {
    if (opened.kind === 'opened') {
        runtime.out.stdout(opened.line);
        return EXIT.ok;
    }
    const shell = runtime.platform === 'win32' ? ' in PowerShell' : '';
    runtime.out.stdout(`MANUAL no terminal opened (${opened.reasons.join('; ')}); open a new terminal and run this${shell}:`);
    runtime.out.stdout(shellCommand(runtime.platform, opened.folder, opened.argv));
    return EXIT.printed;
}
/**
 * Opens the session's tab as `open` describes: a rehired one on its handover, a closed one in its last Claude Code
 * session or fresh (always fresh with `fresh`), refused (`RefusedError`) while it runs in a Claude Code and, for any
 * session but the lead, when the host has no room, and a closed one's reopen logged once its tab opened. A home close
 * (a hire that never ran, T1364) opens as a new hire does, its reopen logged too.
 */
export async function openSession(runtime, kit, config, roster, request) {
    const { team, id, project, terminal, asked } = request;
    const name = roster.nameOf(id) ?? id;
    await refuseLiveRun(runtime, kit, roster, id, name);
    const from = rehiredFrom((await new HiringLog(runtime.files, kit.paths.hires).read()).records, id);
    const sessionLog = new SessionLog(runtime.files, kit.paths.sessionLog);
    const closed = closedOf((await sessionLog.read()).records, id);
    const fresh = request.fresh === true;
    const closedIn = closed?.claudeSession === undefined || fresh ? undefined : await reopenOf(runtime, config, closed, project);
    const reopen = closedIn?.verdict;
    // A closed session opened fresh still logs its reopen below, so the idle pass knows it runs again.
    const resume = fresh ? undefined : await resumeOf(runtime, kit.paths, config, { id, project, from, reopen, asked });
    // Claude Code finds a session to resume only in the folder it ran in (T1408); a new one starts in the project.
    const folder = resume === undefined ? project : (closedIn?.folder ?? project);
    const own = request.prompt ?? firstPromptOf(team, id, from, resume, reopen);
    const prompt = checkedPrompt(urgentFirstPrompt(request.urgent ?? [], own, teamZone(config, runtime), PROMPT_MAX));
    // The lead opens whatever the room: it is the session that decides which others run.
    if (id !== roster.holderOf('lead')) {
        const headroom = await headroomOf(runtime, kit.paths, config, roster.ids);
        if (headroom.short.length > 0) {
            throw new RefusedError(noRoomText(`open ${name} (session ${id})`, headroom));
        }
    }
    const { outcome, argv } = await openSessionTab(runtime, { team, id, name, project: folder, prompt, terminal, teamWindow: config.open.teamWindow, ...(resume === undefined ? {} : { resume }) });
    if (outcome.kind !== 'opened') {
        return { kind: 'manual', reasons: outcome.reasons, argv, folder };
    }
    if (closed !== undefined) {
        await sessionLog.append({ kind: 'reopen', session: id, at: new Date(runtime.clock.now()).toISOString(), ...(resume === undefined ? {} : { resumed: resume }) });
    }
    // teamrig's own first prompt has a resumed session read its list; a --prompt one may not, so its wake check decides.
    const unnoted = resume !== undefined && request.prompt === undefined ? await noteResumedTab(runtime, kit, config, id, resume) : undefined;
    const wakeNote = unnoted === undefined ? '' : `; its wake state was not written, so its tab may wake once more for work it reads now: ${unnoted}`;
    return { kind: 'opened', line: `OPENED ${name} (session ${id}) in a new ${TERMINAL_LABELS[outcome.terminal]} in ${folder}, on ${describeLaunch(launchOf(config, id))}${startNoteOf(resume, reopen)}${wakeNote}` };
}
/**
 * A closed session's reopen. It resumes in the folder its close recorded, which holds its transcript (T1408), or the
 * project for a close that recorded none; a recorded folder since removed (a worktree) opens it fresh in the project.
 */
async function reopenOf(runtime, config, closed, project) {
    const folder = closed.folder ?? project;
    if (!samePath(folder, project, runtime.platform) && (await runtime.probe.kind(folder)) !== 'folder') {
        return { verdict: { kind: 'fresh', detail: `${folder}, the folder it ran in, is gone` }, folder: project };
    }
    return { verdict: await claudeSessionVerdict(runtime, config.hiring, closed.claudeSession, folder), folder };
}
/** Refuses a second Claude Code of session `id`, named `name`, while it runs in one (src/cli/live-run.ts). */
async function refuseLiveRun(runtime, kit, roster, id, name) {
    const live = await liveRunOf(runtime, kit.paths, roster.ids, id);
    if (live !== undefined) {
        throw new RefusedError(liveRunText(name, id, live));
    }
}
/**
 * The Claude Code session the tab resumes, undefined for a new one. A closed session resumes its last one when that
 * is small and recent enough, else opens fresh (and `--resume` refuses); any other resumes only with `--resume`, and
 * only a rehired session's.
 */
async function resumeOf(runtime, paths, config, facts) {
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
function startNoteOf(resume, reopen) {
    if (resume !== undefined) {
        return `, resuming Claude Code session ${resume}`;
    }
    return reopen?.kind === 'fresh' ? `, fresh (${reopen.detail})` : '';
}
/**
 * The first prompt unless --prompt gives one: a reopened or resumed session's moved tasks, a closed one opened fresh
 * the default, a rehired one's handover first.
 */
function firstPromptOf(team, id, from, resume, reopen) {
    if (reopen !== undefined) {
        return resume === undefined ? defaultPrompt(team, id) : reopenPrompt(team, id);
    }
    if (resume !== undefined) {
        return resumePrompt(team, id);
    }
    return from?.handover === undefined ? defaultPrompt(team, id) : rehirePrompt(team, id, from.handover);
}
export function idFlag(flag, value) {
    if (!ID_PATTERN.test(value)) {
        throw new UsageError(`${flag} "${value}" is not an id (${ID_RULE})`);
    }
    return value;
}
/** Launch's first prompt: the encoded one, none with --no-prompt, else the default. */
function launchPrompt(args, team, id) {
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
export function encodedPromptFlag(encoded) {
    const prompt = decodePrompt(encoded);
    if (prompt === undefined) {
        throw new UsageError('--encoded-prompt is not a prompt that teamrig open wrote');
    }
    return checkedPrompt(prompt);
}
/** The Claude Code session id `launch --resume` names, checked so nothing but an id reaches Claude Code. */
function resumeFlag(value) {
    return value === undefined ? undefined : claudeSessionArg('--resume', value);
}
/** A Claude Code session id an argument names, checked so nothing but an id reaches Claude Code. */
export function claudeSessionArg(name, value) {
    if (!CLAUDE_SESSION_ID.test(value)) {
        throw new UsageError(`${name} "${value}" is not a Claude Code session id`);
    }
    return value;
}
/** The effort `--effort` names, checked against Claude Code's levels. */
export function effortFlag(value) {
    if (value !== undefined && !isEffortLevel(value)) {
        throw new UsageError(`--effort "${value}" is not an effort level`);
    }
    return value;
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
/** How long launch looks for the close of a Claude Code that ended with an error: its closer logs it once it sees it gone. */
export const CLOSE_LOG_WAIT_MS = 5_000;
const CLOSE_LOG_POLL_MS = 500;
/**
 * The close teamrig logged for `id` since `since`, when Claude Code ended with an error: `teamrig close` and the idle
 * pass end it (src/cli/close-session.ts), so it exits nonzero, and log the close once they see it gone, so launch
 * looks for it until `CLOSE_LOG_WAIT_MS`. Undefined after a clean exit, or when no close came.
 */
async function closeSince(runtime, log, id, result, since) {
    if (result.kind !== 'exited' || result.code === 0) {
        return undefined;
    }
    const deadline = runtime.clock.now() + CLOSE_LOG_WAIT_MS;
    for (;;) {
        const close = closedOf((await log.read()).records, id);
        if (close !== undefined && Date.parse(close.at) >= since) {
            return close;
        }
        if (runtime.clock.now() >= deadline) {
            return undefined;
        }
        await runtime.sleep(CLOSE_LOG_POLL_MS);
    }
}
/** How to start Claude Code in `env`; refused when it is not on that PATH. */
export async function claudeProgramOf(runtime, env) {
    const claude = await findClaude({ env, platform: runtime.platform, probe: runtime.probe, files: runtime.files, node: runtime.self.node });
    if (claude.kind === 'missing') {
        const skipped = claude.skipped.length === 0 ? '' : ` (skipped: ${claude.skipped.join('; ')})`;
        throw new RefusedError(`Claude Code (claude) is not on PATH${skipped}; install it, then run this again`);
    }
    return claude.program;
}
/** The exit for how Claude Code ended, for a command that ran it on this terminal. */
export function claudeExit(runtime, command, result) {
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
 * its input and output on this terminal, listing other areas' skills as `skills.otherAreas` says. `$TEAMRIG_LAUNCHED` tells the Stop hook that launch runs it:
 * when the automatic context refresh ended Claude Code for a fresh start, launch starts it again in
 * this tab with the default prompt, and the new session reads its handover first. `--resume` resumes that
 * Claude Code session on the first start only: a restart is always fresh. `--effort` overrides the configured
 * effort and `--no-prompt` starts with no first prompt, as the restore after a reboot reopens an idle session.
 * When `teamrig close` or the idle pass ended Claude Code, launch says so and exits 0, so the tab closes: a tab left
 * open on the error offers to run this line again, starting a stale launch beside the session's next one. A start or
 * restart while the session runs in another Claude Code is refused.
 */
export async function launch(args, runtime) {
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
    const sessionRuntime = { ...runtime, env };
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
    let listing = await launchListing(sessionRuntime, kit, config, roster, id);
    runtime.out.stdout(`Starting Claude Code as ${name} (session ${id} of team ${team}) in ${project}, on ${describeLaunch(settings)}${resumed}${listing.note}`);
    const store = new RefreshStore(runtime.files, kit.paths);
    const closes = new SessionLog(runtime.files, kit.paths.sessionLog);
    let first = prompt;
    let resuming = resume;
    for (;;) {
        await refuseLiveRun(runtime, kit, roster, id, name);
        const resumeArgs = resuming === undefined ? [] : ['--resume', resuming];
        const args = [...prefix, ...launchFlags(settings), ...listing.args, ...resumeArgs, '--name', name, ...(first === undefined ? [] : [first])];
        const startedAt = runtime.clock.now();
        const result = await runtime.processes.run({ command, args, cwd: project, env });
        if (!(await restartTaken(store, id))) {
            const close = await closeSince(runtime, closes, id, result, startedAt);
            if (close === undefined) {
                return claudeExit(runtime, command, result);
            }
            runtime.out.stdout(`Claude Code was closed by ${close.by} after ${close.idleMinutes} min idle (${close.freedMb} MB freed): \`${KIT_NAME} open ${id}\` resumes it`);
            return EXIT.ok;
        }
        runtime.out.stdout(`Starting Claude Code again as ${name} with a fresh context: it reads its handover first`);
        first = refreshPrompt(team, id, store.handoverPath(id));
        resuming = undefined;
        // A skill added or a Used by line changed since the last start is listed as it is now.
        listing = await launchListing(sessionRuntime, kit, config, roster, id);
    }
}
