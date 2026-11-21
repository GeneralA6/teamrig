import type { AreaCell, AreaGroup, AreaStats } from '../register/area-stats.ts';
import { taskNumber, type Task } from '../register/fold.ts';
import type { GoalProgress } from '../register/goal-stats.ts';
import type { RegisterHealth } from '../register/stats-health.ts';
import type { ActiveCounts, Band, RegisterStats, Spread, StatsTask, TeamPart } from '../register/stats.ts';
import { servedSlip, type ServedSlip } from './goals.ts';
import type { SourceNames } from './source.ts';
import { ServedText, type Cut, type MarkedText, type SecretShapes } from './text.ts';

/** The active tasks in each status. */
export interface ServedActive {
  readonly open: number;
  readonly 'in-progress': number;
  readonly verifying: number;
  readonly waiting: number;
}

/** One calendar day of the team's zone. */
export interface ServedStatsDay {
  /** `YYYY-MM-DD`. */
  readonly day: string;
  readonly opened: number;
  /** Closes from an active status that day: a task reopened and closed again counts at each close. */
  readonly done: number;
  readonly dropped: number;
  /** The active tasks in each status at the day's end. */
  readonly active: ServedActive;
  /** True when the account's week sat at its usage limit for part of the day. */
  readonly atLimit: boolean;
}

/** Durations in days: how many, their median and their 85th percentile; null with no duration. */
export interface ServedSpread {
  readonly count: number;
  readonly median: number | null;
  readonly p85: number | null;
}

/** A count under a label that is teamrig's own word (`2-7 d`). */
export interface ServedBand {
  readonly label: string;
  readonly count: number;
}

/** The numbers of the whole scope. */
export interface ServedStatsAll {
  readonly active: number;
  /** Created to done, over the tasks done in the range. */
  readonly leadTime: ServedSpread;
  /** First started to done, over the tasks done in the range that were ever started. */
  readonly cycleTime: ServedSpread;
  /** The active tasks past their due date at `at`, and how many of them are p1. */
  readonly overdue: { readonly count: number; readonly p1: number };
  /** The tasks done in the range that had a due date, and how many were done by it. */
  readonly due: { readonly total: number; readonly onTime: number };
}

/** The tasks created in the range. A task with two goals counts once under each. */
export interface ServedNewWork {
  readonly total: number;
  /** Who asked: the task's owner itself, the human owner, the team's lead, a GitHub issue, or another session. */
  readonly bySource: { readonly self: number; readonly owner: number; readonly lead: number; readonly github: number; readonly session: number };
  readonly bugs: number;
  /** Most urgent first. */
  readonly byPriority: readonly { readonly priority: number; readonly count: number }[];
  /** Most tasks first, then by tag. */
  readonly byGoal: readonly { readonly goal: string; readonly count: number }[];
  readonly noGoal: number;
}

export interface ServedWaitStats {
  readonly waiting: number;
  /** The waiting tasks with a reason of each kind: a task waiting on two kinds counts under both. */
  readonly byKind: { readonly decision: number; readonly approval: number; readonly task: number; readonly time: number };
  /** The active tasks that wait on the owner, and the longest such wait in days at `at`. */
  readonly ownerDecisions: { readonly count: number; readonly oldestDays: number | null };
}

/** The five Health tiles. A level is `good`, `warn` or `bad`; a plain string, since a minor may add one. */
export interface ServedHealth {
  /** Tasks closed per task opened in the range; null when none was opened. */
  readonly closeOpen: { readonly level: string; readonly ratio: number | null };
  readonly backlog: { readonly level: string; readonly net: number; readonly active: number };
  readonly overdue: { readonly level: string; readonly count: number; readonly p1: number };
  readonly ownerDecisions: { readonly level: string; readonly count: number; readonly oldestDays: number | null };
  /** Whole weeks the active work takes to clear at the recent net; null when it does not shrink. */
  readonly backlogClears: { readonly level: string; readonly weeks: number | null };
}

/** The ids of the very tasks a count counts, in the count's own order; each one's row is in {@link StatsBody.tasks}. */
export interface ServedBehind {
  readonly active: readonly string[];
  readonly opened: readonly string[];
  readonly closed: readonly string[];
  /** The longest past its due date first. */
  readonly overdue: readonly string[];
  readonly overdueP1: readonly string[];
  /** The oldest wait first. */
  readonly ownerDecisions: readonly string[];
}

