import { parseDeadline } from '../core/time.ts';
import type { TimeZone } from '../core/zone.ts';
import { taskNumber, type Task } from './fold.ts';
import { ACTIVE_STATUSES } from './model.ts';
import { wouldPark, type ParkFocus } from './park.ts';
import { scoreOf, valueOf, type ScoreFocus, type SizeFacts, type TaskScore, type ValueFacts } from './score.ts';
import { isFinished, isReady, waitContext, type PersonWait, type PersonWaitKind, type WaitContext } from './waits.ts';
import { currentWeek } from './week.ts';

/**
 * The dependency tree of one register, from the links its tasks already have: a task needs the tasks it is planned
 * after (`after`) and the tasks it waits on (`--waits task:`), and is needed by every active task that names it so.
 * A need is finished once its task is done or dropped, or retired from every register (waits.ts); a need another
 * register of the team tree holds is read there ({@link TasksElsewhere}, one numbering across the tree). Read side
 * only, with no `node:` import: `show --tree`, `list`, `check`, `start`, the meeting agenda, the plan, the live-tasks
 * note and the status pane read it, and the register's write policy refuses a link that would close a loop with
 * {@link needPath}.
 */

/** What a task needs first: the tasks it is planned after, then the tasks it waits on, each once. */
export function needsOf(task: Pick<Task, 'after' | 'waits'>): string[] {
  const waitedOn = task.waits.flatMap((reason) => (reason.kind === 'task' ? [reason.id] : []));
  return [...new Set([...task.after, ...waitedOn])];
}

/**
 * True when an active task of `tasks` needs an id they lack ({@link needsOf}), which another register of the team tree
 * may hold; a read with none has no need to read the tree's other registers.
 */
export function needsElsewhere(tasks: ReadonlyMap<string, Pick<Task, 'status' | 'after' | 'waits'>>): boolean {
  return [...tasks.values()].some((task) => ACTIVE_STATUSES.includes(task.status) && needsOf(task).some((id) => !tasks.has(id)));
}

/** Every id an active task of `tasks`, or of the tree's other registers, needs; ids are one numbering across a tree. */
export function neededIds(tasks: Iterable<Pick<Task, 'status' | 'after' | 'waits'>>, elsewhere: TasksElsewhere): ReadonlySet<string> {
  const others = [...elsewhere.values()].map(({ task }) => task);
  return new Set([...tasks, ...others].filter(isActive).flatMap((task) => needsOf(task)));
}

/**
 * The shortest chain from `from` to `to`, each task needing the next, over every task the map holds whatever its
 * status (a finished task may be reopened); `[from]` when both are one task, undefined when no chain leads there.
 * A write that makes `id` need `other` closes a loop when `needPath(tasks, other, id)` finds one.
 */
export function needPath(tasks: ReadonlyMap<string, Pick<Task, 'after' | 'waits'>>, from: string, to: string): string[] | undefined {
  return shortestPath(from, to, (id) => {
    const task = tasks.get(id);
    return task === undefined ? [] : needsOf(task);
  });
}

/** A chain as printed: `T2 -> T194 -> T2`, each task needing the next. */
export function pathText(path: readonly string[]): string {
  return path.join(' -> ');
}

/**
 * How a loop's link from `id` to `other` (of `owner`) goes: the step `id` needs becomes a task of its own. A link by
 * a task wait goes by `set --ask`, whose waits replace the old ones; a plan dependency by a new task and
 * `update --after`, which replaces the old list.
 */
export function loopFix(id: string, other: string, owner: string, byWait: boolean): string {
  const command = byWait
    ? `teamrig set ${id} --status waiting --ask ${owner} --text "<the step>"`
    : `teamrig add --owner ${owner} --title "<the step>", then teamrig update ${id} --after <its id>`;
  return `make the step ${id} needs from ${other} its own task: ${command}`;
}

/** The best of the active tasks that need a task: the first by number of the best priority, and how many need it. */
export interface Unblocks {
  readonly first: string;
  readonly priority: number;
  readonly count: number;
}

/** The ranked goal a task serves: the best rank on its goals or their ancestors, and the goal that holds it. */
export interface ServedGoal {
  readonly tag: string;
  readonly rank: number;
}

