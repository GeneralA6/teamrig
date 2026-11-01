import type { ActiveCounts, RegisterStats, TeamPart, WaitStats } from './stats.ts';

/**
 * The Health tiles over the stats fold (T1771, design T1419 section 2): five numbers the owner reads first, each with
 * a level the pane draws as a green, amber or red dot and `teamrig stats` prints as a word. The week tile (usage
 * against the pace) is the CLI's and the pane's, from the budget, not the register. Pure, with no node: import, so the
 * pane vendors it (src/read/index.ts).
 */

export const HEALTH_LEVELS = ['good', 'warn', 'bad'] as const;

export type HealthLevel = (typeof HEALTH_LEVELS)[number];

/** Each tile's limits: a value past `bad` is bad, else past `warn` a warning. */
export const HEALTH_THRESHOLDS = {
  /** Tasks closed per task opened in the range: under 0.9 bad, under 1 a warning (the backlog grows). */
  closeOpen: { bad: 0.9, warn: 1 },
  /** The range's net as a share of the active work: over 5% bad, over 0 a warning. */
  backlog: { badShare: 0.05 },
  /** The oldest owner decision or approval wait, in days: over 7 bad, over 2 a warning. */
  ownerDecisions: { badDays: 7, warnDays: 2 },
  /** The weeks the active work takes to clear at the recent net: over 4 a warning, never (it grows) bad. */
  backlogClears: { warnWeeks: 4 },
} as const;

const DAYS_PER_WEEK = 7;

/** The numbers of the fold the tiles read: {@link RegisterStats} fits it. */
export interface HealthInput {
  readonly opened: number;
  readonly closedTasks: number;
  readonly net: number;
  readonly active: ActiveCounts;
  readonly recent: RegisterStats['recent'];
  readonly all: Pick<TeamPart, 'overdue'>;
  readonly waits: Pick<WaitStats, 'ownerDecisions'>;
}

export interface CloseOpenTile {
  readonly level: HealthLevel;
  /** Closed per opened; null when nothing was opened in the range. */
  readonly ratio: number | null;
}

export interface BacklogTile {
  readonly level: HealthLevel;
  readonly net: number;
  readonly active: number;
}

export interface OverdueTile {
  readonly level: HealthLevel;
  readonly count: number;
  readonly p1: number;
}

export interface OwnerDecisionsTile {
  readonly level: HealthLevel;
  readonly count: number;
  readonly oldestDays: number | null;
}

export interface BacklogClearsTile {
  readonly level: HealthLevel;
  /** Whole weeks, rounded up, at the recent net; null when the backlog does not shrink (never). */
  readonly weeks: number | null;
}

export interface RegisterHealth {
  readonly closeOpen: CloseOpenTile;
  readonly backlog: BacklogTile;
  readonly overdue: OverdueTile;
  readonly ownerDecisions: OwnerDecisionsTile;
  readonly backlogClears: BacklogClearsTile;
}

export function registerHealth(stats: HealthInput): RegisterHealth {
  const active = activeTotal(stats.active);
  return {
    closeOpen: closeOpenTile(stats.closedTasks, stats.opened),
    backlog: backlogTile(stats.net, active),
    overdue: overdueTile(stats.all.overdue),
    ownerDecisions: ownerDecisionsTile(stats.waits.ownerDecisions),
    backlogClears: backlogClearsTile(active, stats.recent),
  };
}

function activeTotal(active: ActiveCounts): number {
  return Object.values(active).reduce((sum, count) => sum + count, 0);
}

function closeOpenTile(closed: number, opened: number): CloseOpenTile {
  if (opened === 0) {
    return { level: 'good', ratio: null };
  }
  const ratio = closed / opened;
  const { bad, warn } = HEALTH_THRESHOLDS.closeOpen;
  return { level: ratio < bad ? 'bad' : ratio < warn ? 'warn' : 'good', ratio };
}

function backlogTile(net: number, active: number): BacklogTile {
  const level = net > active * HEALTH_THRESHOLDS.backlog.badShare ? 'bad' : net > 0 ? 'warn' : 'good';
  return { level, net, active };
}

function overdueTile(overdue: TeamPart['overdue']): OverdueTile {
  return { level: overdue.p1 > 0 ? 'bad' : overdue.count > 0 ? 'warn' : 'good', count: overdue.count, p1: overdue.p1 };
}

function ownerDecisionsTile(decisions: WaitStats['ownerDecisions']): OwnerDecisionsTile {
  const { badDays, warnDays } = HEALTH_THRESHOLDS.ownerDecisions;
  const oldest = decisions.oldestDays;
  const level = oldest === null ? 'good' : oldest > badDays ? 'bad' : oldest > warnDays ? 'warn' : 'good';
  return { level, count: decisions.count, oldestDays: oldest };
}

function backlogClearsTile(active: number, recent: RegisterStats['recent']): BacklogClearsTile {
  if (active === 0) {
    return { level: 'good', weeks: 0 };
  }
  const netPerWeek = (recent.net * DAYS_PER_WEEK) / recent.days;
  if (netPerWeek >= 0) {
    return { level: 'bad', weeks: null };
  }
  const weeks = Math.ceil(active / -netPerWeek);
  return { level: weeks > HEALTH_THRESHOLDS.backlogClears.warnWeeks ? 'warn' : 'good', weeks };
}
