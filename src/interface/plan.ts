import { MS_PER_DAY, parseDeadline } from '../core/time.ts';
import { taskNumber, type Task } from '../register/fold.ts';
import { ACTIVE_STATUSES } from '../register/model.ts';
import { planBand, type NextMove, type PlanPlace, type TaskTree } from '../register/tree.ts';

/** The date a task works to: its own due, or the earlier one of a task that needs it. */
export interface ServedDue {
  /** As stored: `YYYY-MM-DD`, a day of the team's zone (its end there), or `YYYY-MM-DD HH:MM` in UTC. */
  readonly due: string;
  /** The same moment, ISO in UTC. */
  readonly at: string;
  /** The needing task whose due this is; null when it is the task's own. */
  readonly from: string | null;
}

/** The best of the active tasks that need a task: the first by number of the best priority, and how many need it. */
export interface ServedUnblocks {
  readonly first: string;
  readonly priority: number;
  readonly count: number;
}

/** The ranked goal a task's score was read from. */
export interface ServedGoalRank {
  readonly tag: string;
  readonly rank: number;
}

/**
 * A task another one is planned after or waits on, with where it stands. `team` is null for a task of the same
 * register, else the team of the tree whose register holds it; `owner` and `status` are null for an id no register
 * of the tree holds any more, which was retired, so finished. Nothing else of another team's task is served.
 */
export interface ServedNeed {
  readonly id: string;
  readonly team: string | null;
  readonly owner: string | null;
  readonly status: string | null;
}

/**
 * An active task of another session that needs a task, so whom the task holds up beyond its owner. It is a task of
 * the same register: a plan knows no needer in another team's.
 */
export interface ServedNeeder {
  readonly id: string;
  readonly owner: string;
  /** The date the needing task works to. */
  readonly due: ServedDue | null;
}

/** A finished task and the work class its rank is shown with, which is read with the team's goals as an active task's is. */
export interface FinishedTask {
  readonly id: string;
  readonly workClass: string;
}

/**
 * Who moves first so a task can finish, on which task: its owner's work, a decision or an approval asked of `who`,
 * the owner again once `at` (ISO in UTC) has come, or (`elsewhere`) the owner of `need`, an unfinished task that `team`'s
 * register holds. `behind` is an in-progress task of the same session it works first. A minor may add a kind, so a
 * reader passes over one it does not know.
 */
export type ServedMove =
  | { readonly kind: 'work' | 'decision' | 'approval'; readonly who: string; readonly task: string; readonly behind: string | null }
  | { readonly kind: 'time'; readonly who: string; readonly task: string; readonly behind: string | null; readonly at: string }
  | { readonly kind: 'elsewhere'; readonly who: string; readonly task: string; readonly team: string; readonly need: string };

/**
 * One active task as the team's plan places it. `pinned`, `band`, `ready`, `score`, `started`, `due`, `unblocks`,
 * `inWeek`, `size` and the id's number are the keys of plan order, in that order, so a reader that shows several
 * teams' tasks together sorts them as teamrig does. `band` and `score` come with what they were read from
 * (`costOfDelay`, `sizePct`, `workClass`, `goal`, `prep`).
 */
export interface PlannedTask {
  readonly id: string;
  /** The park rule takes it out of the lists: open, quiet for long, of a parking class, and no active task of the tree needs it. */
  readonly parked: boolean;
  readonly pinned: boolean;
  /** 0 is expedite, 1 near-term prep, then the team's class bands; the lowest first. */
  readonly band: number;
  /** No wait of it is pending and every task it is planned after is finished. */
  readonly ready: boolean;
  /** Cost of delay over size; the highest first. */
  readonly score: number;
  readonly started: boolean;
  readonly due: ServedDue | null;
  readonly unblocks: ServedUnblocks | null;
  /** Tagged with the week plan in force. */
  readonly inWeek: boolean;
  /** Its size in percent of the weekly limit; null when not sized. */
  readonly size: number | null;
  readonly costOfDelay: number;
  /** The work left the score divides by, in percent of the weekly limit. */
  readonly sizePct: number;
  readonly workClass: string;
  readonly goal: ServedGoalRank | null;
  readonly prep: boolean;
  readonly needs: readonly ServedNeed[];
  /** The active tasks of other sessions that need it, the one with the earliest date first, then in plan order. */
  readonly neededBy: readonly ServedNeeder[];
  /** Null when every unfinished need of it runs into a loop. */
  readonly next: ServedMove | null;
}

/** The `plan` document's own fields. */
export interface PlanBody {
  /** When the plan was judged, ISO in UTC. */
  readonly at: string;
  /**
   * The first moment after `at` an answer here may change with no file moving: a due passing or coming near, a wait's
   * time coming, a quiet task reaching the park rule. The revision covers files and never the clock, so once it has
   * passed a reader asks again without `--unless`. Null when no such moment is ahead.
   */
  readonly validUntil: string | null;
  /** The week plan in force; null with none. */
  readonly week: string | null;
  /** The active tasks in plan order: the place in this list is the rank. */
  readonly tasks: readonly PlannedTask[];
  /** The finished tasks the register still holds, by number: a plan places none of them, a reader still shows their class. */
  readonly finished: readonly FinishedTask[];
}