/** A task's band and score, with the class and goal they were read from, which its row and `ahead:` reason name. */
export interface RankedPlace extends TaskScore {
  readonly workClass: string;
  readonly goal: ServedGoal | null;
}

/**
 * A task's place in plan order: its deadline in ms (undefined: none) and its id; a tree's place
 * ({@link TaskTree.placeOf}) adds the rest of {@link PLAN_KEYS}. A place built without a tree or a {@link TreeRanking}
 * has no band or score, so they tie and it falls back to the keys below them: priority alone ranks nothing (T2076).
 */
export interface PlanPlace {
  readonly id: string;
  readonly at: number | undefined;
  /** Pinned to the top of its owner's list by one of the owner's leaders. */
  readonly pinned?: boolean;
  /** Its band and score; undefined with no ranking. */
  readonly ranked?: RankedPlace | undefined;
  /** Active with a need not finished, so it cannot move yet; false or missing: it can. */
  readonly blocked?: boolean;
  /** In progress. */
  readonly started?: boolean;
  /** The best needer; undefined when no active task needs it. */
  readonly unblocks?: Unblocks | undefined;
  /** Tagged with the week plan in force. */
  readonly inWeek?: boolean;
  /** Its size in percent of the weekly limit; null when not sized. */
  readonly size?: number | null;
}

/**
 * The keys of plan order, in order: the first one on which two tasks differ puts one ahead: `pinned` (a task the
 * owner's leader pinned, above every other key); `band` (expedite, then Roadmap and Maintenance, then the rest;
 * score.ts); `ready` (a task that can move before one with a need not finished, whose value still reaches that need
 * through its score); `score` (the highest WSJF score first; score.ts); `started` (an in-progress task stays on top of
 * its equals); `due` (effective due, the earliest first, undated last); `unblocks` (the best priority among the active
 * tasks that need it, then the most of them; none last); `week` (in the week plan in force first); `size` (the smallest
 * first, unsized last); `age` (the lowest number first).
 */
export const PLAN_KEYS = ['pinned', 'band', 'ready', 'score', 'started', 'due', 'unblocks', 'week', 'size', 'age'] as const;

/** One of {@link PLAN_KEYS}. */
export type PlanKey = (typeof PLAN_KEYS)[number];

const BY_KEY: Readonly<Record<PlanKey, (a: PlanPlace, b: PlanPlace) => number>> = {
  pinned: (a, b) => trueFirst(a.pinned, b.pinned),
  band: (a, b) => lowFirst(a.ranked?.band, b.ranked?.band),
  ready: (a, b) => trueFirst(b.blocked, a.blocked),
  score: (a, b) => highFirst(a.ranked?.score, b.ranked?.score),
  started: (a, b) => trueFirst(a.started, b.started),
  due: (a, b) => lowFirst(a.at, b.at),
  unblocks: (a, b) => lowFirst(a.unblocks?.priority, b.unblocks?.priority) || (b.unblocks?.count ?? 0) - (a.unblocks?.count ?? 0),
  week: (a, b) => trueFirst(a.inWeek, b.inWeek),
  size: (a, b) => lowFirst(a.size ?? undefined, b.size ?? undefined),
  age: (a, b) => taskNumber(a.id) - taskNumber(b.id),
};

/** The first of {@link PLAN_KEYS} on which the two places differ; undefined when they tie on every one. */
export function decidingKey(a: PlanPlace, b: PlanPlace): PlanKey | undefined {
  return PLAN_KEYS.find((key) => BY_KEY[key](a, b) !== 0);
}

/** Plan order: by the first of {@link PLAN_KEYS} on which the places differ. */
export function planOrder(a: PlanPlace, b: PlanPlace): number {
  const key = decidingKey(a, b);
  return key === undefined ? 0 : BY_KEY[key](a, b);
}

/** The lower number first, a missing one last. */
function lowFirst(a: number | undefined, b: number | undefined): number {
  const x = a ?? Number.POSITIVE_INFINITY;
  const y = b ?? Number.POSITIVE_INFINITY;
  return x === y ? 0 : x < y ? -1 : 1;
}

