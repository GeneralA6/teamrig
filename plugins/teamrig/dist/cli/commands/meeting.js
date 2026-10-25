import { KIT_NAME } from "../../core/home.js";
import { SecretScanner } from "../../core/secrets.js";
import { postLine } from "../../inbox/inbox.js";
import { agendaLines, agendaSince } from "../../meeting/agenda.js";
import { decisionsByOwner, endNotice } from "../../meeting/notices.js";
import { MeetingStore, phaseOf, stoppedAt } from "../../meeting/state.js";
import { currentWeekOf } from "../../register/week.js";
import { fitLines } from "../../register/fit.js";
import { TaskTree } from "../../register/tree.js";
import { noPositionals } from "../args.js";
import { callerOf } from "../inputs.js";
import { openTeamKit, requireConfig, rosterOf, sessionIdOf, teamZone } from "../kit.js";
import { EXIT, RefusedError } from "../runtime.js";
import { weekLineOf } from "./budget.js";
import { inboxDepsOf, read } from "./inbox.js";
import { ownRegister, weekFitOf } from "./register.js";
/** The caller's team, refused unless the caller is its lead: the meeting is the lead's with the owner. */
async function meetingKit(args, runtime, access) {
    noPositionals(args);
    const kit = await openTeamKit(runtime);
    const config = requireConfig(kit, runtime, access);
    const roster = await rosterOf(runtime, kit, config);
    const caller = sessionIdOf(roster, callerOf(args.flags, runtime.env));
    // A config that fails to load its lead still reads (an agenda), and names none on the roster.
    const holder = roster.holderOf('lead');
    const lead = holder !== undefined && roster.ids.includes(holder) ? holder : undefined;
    if (lead === undefined || caller !== lead) {
        throw new RefusedError(`only the lead${lead === undefined ? '' : ` (${roster.nameOf(lead) ?? lead})`} runs the owner's daily meeting`);
    }
    const store = new MeetingStore(runtime.files, kit.paths.meeting);
    return { kit, config, roster, lead, leadName: roster.nameOf(lead) ?? lead, store, now: runtime.clock.now(), zone: teamZone(config, runtime) };
}
/**
 * One inbox line to each session on the roster with decisions recorded on its tasks, and none to the rest; prints a
 * line for each it could not post to, and returns how many it told.
 */
async function tellDecided(runtime, mk, decisions) {
    const { inboxes } = inboxDepsOf(runtime, mk.kit.paths);
    const secrets = new SecretScanner(mk.config.register.secretPatterns);
    const facts = { leadName: mk.leadName, at: mk.now, zone: mk.zone };
    let told = 0;
    for (const session of mk.roster.ids) {
        const decided = decisions.get(session);
        if (session === mk.lead || decided === undefined) {
            continue;
        }
        const problem = await postLine(inboxes, secrets, { to: session, from: mk.lead, text: endNotice(facts, decided), now: new Date(mk.now) });
        if (problem === undefined) {
            told += 1;
        }
        else {
            runtime.out.stdout(`NOT TOLD ${session}: ${problem}`);
        }
    }
    return told;
}
/** When the meeting before the open one or the next one stopped, from which the agenda counts the finished work. */
function previousEnd(phase) {
    if (phase.kind !== 'open') {
        return stoppedAt(phase);
    }
    return phase.meeting.since === null ? undefined : Date.parse(phase.meeting.since);
}
function phaseLine(phase, mk) {
    switch (phase.kind) {
        case 'none':
            return `MEETING none held yet; the agenda for the first (${KIT_NAME} meeting start opens it)`;
        case 'open':
            return `MEETING open since ${mk.zone.weekdayMinute(new Date(phase.meeting.startedAt))}: messages to ${mk.leadName} are held but CRITICAL ones`;
        case 'lapsed':
            return `MEETING the one started ${mk.zone.weekdayMinute(new Date(phase.meeting.startedAt))} was never ended and holds no message since ${mk.zone.weekdayMinute(new Date(phase.until))}; ${KIT_NAME} meeting end tells each session the decisions on its tasks`;
        case 'closed':
            return `MEETING none open, the last ended ${mk.zone.weekdayMinute(new Date(phase.until))}; the agenda for the next (${KIT_NAME} meeting start opens it)`;
    }
}
/** The agenda: the register's part (decisions, late, done), the lead's inbox marked read, then the week's use and, under it, the planned week's fit (as `plan` gives it). */
async function printAgenda(args, runtime, mk, phase) {
    const rollUp = await ownRegister(runtime);
    const { snapshot, elsewhere } = rollUp.own;
    const now = new Date(mk.now);
    const { zone } = mk;
    const lines = agendaLines({
        tasks: [...snapshot.state.tasks.values()],
        tree: new TaskTree(snapshot.state.tasks, now, zone, currentWeekOf(snapshot, now, zone), elsewhere),
        now: mk.now,
        since: agendaSince(previousEnd(phase), mk.now),
        ownerMarker: mk.config.register.ownerSource,
        requireGate: mk.config.register.requireDecisionCard,
        lead: mk.lead,
        command: KIT_NAME,
    });
    lines.forEach((line) => runtime.out.stdout(line));
    await read({ ...args, flags: new Map([['session', mk.lead]]) }, runtime);
    runtime.out.stdout(await weekLineOf(runtime, mk.kit, mk.config, mk.roster));
    const week = currentWeekOf(snapshot, now, zone);
    if (week !== null) {
        fitLines(await weekFitOf(runtime, rollUp, week, false)).forEach((line) => runtime.out.stdout(`  ${line}`));
    }
}
/**
 * `meeting start`: opens the meeting and prints the agenda; it posts no line, as the hook tells each sender it
 * holds. A meeting already open stays as it is: its agenda prints.
 */
