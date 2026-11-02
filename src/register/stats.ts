import { MS_PER_DAY } from '../core/time.ts';
import type { TimeZone } from '../core/zone.ts';
import type { MovedEvent, RegisterEvent } from './events.ts';
import { foldEvents, type Task } from './fold.ts';
import { GITHUB_SOURCE, type TaskStatus } from './model.ts';
import { waitsOnOwner } from './owner-waits.ts';
import { dueTime } from './views.ts';
import type { WaitKind } from './waits.ts';

/**
 * The register's numbers over time (T1771, the core half of the pane's Stats tab, T1419): each day's flow, where new
 * work comes from, lead and cycle times, due-date hits, waits, bugs and done per session, for the teams handed in (a
 * tree rolled up) over a range of the team's calendar days. The tab and `teamrig stats` read this one fold, so they
 * never disagree. Pure, with no node: import, so the pane vendors it (src/read/index.ts).
 *
 * A task that moved to another team (T1144) counts in the team that holds it now: the team it left drops every event
 * of it, and the split shows as a {@link Split}. Times are in days, fractional; a day is a calendar day of the zone.
 */

/**
 * The ranges (T1865, the owner's list): the last 7, 30, 90, 180 or 365 calendar days, today included, or every day
 * since the first task was created. A long range reads the archived history, since the fold takes each team's whole log.
 */
export const STATS_RANGES = ['7d', '30d', '90d', '180d', '1y', 'all'] as const;

export type StatsRange = (typeof STATS_RANGES)[number];

export function isStatsRange(value: unknown): value is StatsRange {
  return STATS_RANGES.some((range) => range === value);
}

/** The calendar days each range but `all` counts, today included: `1y` is 365 of them. */
export const STATS_RANGE_DAYS: Readonly<Record<Exclude<StatsRange, 'all'>, number>> = { '7d': 7, '30d': 30, '90d': 90, '180d': 180, '1y': 365 };

/** The days the recent net covers whatever the range: 4 weeks, so one quiet week does not swing the backlog's trend. */
export const RECENT_DAYS = 28;

/** The active statuses as a tuple, each with its own count; a spec holds them equal to model.ts's ACTIVE_STATUSES. */
export const STATS_ACTIVE_STATUSES = ['open', 'in-progress', 'verifying', 'waiting'] as const satisfies readonly TaskStatus[];

export type ActiveStatus = (typeof STATS_ACTIVE_STATUSES)[number];

export function isActive(status: TaskStatus): status is ActiveStatus {
  return STATS_ACTIVE_STATUSES.some((active) => active === status);
}

export type ActiveCounts = Readonly<Record<ActiveStatus, number>>;

export interface StatsTeam {
  readonly team: string;
  /** The team's lead session (`roles.lead`), whose asks count as the lead's; null when the config names none. */
  readonly lead: string | null;
  /** The team's whole event log in write order: its archive segments, then its live log. */
  readonly events: readonly RegisterEvent[];
}

/** One session's numbers: the tasks it owns now in its team; other teams' tasks count for none. */
export interface StatsScope {
  readonly team: string;
  readonly session: string;
}

export interface StatsInput {
  readonly teams: readonly StatsTeam[];
  readonly range: StatsRange;
  readonly now: Date;
  readonly zone: TimeZone;
  /** The config's `register.ownerSource`: a task with this source is the owner's ask. */
  readonly ownerMarker: string;
  readonly session?: StatsScope;
  /** The stretches the account's week sat at its usage limit (budget/extra.ts `limitSpansOf`); none when unread. */
  readonly limits?: readonly LimitSpan[];
}

/** A stretch the account's week sat at its usage limit, in ms: from its 100% crossing up to, not including, `end`. */
export interface LimitSpan {
  readonly start: number;
  readonly end: number;
}

export interface StatsDay {
  /** `YYYY-MM-DD` on the zone's calendar. */
  readonly day: string;
  readonly opened: number;
  /** Closes from an active status that day: a task reopened and closed again counts at each close. */
  readonly done: number;
  readonly dropped: number;
  /** The active tasks in each status at the day's end. */
  readonly active: ActiveCounts;
  /** True when the week sat at its usage limit for part of the day (the `$` mark): its quiet is no slack. */
  readonly atLimit: boolean;
}

