import { splitAddress } from "../../core/address.js";
import { KIT_NAME } from "../../core/home.js";
import { WAKE_TICK_MS } from "../../mod/wake-hand.js";
import { onePositional, UsageError } from "../args.js";
import { TAB_ACTIVITY_CLAUSES, tabActivityNow } from "../idle-check.js";
import { findTeam, openKit, sessionIdOf, teamZone } from "../kit.js";
import { runningRecordOf } from "../live-run.js";
import { EXIT, RefusedError } from "../runtime.js";
import { postAtOnce } from "../urgent-line.js";
import { openSession, printOpenResult, terminalFlag } from "./open.js";
import { namesOf, refuseUnderClaudeCode } from "./owner.js";
import { teamOf } from "./register-team.js";
import { sessionProjectOf } from "./setup.js";
const SECOND_MS = 1000;
/** The line the owner's Wake posts: it names no task, so the session works its own list. */
export function ownerWakeLine(owner, id) {
    return `${owner} woke you by hand: work your task list in plan order (${KIT_NAME} list --session ${id})`;
}
/**
 * `owner wake <[team/]id|name> [--terminal <name>] [--project <dir>]`: the owner wakes one session, pressed in the
 * pane (T2298). A running session's idle tab gets an inbox line from the owner (register.ownerSource) that wakes it at
 * once to work its list; while that ask still waits, nothing more is posted (postAtOnce). A tab in a turn, at a tool
 * call or with a decision put to the person is refused with nothing posted: it reads its list once the step ends, and
 * a question waits on the person in that tab. A session that does not run opens in a new tab as `open` opens it,
 * refused when the host has no room. Refused when wake.enabled is false on a running session's team, and under
 * CLAUDECODE. The owner is above every team, so a session of any team of the tree may be woken.
 */
export async function ownerWake(args, runtime) {
    refuseUnderClaudeCode(runtime, 'wake');
    const typed = onePositional(args, '[team/]id|name');
    const address = splitAddress(typed);
    if (address === undefined) {
        throw new UsageError(`owner wake takes a session as <id|name> or <team>/<id|name>, not "${typed}"`);
    }
    const found = await findTeam(runtime);
    const team = address.team ?? found.team;
    const kit = await openKit(runtime, team);
    const { config, roster } = await teamOf(runtime, kit, 'write');
    const id = sessionIdOf(roster, address.session);
    const shown = `${roster.nameOf(id) ?? id} (session ${namesOf(team === found.team ? undefined : team).session(id)})`;
    const project = await sessionProjectOf(runtime, config, id, args.flags.get('project'), found.from);
    const record = await runningRecordOf(runtime, kit.paths, roster.ids, id);
    if (record === undefined) {
        const terminal = terminalFlag(args.flags.get('terminal')) ?? config.open.terminal;
        return printOpenResult(runtime, await openSession(runtime, kit, config, roster, { team, id, project, terminal, asked: false }));
    }
    if (!config.wake.enabled) {
        throw new RefusedError(`${shown} was not woken: wake.enabled is false on team ${team}, so no inbox line wakes its tab; type in its tab instead`);
    }
    const activity = await tabActivityNow(runtime, record, project);
    if (activity !== undefined && activity !== 'idle') {
        throw new RefusedError(`${shown} ${TAB_ACTIVITY_CLAUSES[activity]}, so nothing was posted: it reads its list once that step ends; post it a Note on its task to add to that`);
    }
    const owner = config.register.ownerSource;
    const posted = await postAtOnce(runtime, kit, config, { to: id, from: owner, text: ownerWakeLine(owner, id) }, shown);
    if (posted.kind === 'waiting') {
        const at = teamZone(config, runtime).clock(new Date(posted.at));
        runtime.out.stdout(`ASKED ${shown} at ${at}: that ask still waits for its tab's next wake check, so no second line was posted`);
        return EXIT.ok;
    }
    runtime.out.stdout(`WAKES ${shown} within about ${Math.ceil(WAKE_TICK_MS / SECOND_MS)} s: an inbox line from ${owner} asks it to work its task list in plan order`);
    return EXIT.ok;
}