/** One goal over its whole history, whatever the range. */
export interface ServedGoalProgress {
  readonly tag: string;
  readonly title: string;
  /** The first and the target day of its window, `YYYY-MM-DD`. */
  readonly start: string;
  readonly target: string;
  readonly parent: string | null;
  readonly slips: readonly ServedSlip[];
  /** Its tasks done at `at`; a dropped task counts for neither this nor `open`. */
  readonly done: number;
  readonly open: number;
  /** Only the days with a task done, the oldest first. */
  readonly doneDays: readonly { readonly day: string; readonly done: number }[];
  /** Tasks done per day over the last two weeks. */
  readonly pace: number;
  /** The day the open tasks end at that pace; null with no pace, or with none open. */
  readonly forecast: string | null;
  /** `done`, `on track`, `at risk` or `late`; a plain string, since a minor may add one. */
  readonly state: string;
  /** Its tasks, by id. */
  readonly tasks: readonly string[];
}

export interface ServedGoalStats {
  /** In the order the goals were added. */
  readonly goals: readonly ServedGoalProgress[];
  /** Of `doneInRange`, the tasks with no goal tag. */
  readonly offGoal: number;
  readonly doneInRange: number;
}

/** One measure of an area. */
export interface ServedAreaCell {
  /** The count at `at`; for `low`, the low-priority share of the area's active tasks in whole percent. */
  readonly value: number;
  /** The median of the same value at each day-end before today. */
  readonly usual: number;
  readonly level: string;
  /** The tasks behind the value, by id. */
  readonly tasks: readonly string[];
}

/** A team, or one session of it, against the others and its own usual. */
export interface ServedArea {
  readonly team: string;
  /** Null for a whole team. */
  readonly session: string | null;
  readonly active: number;
  readonly cells: {
    readonly bugs: ServedAreaCell;
    readonly p1: ServedAreaCell;
    readonly p1Late: ServedAreaCell;
    readonly low: ServedAreaCell;
    readonly waits: ServedAreaCell;
  };
}

export interface ServedAreaGroup {
  /** The areas with active tasks: most `bad` cells first, then most `warn`, most active, then by name. */
  readonly areas: readonly ServedArea[];
  /** The middle area on each measure and on its active tasks; 0 with no area. */
  readonly median: { readonly bugs: number; readonly p1: number; readonly p1Late: number; readonly low: number; readonly waits: number; readonly active: number };
}

/** A task a count names, slim: what a list of the tasks behind a number draws. The `tasks` document holds the rest. */
export interface ServedStatsTask {
  readonly id: string;
  readonly title: MarkedText;
  readonly owner: string;
  /** 1 is the most urgent. */
  readonly priority: number;
  /** A plain string, not the register's own list: a minor may add a status. */
  readonly status: string;
  /** `YYYY-MM-DD` or `YYYY-MM-DD HH:MM`, UTC; a bare day means its end. */
  readonly due: string | null;
}

/** The `stats` document's own fields. */
export interface StatsBody {
  /** The instant every number is counted at, ISO in UTC: an age in days (`oldestDays`, a `waits` cell) is as of it. */
  readonly at: string;
  /** The instant from which a number may differ though no file changed: the next day of the zone, or a task's due. */
  readonly validUntil: string;
  /** `7d`, `30d`, `90d`, `180d`, `1y` or `all`; a plain string, since a minor may add one. */
  readonly range: string;
  /** The one session whose tasks are counted; null for the whole team's. */
  readonly session: string | null;
  /** Each calendar day of the range, the oldest first. */
  readonly days: readonly ServedStatsDay[];
  /** Tasks created in the range. */
  readonly opened: number;
  /** Tasks done or dropped at `at` whose close fell in the range: each task once. */
  readonly closedTasks: number;
  readonly droppedTasks: number;
  /** `opened - closedTasks`. */
  readonly net: number;
  /** Every close in the range: a task closed twice counts twice. */
  readonly closes: number;
  /** The net over the last `days` days, whatever the range. */
  readonly recent: { readonly days: number; readonly net: number };
  readonly active: ServedActive;
  readonly all: ServedStatsAll;
  readonly newWork: ServedNewWork;
  /** The active tasks by age since created. */
  readonly activeByAge: readonly ServedBand[];
  /** Tasks done in the range that were never started. */
  readonly neverStarted: number;
  /** The tasks done late in the range, by whole days late. */
  readonly lateDays: readonly ServedBand[];
  /** Tasks whose set due date was changed or cleared in the range. */
  readonly dueMoved: number;
  readonly waits: ServedWaitStats;
  readonly bugs: { readonly active: number; readonly opened: number; readonly fixed: number };
  /** The tasks each session closed done in the range: most first, then by session. */
  readonly people: readonly { readonly team: string; readonly session: string; readonly done: number }[];
  /** The tasks that moved from one team to another on a day, the oldest first. */
  readonly splits: readonly { readonly day: string; readonly from: string; readonly to: string; readonly tasks: number }[];
  readonly health: ServedHealth;
  readonly behind: ServedBehind;
  readonly goals: ServedGoalStats;
  /** `teams` holds no area while one team is counted. */
  readonly areas: { readonly teams: ServedAreaGroup; readonly sessions: ServedAreaGroup };
  /** One row per task named by id anywhere above, by id. */
  readonly tasks: readonly ServedStatsTask[];
  readonly cuts: readonly Cut[];
}