/** Durations in days: the median and the 85th percentile, linearly interpolated; null with no durations. */
export interface Spread {
  readonly count: number;
  readonly median: number | null;
  readonly p85: number | null;
}

export interface TeamPart {
  readonly active: number;
  /** Created to done, over the tasks done in the range. */
  readonly leadTime: Spread;
  /** First in progress (or verifying) to done, over the tasks done in the range that were ever started. */
  readonly cycleTime: Spread;
  /** The active tasks past their due date now, and how many of them are p1. */
  readonly overdue: { readonly count: number; readonly p1: number };
  /** The tasks done in the range that had a due date, and how many of them were done by it. */
  readonly due: { readonly total: number; readonly onTime: number };
}

export interface TeamStats extends TeamPart {
  readonly team: string;
}

export interface Band {
  readonly label: string;
  readonly count: number;
}

/**
 * Who asked for new work: its owner (self-made), the human owner, the team's lead, a GitHub issue, or another
 * session; checked in that order.
 */
export const WORK_SOURCES = ['self', 'owner', 'lead', 'github', 'session'] as const;

export type WorkSource = (typeof WORK_SOURCES)[number];

/** The tasks created in the range. A task with two goals counts once under each. */
export interface NewWork {
  readonly total: number;
  readonly bySource: Readonly<Record<WorkSource, number>>;
  readonly bugs: number;
  /** Most urgent first. */
  readonly byPriority: readonly { readonly priority: number; readonly count: number }[];
  /** Most tasks first, then by name. */
  readonly byGoal: readonly { readonly goal: string; readonly count: number }[];
  readonly noGoal: number;
}

export interface WaitStats {
  readonly waiting: number;
  /** The waiting tasks with a reason of each kind: a task waiting on two kinds counts under both, on one kind twice once. */
  readonly byKind: Readonly<Record<WaitKind, number>>;
  /** The active tasks waiting, or whose proof waits, on the owner's decision or approval, and the longest such wait. */
  readonly ownerDecisions: { readonly count: number; readonly oldestDays: number | null };
}

export interface BugStats {
  readonly active: number;
  /** Bugs created in the range. */
  readonly opened: number;
  /** Bugs done in the range. */
  readonly fixed: number;
}

/** The tasks a session closed done in the range, in one team. */
export interface PersonDone {
  readonly team: string;
  readonly session: string;
  readonly done: number;
}

/** The tasks that moved from one team to another on a day (a team split, T1144): a team's chart before it lacks them. */
export interface Split {
  readonly day: string;
  readonly from: string;
  readonly to: string;
  readonly tasks: number;
}

export interface RegisterStats {
  readonly range: StatsRange;
  readonly days: readonly StatsDay[];
  /** Tasks created in the range. */
  readonly opened: number;
  /** Tasks done or dropped now whose close fell in the range: each task once. */
  readonly closedTasks: number;
  readonly droppedTasks: number;
  /** `opened - closedTasks`: what the backlog grew by. */
  readonly net: number;
  /** Every close in the range ({@link StatsDay.done} and dropped summed): a task closed twice counts twice. */
  readonly closes: number;
  /** The net over the last RECENT_DAYS days, whatever the range. */
  readonly recent: { readonly days: number; readonly net: number };
  /** The active tasks now. */
  readonly active: ActiveCounts;
  readonly all: TeamPart;
  /** Each team handed in (only the scope's team for a session's numbers), in the order given. */
  readonly teams: readonly TeamStats[];
  readonly newWork: NewWork;
  /** The active tasks by age since created. */
  readonly activeByAge: readonly Band[];
  /** Tasks done in the range that were never in progress or verifying: the cycle time leaves them out. */
  readonly neverStarted: number;
  /** The tasks done late in the range by whole days late, rounded up. */
  readonly lateDays: readonly Band[];
  /** Tasks whose set due date was changed or cleared in the range: a due set for the first time is no move. */
  readonly dueMoved: number;
  readonly waits: WaitStats;
  readonly bugs: BugStats;
  /** Most done first, then by team and session. */
  readonly people: readonly PersonDone[];
  /** Oldest first. */
  readonly splits: readonly Split[];
}

const TOP_PRIORITY = 1;

