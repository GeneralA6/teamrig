import { KIT_NAME } from "../../core/home.js";
import { sessionDisplay } from "../../core/ids.js";
import { SecretScanner } from "../../core/secrets.js";
import { inboxLineOf, postLines } from "../../inbox/inbox.js";
import { lineHash } from "../../inbox/line-hash.js";
import { ABOUT_MAX, byTime, DEFAULT_MEETING_MINUTES, isMeetingId, isMissed, isOpenMeeting, MeetingSchedule, nextMeetingId, } from "../../meeting/schedule.js";
import { WAKE_TICK_MS } from "../../mod/wake-hand.js";
import { focusTab } from "../../open/focus.js";
import { shellCommand } from "../../open/quote.js";
import { WakeAsks } from "../../wake/asks.js";
import { noPositionals, onePositional, requiredFlag, UsageError } from "../args.js";
import { callerOf, instantOf, listOf, taskIdOf } from "../inputs.js";
import { findTeam, openKit, requireConfig, rosterOf, sessionIdOf, teamZone } from "../kit.js";
import { liveRunOf } from "../live-run.js";
import { EXIT, RefusedError } from "../runtime.js";
import { inboxDepsOf } from "./inbox.js";
import { openSession, TERMINAL_LABELS } from "./open.js";
import { ownRegister } from "./register.js";
import { sessionProjectOf } from "./setup.js";
import { fileLockOf } from "../file-locks.js";
/**
 * `meeting schedule|list|move|start <id>|end <id>|drop` (T1358): the owner's meetings with one session at a set time,
 * apart from the daily meeting with the lead (meeting.ts). The lead or the session met books, moves, ends and drops
 * one; the session met and those joining get one inbox line when it is booked, moved, started or dropped. Any
 * session starts one, as the owner does from whichever tab they are in: its opening prompt reaches the session met
 * as an urgent line its idle tab wakes on, or opens its tab when none runs. Every change is made under the team's
 * meetings lock, so two sessions never book one id.
 */
/** The longest meeting a schedule takes, in minutes: a working day. */
export const MEETING_MINUTES_MAX = 480;
const SECOND_MS = 1000;
async function meetingsKit(args, runtime, access) {
    const found = await findTeam(runtime);
    const kit = await openKit(runtime, found.team);
    const config = requireConfig(kit, runtime, access);
    const roster = await rosterOf(runtime, kit, config);
    const { files, clock } = runtime;
    return {
        kit,
        from: found.from,
        config,
        roster,
        caller: sessionIdOf(roster, callerOf(args.flags, runtime.env)),
        schedule: new MeetingSchedule(files, kit.paths.meetings),
        lock: fileLockOf(runtime, kit.paths.meetingsLock, config.lock),
        now: clock.now(),
        zone: teamZone(config, runtime),
    };
}
/** One meeting as a list line: its id, status (a scheduled one past its slot reads missed), time, length, sessions, tasks and what it is about. */
export function meetingLine(meeting, zone, now) {
    const status = isMissed(meeting, now) ? 'missed' : meeting.status;
    const joining = meeting.with.length === 0 ? '' : ` with ${meeting.with.join(', ')}`;
    const tasks = meeting.tasks.length === 0 ? '' : `, tasks ${meeting.tasks.join(' ')}`;
    return `${meeting.id} ${status}, ${zone.weekdayMinute(new Date(meeting.at))}, ${meeting.minutes} min, ${meeting.session}${joining}${tasks} | ${meeting.about}`;
}
/** The open meetings to hold by the end of today on the team's clock, by time: today's, and any missed before. */
export function meetingsToday(meetings, zone, now) {
    const today = zone.day(new Date(now));
    return byTime(meetings.filter((meeting) => isOpenMeeting(meeting) && zone.day(new Date(meeting.at)) <= today));
}
/** The daily agenda's MEETINGS section: today's scheduled meetings and the missed ones, each as `meeting list` shows it. */
export function agendaMeetingLines(meetings, zone, now) {
    const today = meetingsToday(meetings, zone, now);
    if (today.length === 0) {
        return ['MEETINGS 0 today'];
    }
    return [
        `MEETINGS ${today.length} today or missed`,
        ...today.map((meeting) => `  ${meetingLine(meeting, zone, now)}`),
        `  The owner starts one with ${KIT_NAME} meeting start <id>; a missed one is moved (${KIT_NAME} meeting move <id> --at <time>) or dropped.`,
    ];
}
/**
 * `start`'s MEETINGS line: today's and the missed meetings `session` is met in or joins, every one for the lead;
 * undefined when there are none.
 */