/** The higher number first, a missing one last. */
function highFirst(a: number | undefined, b: number | undefined): number {
  return lowFirst(a === undefined ? undefined : -a, b === undefined ? undefined : -b);
}

/** A true flag first. */
function trueFirst(a: boolean | undefined, b: boolean | undefined): number {
  return Number(b === true) - Number(a === true);
}

/**
 * The fields of a task the tree reads. A reader that keeps rows of its own (a status pane) builds a tree from them as
 * from teamrig's folded tasks, and gets its own rows back from it; a row without `week`, `size` or `pin` counts as
 * untagged, unsized and unpinned, one without `type`, `critical` or `source` as a plain task no owner ordered, one
 * without `workClass` or `goals` as unclassed and serving no goal, one without `sizeBase` as sized before it spent, one
 * without `updatedAt` as never parked.
 */
export type TreeTask = Pick<Task, 'id' | 'status' | 'owner' | 'priority' | 'due' | 'after' | 'waits'> &
  Partial<
    Pick<Task, 'week' | 'size' | 'sizeBase' | 'pin' | 'type' | 'critical' | 'source' | 'workClass' | 'goals' | 'updatedAt'>
  >;

/**
 * How a tree ranks its tasks (T2076): the team's `focus` config and the per-task reads a score needs, built once per
 * register read. It stays out of a tree that only reads dues and needs; such a tree places every task with no band or
 * score ({@link PlanPlace}), and its rows show neither.
 */
export interface TreeRanking {
  readonly focus: ScoreFocus & ParkFocus;
  /** The `source` of a task the owner ordered. */
  readonly ownerSource: string;
  /** The work class a task counts as. */
  classOf(task: TreeTask): string;
  /** The ranked goal it serves; null: none. */
  goalOf(task: TreeTask): ServedGoal | null;
  /** What is known of its size. */
  sizingOf(task: TreeTask): SizeFacts;
}

/** The date a task works to: its own due, or an earlier one of a task that needs it. */
export interface EffectiveDue {
  /** As stored: `YYYY-MM-DD`, a day of the team's zone (its end there), or `YYYY-MM-DD HH:MM` in UTC. */
  readonly due: string;
  /** The same in ms. */
  readonly at: number;
  /** The task whose own due this is, or null when it is the task's own. */
  readonly from: string | null;
}

/**
 * Who moves first so a task can finish, on which task: the owner's work (`work`), the lead's or the owner's
 * decision or approval, or the owner again once a time passed (`time`, with `at`). `behind` is an in-progress task
 * of the same session with a higher priority than the move's task, which it works first. `elsewhere`: the move's
 * task needs `need`, an unfinished task of another register of the team tree, so `who`, its owner on `team`, moves.
 */
export type NextMove<T extends TreeTask = Task> =
  | { readonly kind: 'work' | PersonWaitKind; readonly who: string; readonly task: T; readonly behind: T | undefined }
  | { readonly kind: 'time'; readonly who: string; readonly task: T; readonly at: string; readonly behind: T | undefined }
  | { readonly kind: 'elsewhere'; readonly who: string; readonly team: string; readonly need: Task; readonly task: T; readonly behind: undefined };

/** A task another register of the team tree holds (one numbering across the tree, T1139), with that register's team. */
export interface TaskElsewhere {
  readonly team: string;
  readonly task: Task;
}

/** The tasks of a team tree's other registers by id, as one register's read asks them for an id it lacks. */
export type TasksElsewhere = ReadonlyMap<string, TaskElsewhere>;

/** What a register outside a team tree reads elsewhere: nothing. */
export const NO_TASKS_ELSEWHERE: TasksElsewhere = new Map();

/** One register's tasks and the tasks it reads elsewhere: what a {@link TaskTree} of a team tree is built from. */
export interface TreeRead {
  readonly tasks: ReadonlyMap<string, Task>;
  readonly elsewhere: TasksElsewhere;
}

/**
 * The team tree as team `holder` reads it, from a read of team `reader`'s register (its `own` tasks and what it read
 * `elsewhere`): the holder's tasks, and every other register's, the reader's own among them, as the holder's
 * elsewhere; so another team's task is judged as that team's sessions judge it. The reader's own task wins an id
 * another register holds too, which only a register numbered before its tree can have.
 */