const AGE_BANDS: readonly BandLimit[] = [
  { label: '<2 d', below: 2 },
  { label: '2-7 d', below: 7 },
  { label: '7-14 d', below: 14 },
  { label: '14+ d', below: Number.POSITIVE_INFINITY },
];

const LATE_BANDS: readonly BandLimit[] = [
  { label: '1 d', below: 2 },
  { label: '2-3 d', below: 4 },
  { label: '4+ d', below: Number.POSITIVE_INFINITY },
];

/** A value falls in the first band it is below. */
interface BandLimit {
  readonly label: string;
  readonly below: number;
}

/** A task as one team holds it, with that team's lead. */
interface Held {
  readonly team: string;
  readonly lead: string | null;
  readonly task: Task;
}

interface FoldedTeam {
  readonly team: string;
  /** Its events but those of the tasks that moved away. */
  readonly kept: readonly RegisterEvent[];
  /** The ids of the tasks in scope. */
  readonly ids: ReadonlySet<string>;
  readonly held: readonly Held[];
  readonly moves: readonly MovedEvent[];
}

/** Instants in ms, from `start` up to, not including, `end`. */
interface Window {
  readonly start: number;
  readonly end: number;
}

interface DaySpan extends Window {
  readonly day: string;
}

interface Clock {
  readonly now: number;
  readonly zone: TimeZone;
  readonly window: Window;
}

export function registerStats(input: StatsInput): RegisterStats {
  const { zone, ownerMarker, session } = input;
  const now = input.now.getTime();
  const teams = input.teams.map((team) => foldTeam(team, session));
  const held = teams.flatMap((team) => team.held);
  const today = calendarDay(input.now, zone);
  const first = Math.min(today, input.range === 'all' ? (firstCreatedDay(held, zone) ?? today) : today - (STATS_RANGE_DAYS[input.range] - 1) * MS_PER_DAY);
  const clock: Clock = { now, zone, window: dayWindow(first, today, zone) };
  const series = new DaySeries(daySpans(first, today, zone), clock.window.end);
  const dueMoved = teams.reduce((count, team) => count + sweep(team, series, clock.window), 0);
  const days = series.days(input.limits ?? []);
  const tasks = held.map((each) => each.task);
  const active = tasks.filter((task) => isActive(task.status));
  const created = held.filter((each) => within(clock.window, each.task.createdAt));
  const closed = tasks.filter((task) => closedIn(task, clock.window));
  const done = held.filter((each) => doneIn(each.task, clock.window));
  const recent = dayWindow(today - (RECENT_DAYS - 1) * MS_PER_DAY, today, zone);
  return {
    range: input.range,
    days,
    opened: created.length,
    closedTasks: closed.length,
    droppedTasks: closed.filter((task) => task.status === 'dropped').length,
    net: created.length - closed.length,
    closes: days.reduce((sum, day) => sum + day.done + day.dropped, 0),
    recent: { days: RECENT_DAYS, net: tasks.filter((task) => within(recent, task.createdAt)).length - tasks.filter((task) => closedIn(task, recent)).length },
    active: activeRecord((status) => active.filter((task) => task.status === status).length),
    all: teamPart(held, clock),
    teams: teams.filter((team) => session === undefined || team.team === session.team).map((team) => ({ team: team.team, ...teamPart(team.held, clock) })),
    newWork: newWork(created, ownerMarker),
    activeByAge: banded(
      active.map((task) => (now - Date.parse(task.createdAt)) / MS_PER_DAY),
      AGE_BANDS,
    ),
    neverStarted: done.filter((each) => each.task.startedAt === null).length,
    lateDays: banded(
      dated(done.map((each) => each.task), zone).flatMap(({ closedAt, due }) => (closedAt > due ? [Math.ceil((closedAt - due) / MS_PER_DAY)] : [])),
      LATE_BANDS,
    ),
    dueMoved,
    waits: waitStats(active, ownerMarker, now),
    bugs: {
      active: active.filter((task) => task.type === 'bug').length,
      opened: created.filter((each) => each.task.type === 'bug').length,
      fixed: done.filter((each) => each.task.type === 'bug').length,
    },
    people: people(done),
    splits: splitsOf(teams, zone),
  };
}