/** The settings whose days turn an answer of the plan with no file moving. */
export interface PlanTurns {
  /** A due this near raises the score (`focus.score.dueSoonDays`). */
  readonly dueSoonDays: number;
  /** An open task this long untouched may park (`focus.parkAfterDays`). */
  readonly parkAfterDays: number;
}

/** What the `plan` document is built from. */
export interface PlanInput {
  /** The team's tree as read at `now`, with its ranking and the tasks of the tree's other registers. */
  readonly tree: TaskTree;
  /** The register's tasks; a finished one is served by its work class alone. */
  readonly tasks: Iterable<Task>;
  /** Serve only this session's tasks, in the team's order; null serves every session's. */
  readonly owner: string | null;
  readonly now: number;
  readonly turns: PlanTurns;
}

/** The `plan` document's body. */
export function planBody(input: PlanInput): PlanBody {
  const { tree, now } = input;
  const tasks = [...input.tasks];
  const isActive = (task: Task) => ACTIVE_STATUSES.includes(task.status);
  const asked = (task: Task) => input.owner === null || task.owner === input.owner;
  const active = tree.inPlanOrder(tasks.filter(isActive));
  const turns = active.flatMap((task) => turnsOf(task, tree, input.turns)).filter((at) => at > now);
  return {
    at: new Date(now).toISOString(),
    validUntil: turns.length === 0 ? null : new Date(Math.min(...turns)).toISOString(),
    week: tree.week,
    tasks: active.filter(asked).map((task) => plannedTask(task, tree)),
    finished: tasks
      .filter((task) => !isActive(task) && asked(task))
      .sort((a, b) => taskNumber(a.id) - taskNumber(b.id))
      .map((task) => ({ id: task.id, workClass: rankedOf(tree.placeOf(task)).workClass })),
  };
}

function plannedTask(task: Task, tree: TaskTree): PlannedTask {
  const place = tree.placeOf(task);
  const ranked = rankedOf(place);
  const move = tree.nextMove(task.id);
  return {
    id: task.id,
    parked: tree.isParked(task),
    pinned: place.pinned === true,
    band: planBand(ranked),
    ready: place.blocked !== true,
    score: ranked.score,
    started: place.started === true,
    due: servedDue(task.id, tree),
    unblocks: place.unblocks === undefined ? null : { first: place.unblocks.first, priority: place.unblocks.priority, count: place.unblocks.count },
    inWeek: place.inWeek === true,
    size: task.size,
    costOfDelay: ranked.costOfDelay,
    sizePct: ranked.sizePct,
    workClass: ranked.workClass,
    goal: ranked.goal === null ? null : { tag: ranked.goal.tag, rank: ranked.goal.rank },
    prep: ranked.prep,
    needs: tree.needs(task.id).map((id) => servedNeed(id, tree)),
    neededBy: tree.neededByOthers(task.id).map((needer) => ({ id: needer.id, owner: needer.owner, due: servedDue(needer.id, tree) })),
    next: move === undefined ? null : servedMove(move, tree),
  };
}

function servedDue(id: string, tree: TaskTree): ServedDue | null {
  const due = tree.effectiveDue(id);
  return due === undefined ? null : { due: due.due, at: new Date(due.at).toISOString(), from: due.from };
}

/** A plan is a ranked read: a tree built with no ranking places nothing, so it is refused here, loudly, as a bug. */
function rankedOf(place: PlanPlace): NonNullable<PlanPlace['ranked']> {
  if (place.ranked === undefined) {
    throw new Error('the plan document needs a tree built with its ranking');
  }
  return place.ranked;
}

function servedNeed(id: string, tree: TaskTree): ServedNeed {
  const own = tree.task(id);
  if (own !== undefined) {
    return { id, team: null, owner: own.owner, status: own.status };
  }
  const away = tree.elsewhereOf(id);
  return away === undefined ? { id, team: null, owner: null, status: null } : { id, team: away.team, owner: away.task.owner, status: away.task.status };
}

/** A move written out field by field, ids for tasks, so nothing a move's task holds is served by accident. */
function servedMove(move: NextMove, tree: TaskTree): ServedMove {
  switch (move.kind) {
    case 'elsewhere':
      return { kind: 'elsewhere', who: move.who, task: move.task.id, team: move.team, need: move.need.id };
    case 'time':
      return { kind: 'time', who: move.who, task: move.task.id, behind: move.behind?.id ?? null, at: parseDeadline(move.at, tree.zone)?.toISOString() ?? move.at };
    default:
      return { kind: move.kind, who: move.who, task: move.task.id, behind: move.behind?.id ?? null };
  }
}

/**
 * The moments one task's answers may turn at with no file moving: its effective due and the day that due comes near,
 * each time it waits until, and for an open task the day the park rule may take it. A moment that turns nothing only
 * costs a reader one early read.
 */
function turnsOf(task: Task, tree: TaskTree, turns: PlanTurns): number[] {
  const due = tree.dueTime(task);
  const waits = task.waits.flatMap((reason) => (reason.kind === 'time' ? [parseDeadline(reason.at, tree.zone)?.getTime() ?? Number.NaN] : []));
  const park = task.status === 'open' ? [Date.parse(task.updatedAt) + turns.parkAfterDays * MS_PER_DAY] : [];
  return [...(due === undefined ? [] : [due, due - turns.dueSoonDays * MS_PER_DAY]), ...waits, ...park].filter((at) => Number.isFinite(at));
}