export async function meetingStart(args, runtime) {
    const mk = await meetingKit(args, runtime, 'write');
    const phase = phaseOf(await mk.store.read(), mk.now);
    if (phase.kind === 'open') {
        runtime.out.stdout(`MEETING already open since ${mk.zone.weekdayMinute(new Date(phase.meeting.startedAt))}: messages to ${mk.leadName} are held but CRITICAL ones`);
        await printAgenda(args, runtime, mk, phase);
        return EXIT.ok;
    }
    const before = stoppedAt(phase);
    const meeting = { startedAt: new Date(mk.now).toISOString(), by: mk.lead, endedAt: null, since: before === undefined ? null : new Date(before).toISOString() };
    await mk.store.write(meeting);
    runtime.out.stdout(`MEETING started ${mk.zone.weekdayMinute(new Date(mk.now))}: messages to ${mk.leadName} are held but CRITICAL ones (the hook tells each sender)`);
    await printAgenda(args, runtime, mk, { kind: 'open', meeting });
    runtime.out.stdout(`END ${KIT_NAME} meeting end --session ${mk.lead}: tells each session the decisions recorded on its tasks`);
    return EXIT.ok;
}
/** `meeting agenda`: the agenda now, during a meeting or to prepare the next one. */
export async function meetingAgenda(args, runtime) {
    const mk = await meetingKit(args, runtime, 'read');
    const phase = phaseOf(await mk.store.read(), mk.now);
    runtime.out.stdout(phaseLine(phase, mk));
    await printAgenda(args, runtime, mk, phase);
    return EXIT.ok;
}
/**
 * `meeting end`: closes the open meeting, or one that lapsed unended, and tells each session whose tasks the lead
 * updated during the meeting those updates (the decisions recorded) by one inbox line; a session with none gets no line.
 */
export async function meetingEnd(args, runtime) {
    const mk = await meetingKit(args, runtime, 'write');
    const phase = phaseOf(await mk.store.read(), mk.now);
    if (phase.kind !== 'open' && phase.kind !== 'lapsed') {
        throw new RefusedError(`no meeting is open; ${KIT_NAME} meeting start opens one`);
    }
    const { meeting } = phase;
    await mk.store.write({ ...meeting, endedAt: new Date(mk.now).toISOString() });
    const { snapshot } = (await ownRegister(runtime)).own;
    const startedAt = Date.parse(meeting.startedAt);
    const decisions = decisionsByOwner(snapshot.read.events, snapshot.state.tasks, mk.lead, startedAt);
    const told = await tellDecided(runtime, mk, decisions);
    const minutes = Math.round((mk.now - startedAt) / 60_000);
    runtime.out.stdout(`MEETING ended ${mk.zone.weekdayMinute(new Date(mk.now))} after ${minutes} min: messages to ${mk.leadName} go again; told ${told} session(s) the decisions on their tasks`);
    const recorded = [...decisions].flatMap(([owner, lines]) => lines.map((line) => `  ${owner} ${line}`));
    runtime.out.stdout(recorded.length === 0
        ? `RECORDED nothing on another session's task during it: a decision the register lacks reaches no one (${KIT_NAME} update <id> --note "..." --session ${mk.lead})`
        : `RECORDED ${recorded.length} decision(s), each told to its task's owner`);
    recorded.forEach((line) => runtime.out.stdout(line));
    return EXIT.ok;
}