/** A team's tasks in scope, from its events without those of the tasks that moved away. */
function foldTeam(team: StatsTeam, scope: StatsScope | undefined): FoldedTeam {
  const moves = team.events.filter((event): event is MovedEvent => event.type === 'moved');
  const movedIds = new Set(moves.map((event) => event.id));
  const kept = team.events.filter((event) => !movedIds.has(event.id));
  const tasks = [...foldEvents(kept).tasks.values()].filter((task) => scope === undefined || (scope.team === team.team && task.owner === scope.session));
  return { team: team.team, kept, ids: new Set(tasks.map((task) => task.id)), held: tasks.map((task) => ({ team: team.team, lead: team.lead, task })), moves };
}

/**
 * Replays a team's kept events of the tasks in scope into the day series, as the fold reads them (a second create
 * is ignored, a status the task already has is no move), and returns how many of them moved their due date in the
 * window.
 */
function sweep(team: FoldedTeam, series: DaySeries, window: Window): number {
  const statuses = new Map<string, TaskStatus>();
  const dues = new Map<string, string | null>();
  const dueMoved = new Set<string>();
  for (const event of team.kept) {
    if (!team.ids.has(event.id)) {
      continue;
    }
    const at = Date.parse(event.at);
    const status = statuses.get(event.id);
    if (event.type === 'create') {
      if (status === undefined) {
        statuses.set(event.id, 'open');
        dues.set(event.id, event.task.due);
        series.created(at);
      }
    } else if (status !== undefined && event.type === 'status' && event.status !== status) {
      series.moved(at, status, event.status);
      statuses.set(event.id, event.status);
    } else if (status !== undefined && event.type === 'update' && event.changes.due !== undefined) {
      const before = dues.get(event.id) ?? null;
      if (before !== null && event.changes.due !== before && at >= window.start && at < window.end) {
        dueMoved.add(event.id);
      }
      dues.set(event.id, event.changes.due);
    }
  }
  return dueMoved.size;
}

interface DayCounts {
  opened: number;
  done: number;
  dropped: number;
  /** What each active status gained (or lost) that day. */
  readonly moves: Record<ActiveStatus, number>;
}

/** Each day's creations, closes and moves between statuses; what happened before the first day is its base. */
class DaySeries {
  private readonly spans: readonly DaySpan[];
  private readonly end: number;
  private readonly counts: readonly DayCounts[];
  private readonly base: Record<ActiveStatus, number> = activeRecord(() => 0);

  constructor(spans: readonly DaySpan[], end: number) {
    this.spans = spans;
    this.end = end;
    this.counts = spans.map(() => ({ opened: 0, done: 0, dropped: 0, moves: activeRecord(() => 0) }));
  }

  created(at: number): void {
    const index = this.dayIndex(at);
    const moves = this.movesAt(index);
    if (moves !== undefined) {
      moves.open += 1;
    }
    const day = this.counts[index];
    if (day !== undefined) {
      day.opened += 1;
    }
  }

  moved(at: number, from: TaskStatus, to: TaskStatus): void {
    const index = this.dayIndex(at);
    const moves = this.movesAt(index);
    if (moves === undefined) {
      return;
    }
    if (isActive(from)) {
      moves[from] -= 1;
    }
    if (isActive(to)) {
      moves[to] += 1;
    }
    const day = this.counts[index];
    if (day !== undefined && isActive(from)) {
      day.done += to === 'done' ? 1 : 0;
      day.dropped += to === 'dropped' ? 1 : 0;
    }
  }

  /** The days in order, each marked when one of `limits` overlaps it. */
  days(limits: readonly LimitSpan[]): StatsDay[] {
    const running = { ...this.base };
    return this.spans.map((span, index) => {
      const day = this.counts[index];
      for (const status of STATS_ACTIVE_STATUSES) {
        running[status] += day?.moves[status] ?? 0;
      }
      const atLimit = limits.some((limit) => limit.start < span.end && limit.end > span.start);
      return { day: span.day, opened: day?.opened ?? 0, done: day?.done ?? 0, dropped: day?.dropped ?? 0, active: { ...running }, atLimit };
    });
  }

  /** The base before the first day; none from the last day's end on. */
  private movesAt(index: number): Record<ActiveStatus, number> | undefined {
    return index < 0 ? this.base : this.counts[index]?.moves;
  }