export function startMeetingLine(meetings, zone, now, session, lead) {
    const shown = meetingsToday(meetings, zone, now).filter((meeting) => lead || meeting.session === session || meeting.with.includes(session));
    if (shown.length === 0) {
        return undefined;
    }
    const entries = shown.map((meeting) => {
        const when = isMissed(meeting, now) ? `missed (${zone.weekdayMinute(new Date(meeting.at))})` : `${meeting.status === 'started' ? 'started ' : ''}${zone.clock(new Date(meeting.at))}`;
        const joining = meeting.with.length === 0 ? '' : ` with ${meeting.with.join(', ')}`;
        const tasks = meeting.tasks.length === 0 ? '' : ` on ${meeting.tasks.join(' ')}`;
        return `${meeting.id} ${when} ${meeting.session}${joining}${tasks}`;
    });
    return `MEETINGS today: ${entries.join('; ')}`;
}
function detailLines(meeting) {
    return [...(meeting.brief === null ? [] : [`    brief: ${meeting.brief}`]), ...(meeting.note === null ? [] : [`    note: ${meeting.note}`])];
}
/** A text flag that is one line, at most ABOUT_MAX characters and no secret. */
function lineOf(flag, text, secrets) {
    const line = text.trim();
    if (line === '' || /[\r\n]/.test(line)) {
        throw new UsageError(`${flag} is one non-empty line`);
    }
    const length = [...line].length;
    if (length > ABOUT_MAX) {
        throw new UsageError(`${flag} holds ${length} characters: at most ${ABOUT_MAX}; the brief holds the rest`);
    }
    const refusal = secrets.refusal(flag, line);
    if (refusal !== undefined) {
        throw new RefusedError(refusal);
    }
    return line;
}
function noteOf(text, secrets) {
    return text === undefined ? null : lineOf('--note', text, secrets);
}
function minutesOf(text) {
    if (text === undefined) {
        return DEFAULT_MEETING_MINUTES;
    }
    const minutes = Number(text);
    if (!/^\d+$/.test(text.trim()) || minutes < 1 || minutes > MEETING_MINUTES_MAX) {
        throw new UsageError(`--minutes "${text}" is not a whole number of minutes from 1 to ${MEETING_MINUTES_MAX}`);
    }
    return minutes;
}
/** A start time ahead of now, on the team's clock unless marked. */
function futureAt(text, mk) {
    const at = instantOf('--at', text, { nowMs: mk.now, zone: mk.zone });
    if (at <= mk.now) {
        throw new RefusedError(`--at ${mk.zone.weekdayMinute(new Date(at))} is past: a meeting is booked ahead`);
    }
    return at;
}
/** The linked tasks, each a task of the team. */
async function tasksOf(runtime, text) {
    if (text === undefined) {
        return [];
    }
    const ids = [...new Set(listOf('--tasks', text).map((each) => taskIdOf(each)))];
    const { tasks } = (await ownRegister(runtime)).own.snapshot.state;
    const unknown = ids.find((id) => !tasks.has(id));
    if (unknown !== undefined) {
        throw new RefusedError(`${unknown} is not a task of the team`);
    }
    return ids;
}
/** The lead and the session met change a meeting; anyone else is refused, told who may `what`. */
function mayChange(mk, session, what) {
    const lead = mk.roster.holderOf('lead');
    if (mk.caller !== lead && mk.caller !== session) {
        throw new RefusedError(`only the lead${lead === undefined ? '' : ` (${mk.roster.nameOf(lead) ?? lead})`} or ${session}, the session met, may ${what}`);
    }
}
function meetingOf(read, id) {
    if (!isMeetingId(id)) {
        throw new UsageError(`"${id}" is not a meeting id like M3`);
    }
    const found = read.meetings.find((meeting) => meeting.id === id);
    if (found === undefined) {
        throw new RefusedError(`${id} is not a meeting of the team: ${KIT_NAME} meeting list --all lists them`);
    }
    return found;
}
/**
 * Tells the session met and those joining, but the caller, by one inbox line each; prints who was told, or why a
 * line could not go.
 */