/** What the `stats` document is built from. */
export interface StatsBodyInput {
  readonly stats: RegisterStats;
  readonly health: RegisterHealth;
  /** The session the fold was narrowed to; null for the whole team's. */
  readonly session: string | null;
  /** The instant the fold counted at, and the one its numbers hold until, in ms. */
  readonly now: number;
  readonly validUntil: number;
  readonly shapes: SecretShapes;
  readonly names: Pick<SourceNames, 'owner' | 'connectors'>;
}

/**
 * The `stats` document's body: the fold `teamrig stats` and the pane's Stats tab read, under its own field names,
 * so a reader maps it straight onto what it drew before. Every field is written out by name and no stored object is
 * spread: a field the fold gains is not served until a minor adds it here. A count's tasks are served as ids, and
 * each task named has one slim row in `tasks`, so a title is scanned and served once however many counts name it.
 * `RegisterStats.teams` is left out: one team is counted, so it would repeat `all`.
 */
export function statsBody(input: StatsBodyInput): StatsBody {
  const { stats, health } = input;
  const served = new ServedText(input.shapes);
  const named = new NamedTasks();
  const behind: ServedBehind = {
    active: named.ids(stats.tasks.active),
    opened: named.ids(stats.tasks.opened),
    closed: named.ids(stats.tasks.closed),
    overdue: named.ids(stats.tasks.overdue),
    overdueP1: named.ids(stats.tasks.overdueP1),
    ownerDecisions: named.ids(stats.tasks.ownerDecisions),
  };
  const goals: ServedGoalStats = {
    goals: stats.goals.goals.map((goal) => servedProgress(goal, served, named)),
    offGoal: stats.goals.offGoal,
    doneInRange: stats.goals.doneInRange,
  };
  const areas = { teams: servedGroup(stats.areas.teams, named), sessions: servedGroup(stats.areas.sessions, named) };
  return {
    at: new Date(input.now).toISOString(),
    validUntil: new Date(input.validUntil).toISOString(),
    range: stats.range,
    session: input.session,
    days: stats.days.map((day) => ({ day: day.day, opened: day.opened, done: day.done, dropped: day.dropped, active: servedActive(day.active), atLimit: day.atLimit })),
    opened: stats.opened,
    closedTasks: stats.closedTasks,
    droppedTasks: stats.droppedTasks,
    net: stats.net,
    closes: stats.closes,
    recent: { days: stats.recent.days, net: stats.recent.net },
    active: servedActive(stats.active),
    all: servedAll(stats.all),
    newWork: {
      total: stats.newWork.total,
      bySource: {
        self: stats.newWork.bySource.self,
        owner: stats.newWork.bySource.owner,
        lead: stats.newWork.bySource.lead,
        github: stats.newWork.bySource.github,
        session: stats.newWork.bySource.session,
      },
      bugs: stats.newWork.bugs,
      byPriority: stats.newWork.byPriority.map(({ priority, count }) => ({ priority, count })),
      byGoal: stats.newWork.byGoal.map(({ goal, count }) => ({ goal, count })),
      noGoal: stats.newWork.noGoal,
    },
    activeByAge: stats.activeByAge.map(servedBand),
    neverStarted: stats.neverStarted,
    lateDays: stats.lateDays.map(servedBand),
    dueMoved: stats.dueMoved,
    waits: {
      waiting: stats.waits.waiting,
      byKind: { decision: stats.waits.byKind.decision, approval: stats.waits.byKind.approval, task: stats.waits.byKind.task, time: stats.waits.byKind.time },
      ownerDecisions: { count: stats.waits.ownerDecisions.count, oldestDays: stats.waits.ownerDecisions.oldestDays },
    },
    bugs: { active: stats.bugs.active, opened: stats.bugs.opened, fixed: stats.bugs.fixed },
    people: stats.people.map(({ team, session, done }) => ({ team, session, done })),
    splits: stats.splits.map(({ day, from, to, tasks }) => ({ day, from, to, tasks })),
    health: servedHealth(health),
    behind,
    goals,
    areas,
    tasks: named.rows(served, input.names),
    cuts: served.cuts,
  };
}