  /** The day an instant falls on: -1 before the first, the day count from the last one's end on. */
  private dayIndex(at: number): number {
    if (at >= this.end) {
      return this.spans.length;
    }
    let low = -1;
    let high = this.spans.length - 1;
    while (low < high) {
      const middle = Math.floor((low + high + 1) / 2);
      const start = this.spans[middle]?.start;
      if (start !== undefined && start <= at) {
        low = middle;
      } else {
        high = middle - 1;
      }
    }
    return low;
  }
}

function teamPart(held: readonly Held[], clock: Clock): TeamPart {
  const tasks = held.map((each) => each.task);
  const done = tasks.filter((task) => doneIn(task, clock.window));
  const overdue = tasks.filter((task) => {
    const due = dueTime(task, clock.zone);
    return isActive(task.status) && due !== undefined && due < clock.now;
  });
  const withDue = dated(done, clock.zone);
  return {
    active: tasks.filter((task) => isActive(task.status)).length,
    leadTime: spread(done.map((task) => daysBetween(task.createdAt, task.statusAt))),
    cycleTime: spread(done.flatMap((task) => (task.startedAt === null ? [] : [daysBetween(task.startedAt, task.statusAt)]))),
    overdue: { count: overdue.length, p1: overdue.filter((task) => task.priority === TOP_PRIORITY).length },
    due: { total: withDue.length, onTime: withDue.filter(({ closedAt, due }) => closedAt <= due).length },
  };
}

function newWork(created: readonly Held[], ownerMarker: string): NewWork {
  const bySource: Record<WorkSource, number> = { self: 0, owner: 0, lead: 0, github: 0, session: 0 };
  created.forEach((each) => {
    bySource[sourceOf(each, ownerMarker)] += 1;
  });
  const tasks = created.map((each) => each.task);
  return {
    total: created.length,
    bySource,
    bugs: tasks.filter((task) => task.type === 'bug').length,
    byPriority: [...tally(tasks.map((task) => task.priority))].map(([priority, count]) => ({ priority, count })).sort((a, b) => a.priority - b.priority),
    byGoal: [...tally(tasks.flatMap((task) => [...new Set(task.goals)]))].map(([goal, count]) => ({ goal, count })).sort((a, b) => b.count - a.count || byText(a.goal, b.goal)),
    noGoal: tasks.filter((task) => task.goals.length === 0).length,
  };
}

function sourceOf({ task, lead }: Held, ownerMarker: string): WorkSource {
  if (task.source === task.owner) {
    return 'self';
  }
  if (task.source === ownerMarker) {
    return 'owner';
  }
  if (task.source === lead) {
    return 'lead';
  }
  return task.source === GITHUB_SOURCE ? 'github' : 'session';
}

function waitStats(active: readonly Task[], ownerMarker: string, now: number): WaitStats {
  const waiting = active.filter((task) => task.status === 'waiting');
  const byKind: Record<WaitKind, number> = { decision: 0, approval: 0, task: 0, time: 0 };
  for (const task of waiting) {
    for (const kind of new Set(task.waits.map((reason) => reason.kind))) {
      byKind[kind] += 1;
    }
  }
  const onOwner = active.filter((task) => waitsOnOwner(task, ownerMarker));
  const oldestDays = onOwner.reduce<number | null>((oldest, task) => Math.max(oldest ?? 0, (now - Date.parse(task.statusAt)) / MS_PER_DAY), null);
  return { waiting: waiting.length, byKind, ownerDecisions: { count: onOwner.length, oldestDays } };
}

function people(done: readonly Held[]): PersonDone[] {
  const counts = new Map<string, PersonDone>();
  for (const { team, task } of done) {
    const key = JSON.stringify([team, task.owner]);
    counts.set(key, { team, session: task.owner, done: (counts.get(key)?.done ?? 0) + 1 });
  }
  return [...counts.values()].sort((a, b) => b.done - a.done || byText(a.team, b.team) || byText(a.session, b.session));
}

