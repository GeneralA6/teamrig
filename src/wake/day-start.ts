import { burstText } from '../budget/burst-lines.ts';
import type { Burst } from '../budget/burst.ts';
import { KIT_NAME } from '../core/home.ts';
import { MS_PER_DAY, MS_PER_MINUTE, utcMinuteOf } from '../core/time.ts';
import type { TimeZone } from '../core/zone.ts';
import type { Task } from '../register/fold.ts';
import type { TasksElsewhere } from '../register/tree.ts';
import { waitContext } from '../register/waits.ts';
import { byUrgency, costText, idsText, isWakeWorthy, taskListText, type SettledMoments, type WakeCost, type WakeRest } from './decide.ts';

/**
 * The day's moments, pure. A wake for handed work (decide.ts) never starts a session's day: a session idle since the
 * night stays idle while its list waits. So the day's start (`wake.dayStartUtc`) gives each session one turn, and so
 * does a burst the session is in, once it starts. A moment wakes a session once, only with work it can go on with (its
 * own task of any priority that `canGoOn`: open or in-progress, or waiting with every wait cleared or answered, and
 * past every task it comes after unless already started), never in quiet hours or while its budget holds or a short
 * day pauses it (`WakeRest`; it wakes once those end), and not at all when the session had a turn after the moment.
 * Nor while the login is expired (src/restore/login.ts), since every turn would fail on it; once it may work again,
 * one tab tests it for the moment (the day-start probe, src/restore/day-probe.ts) while the others wait for its reply.
 */

export type DayMomentKind = 'day-start' | 'burst';

/** A moment that gives each idle session one turn: the day's start, or the start of a burst the session is in. */
export type DayMoment = { readonly kind: 'day-start'; readonly at: number } | { readonly kind: 'burst'; readonly at: number; readonly burst: Burst };

/** The latest day start at or before `now`, epoch ms; undefined for a malformed time. */
export function dayStartAt(dayStartUtc: string, now: number): number | undefined {
  const minute = utcMinuteOf(dayStartUtc);
  if (minute === undefined) {
    return undefined;
  }
  const today = now - (now % MS_PER_DAY) + minute * MS_PER_MINUTE;
  return today <= now ? today : today - MS_PER_DAY;
}

/** The start of the team's current day, epoch ms: its latest `wake.dayStartUtc`, else (unset or malformed) midnight UTC. */
export function teamDayStartAt(dayStartUtc: string | undefined, now: number): number {
  return (dayStartUtc === undefined ? undefined : dayStartAt(dayStartUtc, now)) ?? now - (now % MS_PER_DAY);
}

/** The first day start after `now`, epoch ms; undefined for a malformed time. */
export function nextDayStartAt(dayStartUtc: string, now: number): number | undefined {
  const latest = dayStartAt(dayStartUtc, now);
  return latest === undefined ? undefined : latest + MS_PER_DAY;
}

/** The moments reached at `now` and not settled yet: the day start (when set) and the burst the session is in. */
export function dueMoments(now: number, dayStartUtc: string | undefined, burst: Burst | undefined, settled: SettledMoments): readonly DayMoment[] {
  const due: DayMoment[] = [];
  const dayStart = dayStartUtc === undefined ? undefined : dayStartAt(dayStartUtc, now);
  if (dayStart !== undefined && (settled.dayStart ?? Number.NEGATIVE_INFINITY) < dayStart) {
    due.push({ kind: 'day-start', at: dayStart });
  }
  if (burst !== undefined && burst.at <= now && settled.burst !== burst.at) {
    due.push({ kind: 'burst', at: burst.at, burst });
  }
  return due;
}

/**
 * The session's work it can go on with now (`canGoOn`) at `maxPriority` or more urgent (any by default), most urgent
 * first; a wait or an `after` may name a task the team tree's other registers hold (`elsewhere`).
 */
export function startableTasks(
  tasks: ReadonlyMap<string, Task>,
  elsewhere: TasksElsewhere,
  session: string,
  now: number,
  zone: TimeZone,
  maxPriority = Number.POSITIVE_INFINITY,
): readonly Task[] {
  const context = waitContext(tasks, new Date(now), zone, elsewhere);
  return [...tasks.values()].filter((task) => isWakeWorthy(task, session, maxPriority, context)).sort(byUrgency);
}