async function tell(runtime, mk, meeting, text) {
    const receivers = [meeting.session, ...meeting.with].filter((session) => session !== mk.caller);
    if (receivers.length === 0) {
        return;
    }
    const { inboxes } = inboxDepsOf(runtime, mk.kit.paths);
    const problem = await postLines(receivers.map((to) => ({ inboxes, to, from: mk.caller })), new SecretScanner(mk.config.register.secretPatterns), { text, now: new Date(mk.now) });
    runtime.out.stdout(problem === undefined ? `TOLD ${receivers.join(', ')}` : `NOT TOLD ${receivers.join(', ')}: ${problem}`);
}
function bookedText(meeting, zone) {
    const tasks = meeting.tasks.length === 0 ? '' : `; tasks ${meeting.tasks.join(' ')}`;
    const brief = meeting.brief === null ? '' : `; brief ${meeting.brief}`;
    return `${zone.weekdayMinute(new Date(meeting.at))} (${meeting.minutes} min) with ${meeting.session}: ${meeting.about}${tasks}${brief}`;
}
/** `meeting schedule`: books a meeting and tells the session met and those joining. */
export async function meetingSchedule(args, runtime) {
    noPositionals(args);
    const mk = await meetingsKit(args, runtime, 'write');
    const secrets = new SecretScanner(mk.config.register.secretPatterns);
    const session = sessionIdOf(mk.roster, requiredFlag(args.flags, 'meets'));
    mayChange(mk, session, `book a meeting with ${session}`);
    const withText = args.flags.get('with');
    const joining = withText === undefined ? [] : [...new Set(listOf('--with', withText).map((each) => sessionIdOf(mk.roster, each)))].filter((each) => each !== session);
    const brief = args.flags.get('brief')?.trim();
    const fields = {
        at: futureAt(requiredFlag(args.flags, 'at'), mk),
        minutes: minutesOf(args.flags.get('minutes')),
        about: lineOf('--about', requiredFlag(args.flags, 'about'), secrets),
        tasks: await tasksOf(runtime, args.flags.get('tasks')),
        brief: brief === undefined || brief === '' ? null : brief,
    };
    const meeting = await mk.lock.run(async () => {
        const booked = { id: nextMeetingId(await mk.schedule.read()), session, with: joining, ...fields, status: 'scheduled', notifiedAt: null, by: mk.caller, changedAt: mk.now, note: null };
        await mk.schedule.write(booked, mk.now);
        return booked;
    });
    runtime.out.stdout(`SCHEDULED ${meetingLine(meeting, mk.zone, mk.now)}`);
    await tell(runtime, mk, meeting, `Meeting ${meeting.id} with the owner booked: ${bookedText(meeting, mk.zone)}. At its time the owner starts it in ${meeting.session}'s tab (${KIT_NAME} meeting start ${meeting.id})`);
    return EXIT.ok;
}
/** `meeting list`: the scheduled and started meetings by time; `--all` adds those done or dropped in the last week; `--json` for the pane. */
export async function meetingList(args, runtime) {
    noPositionals(args);
    const mk = await meetingsKit(args, runtime, 'read');
    const { meetings } = await mk.schedule.read();
    const shown = byTime(args.switches.has('all') ? meetings : meetings.filter(isOpenMeeting));
    if (args.switches.has('json')) {
        const rows = shown.map((meeting) => ({
            id: meeting.id,
            at: new Date(meeting.at).toISOString(),
            atText: mk.zone.weekdayMinute(new Date(meeting.at)),
            minutes: meeting.minutes,
            session: meeting.session,
            with: meeting.with,
            tasks: meeting.tasks,
            about: meeting.about,
            brief: meeting.brief,
            status: meeting.status,
            missed: isMissed(meeting, mk.now),
        }));
        runtime.out.stdout(JSON.stringify({ meetings: rows }));
        return EXIT.ok;
    }
    runtime.out.stdout(`MEETINGS ${shown.length} ${args.switches.has('all') ? 'of the last week and ahead' : 'scheduled or started'}`);
    for (const meeting of shown) {
        runtime.out.stdout(`  ${meetingLine(meeting, mk.zone, mk.now)}`);
        detailLines(meeting).forEach((line) => runtime.out.stdout(line));
    }
    return EXIT.ok;
}
/**
 * Changes one meeting under the lock (`meeting <verb> <id>`): refused unless the caller may change it and its status
 * is one of `from`; returns the meeting as written.
 */
