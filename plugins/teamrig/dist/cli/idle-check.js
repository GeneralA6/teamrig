import { dirname } from 'node:path';
import { claudeProjectsDir, findTranscript } from "../budget/discover.js";
import { KIT_NAME } from "../core/home.js";
import { resumeVerdict } from "../hiring/rehire.js";
import { bookedMeetingOf, MeetingSchedule } from "../meeting/schedule.js";
import { workCutOffBy } from "../open/end-tab.js";
import { isClaudeProcess } from "../open/session-processes.js";
import { readRunningWork } from "../refresh/running.js";
import { parkRulesOf } from "../register/park.js";
import { lastTurnAtOf, soonTimeWaitOf, tabActivityOf, TIME_WAIT_GUARD_MINUTES } from "../sessions/idle.js";
import { measureSessions } from "../sessions/measure.js";
import { resumeFolderOf } from "../sessions/resume-folder.js";
import { SessionRecordStore } from "../sessions/record.js";
import { REPLY_TAIL_BYTES } from "../turn-log/reply.js";
import { unseenLinesOf } from "../inbox/inbox.js";
import { asksNowOf, urgentLinesText, WakeAsks } from "../wake/asks.js";
import { startableTasks } from "../wake/day-start.js";
import { inboxDepsOf } from "./commands/inbox.js";
import { measureTranscript } from "./commands/rehire.js";
import { teamZone } from "./kit.js";
import { RefusedError } from "./runtime.js";
import { teamRegister } from "./team-register.js";
const MINUTE_MS = 60_000;
/** `quiet <n> min, its Claude Code holds <MB> MB[, <MB> MB committed]`, as close and the idle pass print it. */
export function closableText(closable) {
    const committed = closable.committedMb === undefined ? '' : `, ${closable.committedMb} MB committed`;
    return `quiet ${closable.idleMinutes} min, its Claude Code holds ${closable.heldMb} MB${committed}`;
}
/** Why a tab's last turn keeps it open (or refuses the owner's wake), by where it stands. */
export const TAB_ACTIVITY_CLAUSES = {
    turn: 'is in a turn',
    call: 'is at a tool call (running, or waiting on a permission or an answer)',
    question: 'put a decision to the person and waits for the answer',
};
/** The facts for every session of the roster; refuses when the host's processes cannot be listed. */
export async function idleFactsOf(runtime, kit, config, roster) {
    const now = runtime.clock.now();
    const records = await new SessionRecordStore(runtime.files, kit.paths).readEach(roster.ids);
    const rows = await runtime.memory.processes();
    if (rows === undefined) {
        throw new RefusedError(`${KIT_NAME} could not list the host's processes, so it cannot tell which sessions run`);
    }
    const { snapshot, elsewhere } = await teamRegister(runtime, kit.paths, config).snapshotWithElsewhere();
    const store = new WakeAsks(runtime.files, kit.paths.wakeAsks);
    const asks = new Map();
    for (const id of roster.ids) {
        // A timed ask counts from its time, and only while its line is unseen.
        asks.set(id, (await asksNowOf(await store.read(id), now, () => unseenLinesOf(inboxDepsOf(runtime, kit.paths), id))).asks);
    }
    const { meetings } = await new MeetingSchedule(runtime.files, kit.paths.meetings).read();
    return { records, places: measureSessions(records, rows), tasks: snapshot.state.tasks, elsewhere, asks, meetings, now, zone: teamZone(config, runtime) };
}
/**
 * The transcript of `record`'s Claude Code session, measured: the one its start recorded while a file is there, else
 * the one of its session id in any project folder (T1357: a running session's transcript can leave the folder its
 * start recorded; seen 10-28, two sessions re-filed under the project folder of the worktree they moved to).
 * Undefined when it has none.
 */
async function measuredTranscriptOf(runtime, record, projectsDir, project) {
    if (record.transcript !== undefined) {
        const recorded = measuredOf(await measureTranscript(runtime, record.transcript));
        if (recorded !== undefined) {
            return recorded;
        }
    }
    const found = await findTranscript(runtime.transcripts, projectsDir, project, record.claudeSession);
    return found === undefined ? undefined : measuredOf(await measureTranscript(runtime, found));
}
/** The last REPLY_TAIL_BYTES of `transcript`, and whether that cut off its start. */
async function transcriptTailOf(runtime, transcript) {
    const tail = (await runtime.files.readTail(transcript, REPLY_TAIL_BYTES)) ?? '';
    return { tail, cut: Buffer.byteLength(tail, 'utf8') >= REPLY_TAIL_BYTES };
}
/**
 * Where `record`'s tab stands now, read from its transcript's last turn as the idle check reads it: undefined when no
 * transcript of its Claude Code session is found.
 */