export function readAs(holder: string, reader: string, own: Iterable<Task>, elsewhere: TasksElsewhere): TreeRead {
  const tasks = new Map<string, Task>();
  const others = new Map<string, TaskElsewhere>();
  for (const task of own) {
    others.set(task.id, { team: reader, task });
  }
  for (const [id, away] of elsewhere) {
    if (away.team === holder) {
      tasks.set(id, away.task);
    } else if (!others.has(id)) {
      others.set(id, away);
    }
  }
  return { tasks, elsewhere: others };
}

/** Another session's active task that waits on a session: on its unfinished tasks, or on its decision or approval. */
export interface WaitingOnYou<T extends TreeTask = Task> {
  readonly task: T;
  /** The session's unfinished tasks it needs directly, in plan order. */
  readonly needs: readonly T[];
  /** Its decisions and approvals asked of the session. */
  readonly asks: readonly PersonWait[];
}

/** What a task is worth by its class, goal and severity, as `ranking` reads them. */
function valueFacts(task: TreeTask, ranking: TreeRanking): ValueFacts {
  return { workClass: ranking.classOf(task), rank: ranking.goalOf(task)?.rank ?? null, type: task.type ?? null, critical: task.critical ?? false };
}

/**
 * The tree of one register read at `now`, over teamrig's tasks or a reader's own rows ({@link TreeTask}): what it
 * hands back (a needer, a move's task, a waiting task) is one of those rows.
 */
export class TaskTree<T extends TreeTask = Task> {
  /** How the same read judges a waiting task's reasons ready. */
  readonly context: WaitContext;
  /** The team's zone: a stored due day is a day of it, and rows show times in it. */
  readonly zone: TimeZone;
  /** The week plan in force, whose tasks plan order puts first after band, readiness, score, due and need; null: none. */
  readonly week: string | null;
  private readonly tasks: ReadonlyMap<string, T>;
  /** The tasks of the team tree's other registers, for a need this read lacks. */
  private readonly elsewhere: TasksElsewhere;
  /** Per id, the active tasks that need it, by number. */
  private readonly needers: ReadonlyMap<string, readonly T[]>;
  private readonly dues = new Map<string, EffectiveDue | undefined>();
  private readonly now: number;
  private readonly ranking: TreeRanking | undefined;
  /** Each place's score, kept because a sort reads every task's many times. */
  private readonly ranked = new Map<string, RankedPlace>();
  /** What the tree's active tasks need, built when a task first reaches the park rule's last test: few do. */
  private needed: ReadonlySet<string> | undefined;

  /**
   * `week` defaults to the newest week tag of `tasks` started by `now`; a register read passes the one it knows.
   * `elsewhere` holds the tasks of the team tree's other registers, which a need the read lacks is read from.
   * `ranking` gives its places a band and a score; a read that sorts or lists tasks passes one.
   */
  constructor(
    tasks: ReadonlyMap<string, T>,
    now: Date,
    zone: TimeZone,
    week: string | null = currentWeek(tasks.values(), now, zone),
    elsewhere: TasksElsewhere = NO_TASKS_ELSEWHERE,
    ranking?: TreeRanking,
  ) {
    this.tasks = tasks;
    this.elsewhere = elsewhere;
    this.zone = zone;
    this.week = week;
    this.now = now.getTime();
    this.ranking = ranking;
    this.context = waitContext(tasks, now, zone, elsewhere);
    const needers = new Map<string, T[]>();
    for (const task of [...tasks.values()].filter(isActive).sort((a, b) => taskNumber(a.id) - taskNumber(b.id))) {
      for (const id of needsOf(task)) {
        needers.set(id, [...(needers.get(id) ?? []), task]);
      }
    }
    this.needers = needers;
  }

  /** The task of the read; undefined when the read lacks it. */
  task(id: string): T | undefined {
    return this.tasks.get(id);
  }

