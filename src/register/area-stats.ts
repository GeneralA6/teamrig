import { median } from '../core/quantile.ts';
import { MS_PER_DAY } from '../core/time.ts';
import type { TimeZone } from '../core/zone.ts';
import type { RegisterEvent } from './events.ts';
import { RegisterFold, type Task } from './fold.ts';
import { ACTIVE_STATUSES, isTopPriority } from './model.ts';
import type { HealthLevel } from './stats-health.ts';
import type { StatsTask } from './stats.ts';
import { dueTime } from './views.ts';

/**
 * Where the trouble sits (T1866, the core half of the pane's Bottlenecks section): each team and session on five
 * measures, each cell held against the other areas and against the area's own usual. Raw counts follow size, so the
 * lead would top every column on the first test alone: red needs both tests, amber one. The tab and `teamrig stats`
 * read this one fold, so they never disagree. Pure, with no node: import, so the pane vendors it (src/read/index.ts).
 */

export const AREA_MEASURES = ['bugs', 'p1', 'p1Late', 'low', 'waits'] as const;

export type AreaMeasure = (typeof AREA_MEASURES)[number];

export const AREA_MEASURE_LABELS: Readonly<Record<AreaMeasure, string>> = { bugs: 'bugs', p1: 'p1', p1Late: 'p1 late', low: 'low', waits: 'waits' };

/** The defaults the owner can change (T1866 design, section 5). */
export const AREA_THRESHOLDS = {
  /** High against the others means in this top share of the areas, rounded up, ties with the last one included... */
  topShare: 0.25,
  /** ...and at least this many times their median... */
  overMedian: 2,
  /** ...or, for the low share, at least this many points over theirs: a share has no useful multiple. */
  lowPoints: 15,
  /** High against its own usual means at least this many times it. */
  overUsual: 1.5,
  /** The day-ends the usual is the median of. */
  usualDays: 30,
  /** A task waiting longer than this many days is a long wait. */
  waitDays: 3,
  /** The priority number from which a task is low priority: p3 and below. */
  lowPriority: 3,
} as const;

export interface AreaCell {
  /** The count now; for `low`, the low-priority share of the area's active tasks in whole percent, never a count. */
  readonly value: number;
  /** The median of the same value at each day-end before today. */
  readonly usual: number;
  /** Red (`bad`) when high against both the others and the usual, amber (`warn`) against one. */
  readonly level: HealthLevel;
  /** The very tasks behind the value, for a press to list: never a copy of its filter, which would drift from it. */
  readonly tasks: readonly StatsTask[];
}

export interface AreaStats {
  readonly team: string;
  /** Null for a whole team, its sessions summed. */
  readonly session: string | null;
  readonly active: number;
  readonly cells: Readonly<Record<AreaMeasure, AreaCell>>;
}

export interface AreaGroup {
  /** The areas with active tasks now: most red cells first, then most amber, most active, then by name. */
  readonly areas: readonly AreaStats[];
  /** The middle area on each measure and on its active tasks; 0 with no area. */
  readonly median: Readonly<Record<AreaMeasure | 'active', number>>;
}

/** Teams are held against teams and sessions against sessions: a team's sum would always top a session. */
export interface RegisterAreas {
  /** Empty unless more than one team is in scope. */
  readonly teams: AreaGroup;
  readonly sessions: AreaGroup;
}

export interface AreaTeam {
  readonly team: string;
  /** Its events in write order, without those of the tasks that moved away. */
  readonly kept: readonly RegisterEvent[];
  /** Its active tasks now in scope: a session's numbers hold only that session's. */
  readonly active: readonly StatsTask[];
}

export interface AreaInput {
  readonly teams: readonly AreaTeam[];
  readonly now: number;
  readonly zone: TimeZone;
  /** The instants the usual is read at, ascending: the days before today, so a spike today cannot lift its own usual. */
  readonly dayEnds: readonly number[];
}

