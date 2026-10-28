import type { Roster } from '../../config/roster.ts';
import type { KitConfig } from '../../config/types.ts';
import { KIT_NAME } from '../../core/home.ts';
import { FileLock } from '../../core/lock.ts';
import { SecretScanner } from '../../core/secrets.ts';
import type { TimeZone } from '../../core/zone.ts';
import { postLines } from '../../inbox/inbox.ts';
import {
  ABOUT_MAX,
  byTime,
  DEFAULT_MEETING_MINUTES,
  isMeetingId,
  isMissed,
  isOpenMeeting,
  MeetingSchedule,
  nextMeetingId,
  type MeetingsRead,
  type MeetingStatus,
  type ScheduledMeeting,
} from '../../meeting/schedule.ts';
import { noPositionals, onePositional, requiredFlag, UsageError, type ParsedArgs } from '../args.ts';
import { callerOf, instantOf, listOf, taskIdOf } from '../inputs.ts';
import { openTeamKit, requireConfig, rosterOf, sessionIdOf, teamZone, type Access, type Kit } from '../kit.ts';
import { EXIT, RefusedError, type CliRuntime, type ExitCode } from '../runtime.ts';
import { inboxDepsOf } from './inbox.ts';
import { ownRegister } from './register.ts';

/**
 * `meeting schedule|list|move|end <id>|drop` (T1358): the owner's meetings with one session at a set time, apart
 * from the daily meeting with the lead (meeting.ts). The lead or the session met books, moves, ends and drops one;
 * the session met and those joining get one inbox line when it is booked, moved or dropped. Every change is made
 * under the team's meetings lock, so two sessions never book one id.
 */

/** The longest meeting a schedule takes, in minutes: a working day. */
export const MEETING_MINUTES_MAX = 480;

interface MeetingsKit {
  readonly kit: Kit;
  readonly config: KitConfig;
  readonly roster: Roster;
  readonly caller: string;
  readonly schedule: MeetingSchedule;
  readonly lock: FileLock;
  readonly now: number;
  readonly zone: TimeZone;
}

async function meetingsKit(args: ParsedArgs, runtime: CliRuntime, access: Access): Promise<MeetingsKit> {
  const kit = await openTeamKit(runtime);
  const config = requireConfig(kit, runtime, access);
  const roster = await rosterOf(runtime, kit, config);
  const { files, clock, sleep, pid } = runtime;
  return {
    kit,
    config,
    roster,
    caller: sessionIdOf(roster, callerOf(args.flags, runtime.env)),
    schedule: new MeetingSchedule(files, kit.paths.meetings),
    lock: new FileLock(kit.paths.meetingsLock, config.lock, { files, clock, sleep, pid }),
    now: clock.now(),
    zone: teamZone(config, runtime),
  };
}

/** One meeting as a list line: its id, status (a scheduled one past its slot reads missed), time, length, sessions, tasks and what it is about. */
export function meetingLine(meeting: ScheduledMeeting, zone: TimeZone, now: number): string {
  const status = isMissed(meeting, now) ? 'missed' : meeting.status;
  const joining = meeting.with.length === 0 ? '' : ` with ${meeting.with.join(', ')}`;
  const tasks = meeting.tasks.length === 0 ? '' : `, tasks ${meeting.tasks.join(' ')}`;
  return `${meeting.id} ${status}, ${zone.weekdayMinute(new Date(meeting.at))}, ${meeting.minutes} min, ${meeting.session}${joining}${tasks} | ${meeting.about}`;
}

function detailLines(meeting: ScheduledMeeting): string[] {
  return [...(meeting.brief === null ? [] : [`    brief: ${meeting.brief}`]), ...(meeting.note === null ? [] : [`    note: ${meeting.note}`])];
}