  /** True when the park rule takes the task out of the lists ({@link wouldPark}); a tree with no ranking parks nothing. */
  isParked(task: T): boolean {
    const { ranking } = this;
    if (ranking === undefined) {
      return false;
    }
    return wouldPark(task, { focus: ranking.focus, ownerSource: ranking.ownerSource, now: this.now, needed: (id) => this.isNeeded(id) });
  }

  private isNeeded(id: string): boolean {
    this.needed ??= neededIds(this.tasks.values(), this.elsewhere);
    return this.needed.has(id);
  }

  /** The task another register of the team tree holds under an id the read lacks; undefined when the read has it or none does. */
  elsewhereOf(id: string): TaskElsewhere | undefined {
    return this.tasks.has(id) ? undefined : this.elsewhere.get(id);
  }

  /**
   * The ids the task needs first ({@link needsOf}); a need may be missing from the read: another register of the team
   * tree holds it, or it was retired, so finished.
   */
  needs(id: string): string[] {
    const task = this.tasks.get(id);
    return task === undefined ? [] : needsOf(task);
  }

  /** The active tasks that need it, by number. */
  neededBy(id: string): readonly T[] {
    return this.needers.get(id) ?? [];
  }

  /**
   * The best of the active tasks that need an active task ({@link Unblocks}); undefined for a finished task, one the
   * read lacks, or one nothing active needs.
   */
  unblocks(id: string): Unblocks | undefined {
    const needers = this.isActiveId(id) ? this.neededBy(id) : [];
    const best = Math.min(...needers.map((needer) => needer.priority));
    const first = needers.find((needer) => needer.priority === best);
    return first === undefined ? undefined : { first: first.id, priority: best, count: needers.length };
  }

  /**
   * Whom an active task holds up beyond its owner: the active tasks of other owners that need it, the one with the
   * earliest effective due first, then in plan order. Empty for a finished task or one the read lacks.
   */
  neededByOthers(id: string): T[] {
    const task = this.tasks.get(id);
    if (task === undefined || !isActive(task)) {
      return [];
    }
    const dueAt = (needer: T) => this.effectiveDue(needer.id)?.at ?? Number.POSITIVE_INFINITY;
    return this.neededBy(id)
      .filter((needer) => needer.owner !== task.owner)
      .sort((a, b) => (dueAt(a) === dueAt(b) ? this.byPlanOrder(a, b) : dueAt(a) < dueAt(b) ? -1 : 1));
  }

  /**
   * The earliest of the task's own due and the effective due of every active task that needs it, so work that holds
   * a dated task inherits its date; the task's own due wins a tie. A finished task keeps its own due only.
   * Undefined when neither the task nor anything needing it has a date (or the read lacks the task).
   */
  effectiveDue(id: string): EffectiveDue | undefined {
    if (!this.dues.has(id)) {
      this.dues.set(id, this.findDue(id));
    }
    return this.dues.get(id);
  }

  /** The task's effective deadline in ms, or undefined when it has none; a task the read lacks keeps its own. */
  dueTime(task: Pick<Task, 'id' | 'due'>): number | undefined {
    if (!this.tasks.has(task.id)) {
      return task.due === null ? undefined : parseDeadline(task.due, this.zone)?.getTime();
    }
    return this.effectiveDue(task.id)?.at;
  }

  /**
   * The task's place in plan order on its effective due, what it unblocks and this tree's week, for sorting rows of
   * several registers together, each placed by its own register's tree ({@link planOrder}).
   */
  placeOf(task: TreeTask): PlanPlace {
    return {
      id: task.id,
      pinned: task.pin !== undefined && task.pin !== null,
      ranked: this.rankedOf(task),
      blocked: this.isBlocked(task),
      at: this.dueTime(task),
      started: task.status === 'in-progress',
      unblocks: this.unblocks(task.id),
      inWeek: this.week !== null && task.week === this.week,
      size: task.size ?? null,
    };
  }

  /** Plan order ({@link PLAN_KEYS}) on effective dues, what each task unblocks and this tree's week. */
  byPlanOrder(a: TreeTask, b: TreeTask): number {
    return planOrder(this.placeOf(a), this.placeOf(b));
  }