/** An area's raw counts at one moment: `low` is a count here, so a team sums its sessions before it takes the share. */
type Counts = Record<AreaMeasure | 'active', number>;

/** What each measure counts, read for the tasks now and at each past day-end, so the two cannot differ. */
const COUNTED: Readonly<Record<AreaMeasure, (task: Task, at: number, zone: TimeZone) => boolean>> = {
  bugs: (task) => task.type === 'bug',
  p1: (task) => isTopPriority(task.priority),
  p1Late: (task, at, zone) => isTopPriority(task.priority) && (dueTime(task, zone) ?? at) < at,
  low: (task) => task.priority >= AREA_THRESHOLDS.lowPriority,
  waits: (task, at) => task.status === 'waiting' && at - Date.parse(task.statusAt) > AREA_THRESHOLDS.waitDays * MS_PER_DAY,
};

/** A team with its counts by owner at each day-end. */
interface ReplayedTeam {
  readonly team: AreaTeam;
  readonly days: readonly ReadonlyMap<string, Counts>[];
}

/** An area before it is held against its peers. */
interface Placed {
  readonly team: string;
  readonly session: string | null;
  readonly tasks: readonly StatsTask[];
  /** Its counts at each day-end. */
  readonly days: readonly Counts[];
}

type MeasuredCell = Omit<AreaCell, 'level'>;

export function areaStats({ teams, now, zone, dayEnds }: AreaInput): RegisterAreas {
  const replayed = teams.map((team) => ({ team, days: dayEndCounts(team.kept, dayEnds, zone) }));
  const wholeTeams = teams.length > 1 ? replayed.filter(({ team }) => team.active.length > 0).map(wholeTeam) : [];
  return { teams: groupOf(wholeTeams, now, zone), sessions: groupOf(replayed.flatMap(teamSessions), now, zone) };
}

/**
 * The areas that stand out: those with a red cell. Red needs peers, so a lone area stands out by an amber one, else a
 * session's own numbers could never show it above its usual.
 */
export function standingOut({ areas }: AreaGroup): AreaStats[] {
  const mark: HealthLevel = areas.length > 1 ? 'bad' : 'warn';
  return areas.filter((area) => cellsAt(area, mark) > 0);
}

/**
 * The log replayed once, stopping at each day-end in turn: a task counts for whoever owned it at that moment, so
 * today's owner does not inherit a usual it never had. An event written just out of time order lands at the next stop.
 */
function dayEndCounts(events: readonly RegisterEvent[], dayEnds: readonly number[], zone: TimeZone): ReadonlyMap<string, Counts>[] {
  const fold = new RegisterFold();
  let next = 0;
  return dayEnds.map((end) => {
    for (let event = events[next]; event !== undefined && Date.parse(event.at) < end; event = events[next]) {
      fold.apply(event);
      next += 1;
    }
    return countsByOwner(fold.state().tasks.values(), end, zone);
  });
}

function countsByOwner(tasks: Iterable<Task>, at: number, zone: TimeZone): Map<string, Counts> {
  const byOwner = new Map<string, Counts>();
  for (const task of tasks) {
    if (ACTIVE_STATUSES.includes(task.status)) {
      const counts = byOwner.get(task.owner) ?? noCounts();
      byOwner.set(task.owner, counts);
      counts.active += 1;
      AREA_MEASURES.filter((measure) => COUNTED[measure](task, at, zone)).forEach((measure) => (counts[measure] += 1));
    }
  }
  return byOwner;
}

function wholeTeam({ team, days }: ReplayedTeam): Placed {
  return { team: team.team, session: null, tasks: team.active, days: sinceFirstTask(days.map((day) => summed([...day.values()]))) };
}

function teamSessions({ team, days }: ReplayedTeam): Placed[] {
  return [...new Set(team.active.map((each) => each.task.owner))].map((owner) => ({
    team: team.team,
    session: owner,
    tasks: team.active.filter((each) => each.task.owner === owner),
    days: sinceFirstTask(days.map((day) => day.get(owner) ?? noCounts())),
  }));
}