async function change(args, mk, verb, from, next) {
    const id = onePositional(args, 'meeting id');
    return mk.lock.run(async () => {
        const meeting = meetingOf(await mk.schedule.read(), id);
        mayChange(mk, meeting.session, `${verb} ${id}`);
        if (!from.includes(meeting.status)) {
            throw new RefusedError(`${id} is ${meeting.status}: meeting ${verb} takes a ${from.join(' or ')} meeting`);
        }
        const changed = { ...next(meeting), by: mk.caller, changedAt: mk.now };
        await mk.schedule.write(changed, mk.now);
        return changed;
    });
}
/** `meeting move <id> --at`: a new time for a scheduled meeting, whose notification fires again at it. */
export async function meetingMove(args, runtime) {
    const mk = await meetingsKit(args, runtime, 'write');
    const at = futureAt(requiredFlag(args.flags, 'at'), mk);
    const note = noteOf(args.flags.get('note'), new SecretScanner(mk.config.register.secretPatterns));
    const moved = await change(args, mk, 'move', ['scheduled'], (meeting) => ({ ...meeting, at, notifiedAt: null, note: note ?? meeting.note }));
    runtime.out.stdout(`MOVED ${meetingLine(moved, mk.zone, mk.now)}`);
    await tell(runtime, mk, moved, `Meeting ${moved.id} with the owner moved: ${bookedText(moved, mk.zone)}${note === null ? '' : ` (${note})`}`);
    return EXIT.ok;
}
/**
 * The opening prompt the session met gets at a start: the meeting, its tasks, those joining and its brief, what to
 * do now and how to end it.
 */
export function openingPrompt(meeting) {
    const tasks = meeting.tasks.length === 0 ? '' : ` Tasks: ${meeting.tasks.join(' ')}.`;
    const joining = meeting.with.length === 0 ? '' : ` Joining: ${meeting.with.join(', ')}.`;
    const brief = meeting.brief === null ? ' Meet the owner here now.' : ` Brief: ${meeting.brief}. Read the brief, then meet the owner here.`;
    const about = meeting.about.replace(/[.\s]+$/, '');
    return `The owner starts meeting ${meeting.id} now (${meeting.minutes} min): ${about}.${tasks}${joining}${brief} When it is over: ${KIT_NAME} meeting end ${meeting.id} --note "<what came of it>".`;
}
/**
 * The urgent line that brings the opening prompt to the session met's tab. Bound to its posted inbox line, it is a
 * timed ask due now: its idle tab wakes on it at the next wake check, not after the `wake.batchSeconds` a plain ask
 * waits, and not once the session has seen the line. Unposted, it is a plain ask.
 */
function openingAsk(mk, text, posted) {
    const ask = { from: mk.caller, text, at: mk.now };
    return posted ? { ...ask, by: { at: mk.now, line: lineHash(inboxLineOf(new Date(mk.now), mk.caller, text)) } } : ask;
}
/** What bringing the running tab of session `name`, titled `title`, to the front prints. */
function focusLine(outcome, name, title) {
    switch (outcome.kind) {
        case 'focused':
            return `FOCUSED ${name}'s ${TERMINAL_LABELS[outcome.terminal]}, ${title}`;
        case 'behind':
            return `SELECTED ${name}'s ${TERMINAL_LABELS[outcome.terminal]}, ${title}, in its window; Windows kept another app's window in front`;
        case 'none':
            return `NOT FOCUSED ${name}'s tab, ${title}: ${outcome.reasons.join('; ')}`;
    }
}
/**
 * Brings the opening prompt to the session met and returns what that prints. While its tab runs, the tab is brought
 * to the front, and gets an urgent line it wakes on once idle, a running turn ending first; with `wake.enabled`
 * false, nothing beyond its inbox line. With no tab, a new one opens, in front, with the prompt ahead of its own first
 * prompt, as the idle pass reopens a closed session; when none can open (no terminal, no room), the ask waits for its
 * next tab.
 */