/** A text flag that is one line, at most ABOUT_MAX characters and no secret. */
function lineOf(flag: string, text: string, secrets: SecretScanner): string {
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

function noteOf(text: string | undefined, secrets: SecretScanner): string | null {
  return text === undefined ? null : lineOf('--note', text, secrets);
}

function minutesOf(text: string | undefined): number {
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
function futureAt(text: string, mk: MeetingsKit): number {
  const at = instantOf('--at', text, { nowMs: mk.now, zone: mk.zone });
  if (at <= mk.now) {
    throw new RefusedError(`--at ${mk.zone.weekdayMinute(new Date(at))} is past: a meeting is booked ahead`);
  }
  return at;
}

/** The linked tasks, each a task of the team. */
async function tasksOf(runtime: CliRuntime, text: string | undefined): Promise<string[]> {
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
function mayChange(mk: MeetingsKit, session: string, what: string): void {
  const lead = mk.roster.holderOf('lead');
  if (mk.caller !== lead && mk.caller !== session) {
    throw new RefusedError(`only the lead${lead === undefined ? '' : ` (${mk.roster.nameOf(lead) ?? lead})`} or ${session}, the session met, may ${what}`);
  }
}

function meetingOf(read: MeetingsRead, id: string): ScheduledMeeting {
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
async function tell(runtime: CliRuntime, mk: MeetingsKit, meeting: ScheduledMeeting, text: string): Promise<void> {
  const receivers = [meeting.session, ...meeting.with].filter((session) => session !== mk.caller);
  if (receivers.length === 0) {
    return;
  }
  const { inboxes } = inboxDepsOf(runtime, mk.kit.paths);
  const problem = await postLines(
    receivers.map((to) => ({ inboxes, to, from: mk.caller })),
    new SecretScanner(mk.config.register.secretPatterns),
    { text, now: new Date(mk.now) },
  );
  runtime.out.stdout(problem === undefined ? `TOLD ${receivers.join(', ')}` : `NOT TOLD ${receivers.join(', ')}: ${problem}`);
}

function bookedText(meeting: ScheduledMeeting, zone: TimeZone): string {
  const tasks = meeting.tasks.length === 0 ? '' : `; tasks ${meeting.tasks.join(' ')}`;
  const brief = meeting.brief === null ? '' : `; brief ${meeting.brief}`;
  return `${zone.weekdayMinute(new Date(meeting.at))} (${meeting.minutes} min) with ${meeting.session}: ${meeting.about}${tasks}${brief}`;
}

/** `meeting schedule`: books a meeting and tells the session met and those joining. */
export async function meetingSchedule(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
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
    const booked: ScheduledMeeting = { id: nextMeetingId(await mk.schedule.read()), session, with: joining, ...fields, status: 'scheduled', notifiedAt: null, by: mk.caller, changedAt: mk.now, note: null };
    await mk.schedule.write(booked, mk.now);
    return booked;
  });
  runtime.out.stdout(`SCHEDULED ${meetingLine(meeting, mk.zone, mk.now)}`);
  await tell(runtime, mk, meeting, `Meeting ${meeting.id} with the owner booked: ${bookedText(meeting, mk.zone)}. At its time: ${KIT_NAME} meeting start ${meeting.id}`);
  return EXIT.ok;
}

/** `meeting list`: the scheduled and started meetings by time; `--all` adds those done or dropped in the last week; `--json` for the pane. */
export async function meetingList(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
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
async function change(args: ParsedArgs, mk: MeetingsKit, verb: string, from: readonly MeetingStatus[], next: (meeting: ScheduledMeeting) => ScheduledMeeting): Promise<ScheduledMeeting> {
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
export async function meetingMove(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  const mk = await meetingsKit(args, runtime, 'write');
  const at = futureAt(requiredFlag(args.flags, 'at'), mk);
  const note = noteOf(args.flags.get('note'), new SecretScanner(mk.config.register.secretPatterns));
  const moved = await change(args, mk, 'move', ['scheduled'], (meeting) => ({ ...meeting, at, notifiedAt: null, note: note ?? meeting.note }));
  runtime.out.stdout(`MOVED ${meetingLine(moved, mk.zone, mk.now)}`);
  await tell(runtime, mk, moved, `Meeting ${moved.id} with the owner moved: ${bookedText(moved, mk.zone)}${note === null ? '' : ` (${note})`}`);
  return EXIT.ok;
}

/** `meeting end <id>`: the meeting was held; scheduled or started, it is done. */
export async function meetingEndScheduled(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  const mk = await meetingsKit(args, runtime, 'write');
  const note = noteOf(args.flags.get('note'), new SecretScanner(mk.config.register.secretPatterns));
  const ended = await change(args, mk, 'end', ['scheduled', 'started'], (meeting) => ({ ...meeting, status: 'done', note: note ?? meeting.note }));
  runtime.out.stdout(`ENDED ${meetingLine(ended, mk.zone, mk.now)}`);
  return EXIT.ok;
}

/** `meeting drop <id> --note`: the meeting will not be held; those it would meet are told why. */
export async function meetingDrop(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  const mk = await meetingsKit(args, runtime, 'write');
  const note = lineOf('--note', requiredFlag(args.flags, 'note'), new SecretScanner(mk.config.register.secretPatterns));
  const dropped = await change(args, mk, 'drop', ['scheduled', 'started'], (meeting) => ({ ...meeting, status: 'dropped', note }));
  runtime.out.stdout(`DROPPED ${meetingLine(dropped, mk.zone, mk.now)}`);
  await tell(runtime, mk, dropped, `Meeting ${dropped.id} with the owner (${mk.zone.weekdayMinute(new Date(dropped.at))}) is dropped: ${note}`);
  return EXIT.ok;
}