export async function tabActivityNow(runtime, record, project) {
    const last = await measuredTranscriptOf(runtime, record, claudeProjectsDir(runtime.env, runtime.userHome), project);
    if (last === undefined) {
        return undefined;
    }
    const { tail, cut } = await transcriptTailOf(runtime, last.transcript);
    return tabActivityOf(tail, cut);
}
function measuredOf(last) {
    const { changedAt } = last;
    return changedAt === undefined ? undefined : { ...last, changedAt };
}
/**
 * Whether `id` closes, with the checks in the order they cost: a role, open.idle.keepOpen or a started booked owner
 * meeting it is in that keeps it, not running in the host's
 * process list, work it can start within `maxPriority`, an urgent line waiting to wake it (closed, it would reopen at
 * the next pass for it), a time wait of its own ending soon, quiet too briefly since its last own transcript entry, a
 * transcript in a project folder no folder `open` could resume it in has (`resumeFolderOf`: the project, or a folder
 * it ran in, which its close records), a turn not ended (under way, at a tool call, or a decision put to the person),
 * work running in the background, a last session too big or old to resume (v1 has no handover for a close), its
 * process no longer a Claude Code, or shells
 * an end would cut off. The first that holds keeps it open. The last two look at the host's processes one by one
 * (about a second each on Windows), so only a session every other check would close pays for them.
 */
export async function idleVerdictOf(runtime, config, roster, facts, id, options) {
    const label = `${roster.nameOf(id) ?? id} (session ${id})`;
    const keep = (why) => ({ kind: 'keep', why: `${label} ${why}` });
    const notRunning = 'is not running: nothing to close';
    const kept = roster.rolesOf(id).filter((role) => role === 'lead' || role === 'deliveryOwner');
    if (kept.length > 0) {
        return keep(`holds the ${kept.join(' and ')} role: ${KIT_NAME} never closes it`);
    }
    if (config.open.idle.keepOpen.includes(id)) {
        return keep(`is in open.idle.keepOpen: ${KIT_NAME} never closes it`);
    }
    // The owner talks to the tab, not to the session's transcript, so a meeting's idle minutes say nothing (T2542).
    const meeting = bookedMeetingOf(facts.meetings, id, facts.now);
    if (meeting !== undefined) {
        return keep(`is in the owner's open meeting ${meeting.id}: ${KIT_NAME} keeps it open until the meeting ends`);
    }
    const record = facts.records.get(id);
    const place = facts.places.find((each) => each.id === id);
    if (record === undefined || place?.state !== 'running') {
        return keep(notRunning);
    }
    const { now, zone, tasks, elsewhere } = facts;
    const startable = startableTasks(tasks, elsewhere, id, now, zone, parkRulesOf(config), options.maxPriority);
    if (startable.length > 0) {
        return keep(`has work it can start (${startable.map((task) => task.id).join(', ')})`);
    }
    const asks = facts.asks.get(id) ?? [];
    if (asks.length > 0) {
        return keep(`has ${urgentLinesText(asks)} waiting to wake it`);
    }
    const soon = soonTimeWaitOf(tasks, id, options.maxPriority, now, zone);
    if (soon !== undefined) {
        return keep(`waits until ${zone.clock(new Date(soon.at))} on ${soon.task.id}, under ${TIME_WAIT_GUARD_MINUTES} min away`);
    }
    const projectsDir = claudeProjectsDir(runtime.env, runtime.userHome);
    const last = await measuredTranscriptOf(runtime, record, projectsDir, options.project);
    if (last === undefined) {
        return keep(`has no transcript of Claude Code session ${record.claudeSession} in any project folder, so its idle time is unknown`);
    }
    const { tail, cut } = await transcriptTailOf(runtime, last.transcript);
    // A tail with no timed own entry falls back to the file's last change, which is never earlier.
    const idleMinutes = Math.floor((now - (lastTurnAtOf(tail, cut) ?? last.changedAt)) / MINUTE_MS);
    const needed = config.open.headroom.closeIdleMinutes;
    if (idleMinutes < needed) {
        return keep(`has been quiet ${idleMinutes} min; it closes after ${needed} (open.headroom.closeIdleMinutes)`);
    }
    const folder = resumeFolderOf(last.transcript, tail, options.project, projectsDir, runtime.platform);
    if (folder === undefined) {
        return keep(`could not be resumed once closed (its transcript is in ${dirname(last.transcript)}, the project folder of neither ${options.project} nor a folder it ran in)`);
    }
    const activity = tabActivityOf(tail, cut);
    if (activity !== 'idle') {
        return keep(TAB_ACTIVITY_CLAUSES[activity]);
    }
    if ((await readRunningWork(runtime.files, last.transcript, now)) > 0) {
        return keep('still runs background work its transcript shows');
    }
    const resume = resumeVerdict({ claudeSession: record.claudeSession, changedAt: last.changedAt, tokens: last.tokens }, config.hiring, now);
    if (resume.kind === 'fresh') {
        return keep(`could not be resumed once closed (${resume.detail}); retire it with its handover instead`);
    }
    const claude = await runtime.sessionProcesses.describe(record.claudePid);
    if (claude === undefined || !isClaudeProcess(claude)) {
        return keep(notRunning);
    }
    const cutOff = await workCutOffBy(enderOf(runtime), claude);
    if (cutOff !== undefined) {
        return { kind: 'keep', why: `${label}: ${cutOff}` };
    }
    return { kind: 'close', closable: { record, claude, heldMb: place.treeMb, committedMb: place.committedMb, idleMinutes, folder } };
}
/** What ends a session's tab and checks what that would cut off, from the runtime. */
export function enderOf(runtime) {
    return { processes: runtime.sessionProcesses, clock: runtime.clock, sleep: runtime.sleep, platform: runtime.platform };
}