  /** A task's band and score, and the class and goal they come from; undefined with no ranking. */
  rankedOf(task: TreeTask): RankedPlace | undefined {
    const { ranking } = this;
    if (ranking === undefined) {
      return undefined;
    }
    const known = this.ranked.get(task.id);
    if (known !== undefined) {
      return known;
    }
    const facts = valueFacts(task, ranking);
    const needers = this.isActiveId(task.id) ? this.neededBy(task.id) : [];
    const neededValue = needers.length === 0 ? undefined : Math.max(...needers.map((needer) => valueOf(valueFacts(needer, ranking), ranking.focus)));
    const score = scoreOf(
      { ...facts, priority: task.priority, ownerSourced: task.source === ranking.ownerSource, dueAt: this.dueTime(task), neededValue, sizing: ranking.sizingOf(task) },
      ranking.focus,
      this.now,
    );
    const place = { ...score, workClass: facts.workClass, goal: ranking.goalOf(task) };
    this.ranked.set(task.id, place);
    return place;
  }

  /** The tasks in plan order ({@link byPlanOrder}). */
  inPlanOrder<U extends TreeTask>(tasks: Iterable<U>): U[] {
    return [...tasks].sort((a, b) => this.byPlanOrder(a, b));
  }

  /**
   * The first move toward finishing the task: down its unfinished needs in plan order to one that needs nothing
   * unfinished in this read, whose unfinished need another register of the team tree holds comes first (its owner
   * there moves), then its pending decision or approval (the lead's or the owner's), then a time still to come, else
   * its owner's work. Undefined for a finished task, or when every unfinished need runs into a loop.
   */
  nextMove(id: string): NextMove<T> | undefined {
    return this.isActiveId(id) ? this.moveFrom(id, new Set()) : undefined;
  }

  /**
   * What waits on `session`: every active task of another owner that directly needs an unfinished task of the
   * session, or waits on its decision or approval, in plan order. A parked task is left out: `list` hides it, so a row
   * here would name work its owner cannot see.
   */
  waitingOn(session: string): WaitingOnYou<T>[] {
    const waiting = [...this.tasks.values()].flatMap((task) => {
      if (!isActive(task) || task.owner === session || this.isParked(task)) {
        return [];
      }
      const needs = this.inPlanOrder(this.unfinishedNeeds(task).filter((need) => need.owner === session));
      const asks = task.waits.filter((reason): reason is PersonWait => (reason.kind === 'decision' || reason.kind === 'approval') && reason.who === session);
      return needs.length === 0 && asks.length === 0 ? [] : [{ task, needs, asks }];
    });
    return waiting.sort((a, b) => this.byPlanOrder(a.task, b.task));
  }

  /**
   * The loops among active tasks, which none of their tasks can ever leave: each the shortest chain from its first
   * task back to it (`[T2, T194, T2]`), the first task the lowest-numbered one not already in a loop found.
   */
  loops(): string[][] {
    const inLoop = new Set<string>();
    const loops: string[][] = [];
    const active = [...this.tasks.values()].filter(isActive).sort((a, b) => taskNumber(a.id) - taskNumber(b.id));
    for (const task of active) {
      const back = inLoop.has(task.id) ? undefined : this.loopThrough(task.id);
      if (back !== undefined) {
        back.forEach((id) => inLoop.add(id));
        loops.push(back);
      }
    }
    return loops;
  }

  private loopThrough(id: string): string[] | undefined {
    for (const need of this.activeNeeds(id)) {
      const path = shortestPath(need, id, (next) => this.activeNeeds(next));
      if (path !== undefined) {
        return [id, ...path];
      }
    }
    return undefined;
  }

  /** The needs of the task that are active, as a loop among active tasks follows them. */
  private activeNeeds(id: string): string[] {
    return this.needs(id).filter((need) => this.isActiveId(need));
  }

  private unfinishedNeeds(task: T): T[] {
    return needsOf(task).flatMap((id) => {
      const need = this.tasks.get(id);
      return need !== undefined && !isFinished(id, this.context) ? [need] : [];
    });
  }

  /** The task's first unfinished need, in {@link needsOf} order, that this read lacks and another register holds. */
  private unfinishedElsewhere(task: T): TaskElsewhere | undefined {
    return needsOf(task)
      .flatMap((id) => this.elsewhereOf(id) ?? [])
      .find((away) => !isFinished(away.task.id, this.context));
  }