async function deliver(runtime, mk, meeting, posted) {
    const id = meeting.session;
    const name = mk.roster.nameOf(id) ?? id;
    const ask = openingAsk(mk, openingPrompt(meeting), posted);
    const asks = new WakeAsks(runtime.files, mk.kit.paths.wakeAsks);
    if ((await liveRunOf(runtime, mk.kit.paths, mk.roster.ids, id)) !== undefined) {
        const title = sessionDisplay(mk.kit.paths.team, name);
        const focused = focusLine(await focusTab(runtime, mk.config.open.terminal, title, runtime.cwd), name, title);
        if (!mk.config.wake.enabled) {
            return [focused, `NOT WOKEN ${name}: wake.enabled is false on the team, so the meeting waits in its inbox for its next prompt`];
        }
        await asks.post(id, ask);
        const within = posted ? `within about ${Math.ceil(WAKE_TICK_MS / SECOND_MS)} s` : `within about ${mk.config.wake.batchSeconds + Math.ceil(WAKE_TICK_MS / SECOND_MS)} s`;
        return [focused, `WAKES ${name} with the meeting's opening prompt once its tab is idle, ${within} (a running turn ends first)`];
    }
    const project = await sessionProjectOf(runtime, mk.config, id, undefined, mk.from);
    try {
        const opened = await openSession(runtime, mk.kit, mk.config, mk.roster, { team: mk.kit.paths.team, id, project, terminal: mk.config.open.terminal, asked: false, urgent: [ask] });
        if (opened.kind === 'opened') {
            return [`${opened.line}; its first prompt opens the meeting`];
        }
        await asks.post(id, ask);
        const shell = runtime.platform === 'win32' ? ' in PowerShell' : '';
        return [`MANUAL no terminal opened (${opened.reasons.join('; ')}); the meeting waits as an urgent line: open a new terminal and run this${shell}:`, shellCommand(runtime.platform, opened.folder, opened.argv)];
    }
    catch (error) {
        if (!(error instanceof RefusedError)) {
            throw error;
        }
        await asks.post(id, ask);
        return [`NOT OPENED ${name}: ${error.message}; the meeting waits as an urgent line for its next tab`];
    }
}
/**
 * `meeting start <id>`: the owner starts a scheduled meeting, a missed one too. It is started, the session met gets
 * its opening prompt as an inbox line and in its tab (deliver), and those joining one line saying where it is held.
 */
export async function meetingStartScheduled(args, runtime) {
    const mk = await meetingsKit(args, runtime, 'write');
    const id = onePositional(args, 'meeting id');
    const started = await mk.lock.run(async () => {
        const meeting = meetingOf(await mk.schedule.read(), id);
        if (meeting.status !== 'scheduled') {
            throw new RefusedError(`${id} is ${meeting.status}: meeting start takes a scheduled meeting`);
        }
        const changed = { ...meeting, status: 'started', by: mk.caller, changedAt: mk.now };
        await mk.schedule.write(changed, mk.now);
        return changed;
    });
    runtime.out.stdout(`STARTED ${meetingLine(started, mk.zone, mk.now)}`);
    const { inboxes } = inboxDepsOf(runtime, mk.kit.paths);
    const secrets = new SecretScanner(mk.config.register.secretPatterns);
    const met = await postLines([{ inboxes, to: started.session, from: mk.caller }], secrets, { text: openingPrompt(started), now: new Date(mk.now) });
    runtime.out.stdout(met === undefined ? `TOLD ${started.session}` : `NOT TOLD ${started.session}: ${met}`);
    const delivered = await deliver(runtime, mk, started, met === undefined);
    const joining = started.with.filter((session) => session !== mk.caller);
    if (joining.length > 0) {
        const text = `Meeting ${started.id} with the owner started in ${started.session}'s tab: ${started.about}`;
        const problem = await postLines(joining.map((to) => ({ inboxes, to, from: mk.caller })), secrets, { text, now: new Date(mk.now) });
        runtime.out.stdout(problem === undefined ? `TOLD ${joining.join(', ')}` : `NOT TOLD ${joining.join(', ')}: ${problem}`);
    }
    delivered.forEach((line) => runtime.out.stdout(line));
    return EXIT.ok;
}
/** `meeting end <id>`: the meeting was held; scheduled or started, it is done. */
export async function meetingEndScheduled(args, runtime) {
    const mk = await meetingsKit(args, runtime, 'write');
    const note = noteOf(args.flags.get('note'), new SecretScanner(mk.config.register.secretPatterns));
    const ended = await change(args, mk, 'end', ['scheduled', 'started'], (meeting) => ({ ...meeting, status: 'done', note: note ?? meeting.note }));
    runtime.out.stdout(`ENDED ${meetingLine(ended, mk.zone, mk.now)}`);
    return EXIT.ok;
}
/** `meeting drop <id> --note`: the meeting will not be held; those it would meet are told why. */
export async function meetingDrop(args, runtime) {
    const mk = await meetingsKit(args, runtime, 'write');
    const note = lineOf('--note', requiredFlag(args.flags, 'note'), new SecretScanner(mk.config.register.secretPatterns));
    const dropped = await change(args, mk, 'drop', ['scheduled', 'started'], (meeting) => ({ ...meeting, status: 'dropped', note }));
    runtime.out.stdout(`DROPPED ${meetingLine(dropped, mk.zone, mk.now)}`);
    await tell(runtime, mk, dropped, `Meeting ${dropped.id} with the owner (${mk.zone.weekdayMinute(new Date(dropped.at))}) is dropped: ${note}`);
    return EXIT.ok;
}