/** The tasks the counts name, each kept once: the ids go out where a count is, the rows once at the document's end. */
class NamedTasks {
  private readonly found = new Map<string, Task>();

  /** The ids of `tasks`, in their order; each task is kept for its row. */
  ids(tasks: readonly StatsTask[]): string[] {
    return tasks.map(({ task }) => {
      this.found.set(task.id, task);
      return task.id;
    });
  }

  rows(served: ServedText, names: Pick<SourceNames, 'owner' | 'connectors'>): ServedStatsTask[] {
    return [...this.found.values()].sort((one, other) => taskNumber(one.id) - taskNumber(other.id)).map((task) => servedRow(task, served, names));
  }
}

/**
 * A task's slim row. Its title is outside text when a connector's import wrote the task, by the rule `sourceOf`
 * reads a source with: the owner's marker first, then a connector's id. `sourceOf` itself is not called, since it
 * would scan a source name this document does not serve and could list a cut of a field no reader finds here.
 */
function servedRow(task: Task, served: ServedText, names: Pick<SourceNames, 'owner' | 'connectors'>): ServedStatsTask {
  const outside = task.source !== names.owner && names.connectors.some((connector) => connector.id === task.source);
  return {
    id: task.id,
    title: served.marked(task.id, 'title', task.title, outside ? 'outside' : 'team'),
    owner: task.owner,
    priority: task.priority,
    status: task.status,
    due: task.due,
  };
}

function servedActive(active: ActiveCounts): ServedActive {
  return { open: active.open, 'in-progress': active['in-progress'], verifying: active.verifying, waiting: active.waiting };
}

function servedSpread(spread: Spread): ServedSpread {
  return { count: spread.count, median: spread.median, p85: spread.p85 };
}

function servedBand(band: Band): ServedBand {
  return { label: band.label, count: band.count };
}

function servedAll(all: TeamPart): ServedStatsAll {
  return {
    active: all.active,
    leadTime: servedSpread(all.leadTime),
    cycleTime: servedSpread(all.cycleTime),
    overdue: { count: all.overdue.count, p1: all.overdue.p1 },
    due: { total: all.due.total, onTime: all.due.onTime },
  };
}

function servedHealth(health: RegisterHealth): ServedHealth {
  return {
    closeOpen: { level: health.closeOpen.level, ratio: health.closeOpen.ratio },
    backlog: { level: health.backlog.level, net: health.backlog.net, active: health.backlog.active },
    overdue: { level: health.overdue.level, count: health.overdue.count, p1: health.overdue.p1 },
    ownerDecisions: { level: health.ownerDecisions.level, count: health.ownerDecisions.count, oldestDays: health.ownerDecisions.oldestDays },
    backlogClears: { level: health.backlogClears.level, weeks: health.backlogClears.weeks },
  };
}

/** A goal's texts are the team's own, written by its lead: served plain and scanned, as the `goals` document does. */
function servedProgress(goal: GoalProgress, served: ServedText, named: NamedTasks): ServedGoalProgress {
  return {
    tag: goal.tag,
    title: served.plain(goal.tag, 'title', goal.title),
    start: goal.start,
    target: goal.target,
    parent: goal.parent,
    slips: goal.slips.map((slip, index) => servedSlip(goal.tag, index, slip, served)),
    done: goal.done,
    open: goal.open,
    doneDays: goal.doneDays.map(({ day, done }) => ({ day, done })),
    pace: goal.pace,
    forecast: goal.forecast,
    state: goal.state,
    tasks: named.ids(goal.tasks),
  };
}

function servedGroup(group: AreaGroup, named: NamedTasks): ServedAreaGroup {
  const { median } = group;
  return {
    areas: group.areas.map((area) => servedArea(area, named)),
    median: { bugs: median.bugs, p1: median.p1, p1Late: median.p1Late, low: median.low, waits: median.waits, active: median.active },
  };
}

function servedArea(area: AreaStats, named: NamedTasks): ServedArea {
  const cell = (measure: AreaCell): ServedAreaCell => ({ value: measure.value, usual: measure.usual, level: measure.level, tasks: named.ids(measure.tasks) });
  return {
    team: area.team,
    session: area.session,
    active: area.active,
    cells: { bugs: cell(area.cells.bugs), p1: cell(area.cells.p1), p1Late: cell(area.cells.p1Late), low: cell(area.cells.low), waits: cell(area.cells.waits) },
  };
}