  private moveFrom(id: string, seen: Set<string>): NextMove<T> | undefined {
    const task = this.tasks.get(id);
    if (task === undefined) {
      return undefined;
    }
    seen.add(id);
    const needs = this.inPlanOrder(this.unfinishedNeeds(task));
    if (needs.length > 0) {
      for (const need of needs.filter((candidate) => !seen.has(candidate.id))) {
        const move = this.moveFrom(need.id, seen);
        if (move !== undefined) {
          return move;
        }
      }
      return undefined;
    }
    const away = this.unfinishedElsewhere(task);
    if (away !== undefined) {
      return { kind: 'elsewhere', who: away.task.owner, team: away.team, need: away.task, task, behind: undefined };
    }
    const pending = task.waits.filter((reason) => !isReady(reason, this.context));
    const person = pending.find((reason): reason is PersonWait => reason.kind === 'decision' || reason.kind === 'approval');
    if (person !== undefined) {
      return { kind: person.kind, who: person.who, task, behind: this.behind(person.who, task) };
    }
    const time = pending.find((reason) => reason.kind === 'time');
    return time?.kind === 'time'
      ? { kind: 'time', who: task.owner, task, at: time.at, behind: this.behind(task.owner, task) }
      : { kind: 'work', who: task.owner, task, behind: this.behind(task.owner, task) };
  }

  /** The first in plan order of the in-progress tasks of `who` with a higher priority than `task`. */
  private behind(who: string, task: T): T | undefined {
    const ahead = [...this.tasks.values()].filter(
      (other) => other.owner === who && other.status === 'in-progress' && other.id !== task.id && other.priority < task.priority,
    );
    return this.inPlanOrder(ahead)[0];
  }

  private findDue(id: string): EffectiveDue | undefined {
    const task = this.tasks.get(id);
    if (task === undefined) {
      return undefined;
    }
    let best = ownDue(task, null, this.zone);
    if (!isActive(task)) {
      return best;
    }
    // Upward over every active task that needs it, directly or not, each once; a nearer or lower-numbered one wins a tie.
    const seen = new Set([id]);
    const queue = [...this.neededBy(id)];
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
      if (seen.has(next.id)) {
        continue;
      }
      seen.add(next.id);
      const due = ownDue(next, next.id, this.zone);
      if (due !== undefined && (best === undefined || due.at < best.at)) {
        best = due;
      }
      queue.push(...this.neededBy(next.id));
    }
    return best;
  }

  private isActiveId(id: string): boolean {
    const task = this.tasks.get(id);
    return task !== undefined && isActive(task);
  }

  /** True for an active task with a need not finished here or in another register; a wait on a person or a time is no need. */
  private isBlocked(task: TreeTask): boolean {
    return isActive(task) && needsOf(task).some((id) => !isFinished(id, this.context));
  }
}

function isActive(task: Pick<Task, 'status'>): boolean {
  return ACTIVE_STATUSES.includes(task.status);
}

/** The task's own due as an effective due from `from`, read in `zone`; undefined when it has none or it does not parse. */
function ownDue(task: Pick<Task, 'due'>, from: string | null, zone: TimeZone): EffectiveDue | undefined {
  const at = task.due === null ? undefined : parseDeadline(task.due, zone)?.getTime();
  return task.due === null || at === undefined ? undefined : { due: task.due, at, from };
}

/** Breadth first from `from` along `next` to `to`: the shortest chain, both ends included; undefined when none. */
function shortestPath(from: string, to: string, next: (id: string) => readonly string[]): string[] | undefined {
  const cameFrom = new Map<string, string | null>([[from, null]]);
  const queue = [from];
  for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
    if (id === to) {
      const path: string[] = [];
      for (let step: string | null | undefined = id; step !== null && step !== undefined; step = cameFrom.get(step)) {
        path.unshift(step);
      }
      return path;
    }
    for (const following of next(id)) {
      if (!cameFrom.has(following)) {
        cameFrom.set(following, id);
        queue.push(following);
      }
    }
  }
  return undefined;
}