function splitsOf(teams: readonly FoldedTeam[], zone: TimeZone): Split[] {
  const splits = new Map<string, { readonly day: string; readonly from: string; readonly to: string; readonly ids: Set<string> }>();
  for (const team of teams) {
    for (const move of team.moves) {
      const day = zone.day(new Date(move.at));
      const key = JSON.stringify([day, team.team, move.to]);
      const split = splits.get(key) ?? { day, from: team.team, to: move.to, ids: new Set<string>() };
      split.ids.add(move.id);
      splits.set(key, split);
    }
  }
  return [...splits.values()]
    .map(({ day, from, to, ids }) => ({ day, from, to, tasks: ids.size }))
    .sort((a, b) => byText(a.day, b.day) || byText(a.from, b.from) || byText(a.to, b.to));
}

function doneIn(task: Task, window: Window): boolean {
  return task.status === 'done' && within(window, task.statusAt);
}

function closedIn(task: Task, window: Window): boolean {
  return (task.status === 'done' || task.status === 'dropped') && within(window, task.statusAt);
}

function within(window: Window, at: string): boolean {
  const ms = Date.parse(at);
  return ms >= window.start && ms < window.end;
}

/** The closed tasks that had a due date, with when they closed and that due, in ms. */
function dated(tasks: readonly Task[], zone: TimeZone): { readonly closedAt: number; readonly due: number }[] {
  return tasks.flatMap((task) => {
    const due = dueTime(task, zone);
    return due === undefined ? [] : [{ closedAt: Date.parse(task.statusAt), due }];
  });
}

function daysBetween(from: string, to: string): number {
  return (Date.parse(to) - Date.parse(from)) / MS_PER_DAY;
}

function spread(values: readonly number[]): Spread {
  const sorted = [...values].sort((a, b) => a - b);
  return { count: sorted.length, median: quantile(sorted, 0.5), p85: quantile(sorted, 0.85) };
}

/** The `q` quantile of sorted values, linearly interpolated between the two nearest; null with none. */
function quantile(sorted: readonly number[], q: number): number | null {
  const position = q * (sorted.length - 1);
  const below = sorted[Math.floor(position)];
  const above = sorted[Math.ceil(position)];
  return below === undefined || above === undefined ? null : below + (above - below) * (position - Math.floor(position));
}

function banded(values: readonly number[], bands: readonly BandLimit[]): Band[] {
  const bandOf = (value: number): number => bands.findIndex((band) => value < band.below);
  return bands.map((band, index) => ({ label: band.label, count: values.filter((value) => bandOf(value) === index).length }));
}

function tally<K>(keys: readonly K[]): Map<K, number> {
  const counts = new Map<K, number>();
  keys.forEach((key) => counts.set(key, (counts.get(key) ?? 0) + 1));
  return counts;
}

function activeRecord(count: (status: ActiveStatus) => number): Record<ActiveStatus, number> {
  return { open: count('open'), 'in-progress': count('in-progress'), verifying: count('verifying'), waiting: count('waiting') };
}

function byText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A calendar day of the zone as the ms of its UTC midnight, so days step by MS_PER_DAY whatever the clock change. */
function calendarDay(at: Date, zone: TimeZone): number {
  const wall = zone.wall(at);
  return Date.UTC(wall.year, wall.month - 1, wall.day);
}

function firstCreatedDay(held: readonly Held[], zone: TimeZone): number | undefined {
  const first = held.reduce<number | undefined>((min, each) => Math.min(min ?? Number.POSITIVE_INFINITY, Date.parse(each.task.createdAt)), undefined);
  return first === undefined ? undefined : calendarDay(new Date(first), zone);
}

/** When the zone's clock shows 00:00 on a calendar day. */
function midnight(day: number, zone: TimeZone): number {
  const date = new Date(day);
  return zone.instant({ year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(), hour: 0, minute: 0 }).getTime();
}

/** From the start of calendar day `first` to the end of `last`. */
function dayWindow(first: number, last: number, zone: TimeZone): Window {
  return { start: midnight(first, zone), end: midnight(last + MS_PER_DAY, zone) };
}

function daySpans(first: number, last: number, zone: TimeZone): DaySpan[] {
  const spans: DaySpan[] = [];
  let start = midnight(first, zone);
  for (let day = first; day <= last; day += MS_PER_DAY) {
    const end = midnight(day + MS_PER_DAY, zone);
    spans.push({ day: new Date(day).toISOString().slice(0, 10), start, end });
    start = end;
  }
  return spans;
}