/**
 * The login as the moments see it: working (or not known to fail), expired with nothing since that says it may work
 * again, or under test by another tab's probe, to check again at `recheckAt`.
 */
export type DayStartLogin = { readonly kind: 'ok' } | { readonly kind: 'expired' } | { readonly kind: 'probing'; readonly recheckAt: number };

export interface DayStartInput {
  readonly due: readonly DayMoment[];
  /** The session's work it can start now, most urgent first. */
  readonly startable: readonly Task[];
  /** When the session's tab last wrote its transcript (its last turn), epoch ms; undefined: none known. */
  readonly lastTurnAt: number | undefined;
  readonly rest: WakeRest;
  readonly now: number;
  readonly lastWakeAt: number | undefined;
  readonly minGapMs: number;
  readonly settled: SettledMoments;
  readonly login: DayStartLogin;
}

export type DayStartVerdict =
  | { readonly kind: 'none' }
  | { readonly kind: 'later'; readonly at: number }
  | { readonly kind: 'wake'; readonly moments: readonly DayMoment[]; readonly tasks: readonly Task[] };

export interface DayStartDecision {
  readonly verdict: DayStartVerdict;
  readonly settled: SettledMoments;
}

function settle(settled: SettledMoments, moments: readonly DayMoment[]): SettledMoments {
  return moments.reduce<SettledMoments>((kept, moment) => (moment.kind === 'day-start' ? { ...kept, dayStart: moment.at } : { ...kept, burst: moment.at }), settled);
}

/**
 * Whether the due moments wake the session now, later or not, and what is settled. A moment the session had a turn
 * after is settled with no wake. The rest wake it at once, together, unless it rests (quiet hours, held by its
 * budget), has no work it can start or the login is expired: then they stay due for a later check. Wakes stay
 * `wake.minGapMinutes` apart, and while another tab's probe tests the login they wait for it until `recheckAt`.
 */
export function decideDayStart(input: DayStartInput): DayStartDecision {
  const { due, lastTurnAt, rest, now, login } = input;
  const hadTurn = (moment: DayMoment): boolean => lastTurnAt !== undefined && lastTurnAt >= moment.at;
  const settled = settle(input.settled, due.filter(hadTurn));
  const open = due.filter((moment) => !hadTurn(moment));
  if (open.length === 0 || rest.quiet || rest.held || input.startable.length === 0 || login.kind === 'expired') {
    return { verdict: { kind: 'none' }, settled };
  }
  const gapEnd = input.lastWakeAt === undefined ? Number.NEGATIVE_INFINITY : input.lastWakeAt + input.minGapMs;
  if (now < gapEnd) {
    return { verdict: { kind: 'later', at: gapEnd }, settled };
  }
  if (login.kind === 'probing') {
    return { verdict: { kind: 'later', at: login.recheckAt }, settled };
  }
  return { verdict: { kind: 'wake', moments: open, tasks: input.startable }, settled: settle(settled, open) };
}

function momentLine(moment: DayMoment, name: string, zone: TimeZone): string {
  return moment.kind === 'day-start'
    ? `The day started at ${zone.clock(new Date(moment.at))} and this tab has had no turn since.`
    : `The lead started ${burstText(moment.burst, [name], zone, moment.burst.dailyPct)}`;
}

/** The prompt the session reads, under the plugin's name; `name` is the session's name in the burst's line. */
export function dayStartPrompt(session: string, name: string, moments: readonly DayMoment[], tasks: readonly Task[], cost: WakeCost, zone: TimeZone): string {
  return [
    ...moments.map((moment) => momentLine(moment, name, zone)),
    `Work you can start: ${taskListText(tasks)}.`,
    `Start a work block (\`${KIT_NAME} start --session ${session}\`) and work your list in priority order. This wake costs ${costText(cost)}.`,
  ].join(' ');
}

const MOMENT_NAMES: Readonly<Record<DayMomentKind, string>> = { 'day-start': 'the day start', burst: 'the burst' };

/** The person's toast: which moments woke the tab, for which tasks, and what it costs. */
export function dayStartToast(moments: readonly DayMoment[], tasks: readonly Task[], cost: WakeCost): string {
  const why = moments.map((moment) => MOMENT_NAMES[moment.kind]).join(' and ');
  return `${KIT_NAME} woke this tab for ${why}: ${idsText(tasks)} (${costText(cost)})`;
}