/**
 * The day-ends from the area's first active task on. Before it the area was not there, a register younger than the
 * usual's days or a session hired since, and zeros from then would sink its usual until every count read as a spike.
 */
function sinceFirstTask(days: readonly Counts[]): readonly Counts[] {
  const first = days.findIndex((day) => day.active > 0);
  return first === -1 ? [] : days.slice(first);
}

function groupOf(placed: readonly Placed[], now: number, zone: TimeZone): AreaGroup {
  const measured = placed.map((area) => ({ area, cells: perMeasure((measure) => measuredCell(area, measure, now, zone)) }));
  const peers = perMeasure((measure) => measured.map(({ cells }) => cells[measure].value));
  const areas = measured.map(({ area, cells }) => ({
    team: area.team,
    session: area.session,
    active: area.tasks.length,
    cells: perMeasure((measure) => levelled(cells[measure], measure, peers[measure])),
  }));
  return {
    areas: areas.sort(worstFirst),
    median: { active: median(placed.map((area) => area.tasks.length)) ?? 0, ...perMeasure((measure) => median(peers[measure]) ?? 0) },
  };
}

function measuredCell(area: Placed, measure: AreaMeasure, now: number, zone: TimeZone): MeasuredCell {
  const tasks = area.tasks.filter((each) => COUNTED[measure](each.task, now, zone));
  return {
    value: valueOf(measure, tasks.length, area.tasks.length),
    usual: median(area.days.map((day) => valueOf(measure, day[measure], day.active))) ?? 0,
    tasks,
  };
}

function valueOf(measure: AreaMeasure, count: number, active: number): number {
  if (measure !== 'low') {
    return count;
  }
  return active === 0 ? 0 : Math.round((100 * count) / active);
}

function levelled(cell: MeasuredCell, measure: AreaMeasure, peers: readonly number[]): AreaCell {
  const others = highAmongPeers(cell.value, measure, peers);
  const usual = cell.value > 0 && cell.value >= AREA_THRESHOLDS.overUsual * cell.usual;
  return { ...cell, level: others && usual ? 'bad' : others || usual ? 'warn' : 'good' };
}

/** An area alone fails this by itself: its value is its peers' median, so red needs at least one other area. */
function highAmongPeers(value: number, measure: AreaMeasure, peers: readonly number[]): boolean {
  const top = [...peers].sort((a, b) => b - a)[Math.ceil(peers.length * AREA_THRESHOLDS.topShare) - 1] ?? value;
  const middle = median(peers) ?? 0;
  const bar = measure === 'low' ? middle + AREA_THRESHOLDS.lowPoints : AREA_THRESHOLDS.overMedian * middle;
  return value > 0 && value >= top && value >= bar;
}

function worstFirst(a: AreaStats, b: AreaStats): number {
  return cellsAt(b, 'bad') - cellsAt(a, 'bad') || cellsAt(b, 'warn') - cellsAt(a, 'warn') || b.active - a.active || byName(a, b);
}

function cellsAt(area: AreaStats, level: HealthLevel): number {
  return AREA_MEASURES.filter((measure) => area.cells[measure].level === level).length;
}

function byName(a: AreaStats, b: AreaStats): number {
  const left = nameOf(a);
  const right = nameOf(b);
  return left < right ? -1 : left > right ? 1 : 0;
}

function nameOf({ team, session }: AreaStats): string {
  return `${team}/${session ?? ''}`;
}

function perMeasure<T>(make: (measure: AreaMeasure) => T): Record<AreaMeasure, T> {
  return { bugs: make('bugs'), p1: make('p1'), p1Late: make('p1Late'), low: make('low'), waits: make('waits') };
}

function noCounts(): Counts {
  return { active: 0, ...perMeasure(() => 0) };
}

function summed(counts: readonly Counts[]): Counts {
  const total = (key: keyof Counts): number => counts.reduce((sum, each) => sum + each[key], 0);
  return { active: total('active'), ...perMeasure(total) };
}
