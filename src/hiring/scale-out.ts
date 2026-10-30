import type { Surplus } from '../budget/burst.ts';
import { formatPct } from '../budget/format.ts';
import { NOW_PRIORITY } from '../config/priorities.ts';
import type { KitConfig } from '../config/types.ts';
import { KIT_NAME } from '../core/home.ts';
import { MS_PER_DAY, showStored } from '../core/time.ts';
import type { TimeZone } from '../core/zone.ts';
import type { Task } from '../register/fold.ts';
import { ACTIVE_STATUSES, type TaskStatus } from '../register/model.ts';
import type { TaskTree } from '../register/tree.ts';
import type { HireCheckInput, HireFlag } from './due.ts';
import { ownerAsk } from '../config/tree.ts';

/**
 * SCALE-OUT, the `check` flag on an area that cannot finish its dated work in time. Its pace is the tasks it finished
 * over the last `hiring.scaleOut.windowDays` (measured once it finished `minDone`); its dated work is its active tasks
 * of the top `topPriorities` priorities with an effective due, their own or that of a task that needs them, so work
 * other areas wait on counts too. Walking that work by due date, wherever more is due by a date than the pace finishes
 * by then, a slice moves out: the latest open tasks due by that date that no started task needs (none mid-change),
 * until every date fits. The slice costs a new hire's part of the team's daily budget today (`hirePct`) a day until
 * its last due or the week's pace end, whichever comes first (a day at least), and goes to an idle hire first, else to
 * a new hire (`hire --yes` checks the host has room for it). No flag while the team's
 * part of the week's projected spare cannot pay the cost (the areas furthest behind pay first), with no reading of the week or of the
 * team's daily budget, under `hiring.policy` off, or for the lead or a hired session. A hire whose slice is done, or
 * that got none, stays on the team, idle, for the next slice: the idle pass (src/cli/idle-pass.ts) deactivates it, and
 * only a burst hire is due to retire, once its burst is over (src/hiring/due.ts). Pure: it takes the team's tasks and
 * tree, the hires still active, the week's surplus, a hire's daily part and now.
 */

export interface ScaleOutInput extends HireCheckInput {
  readonly tasks: Iterable<Task>;
  readonly tree: TaskTree;
  readonly config: Pick<KitConfig, 'sessions' | 'roles' | 'hiring' | 'register' | 'team'>;
  /** The week's projected surplus, its spare the team's part of the account's (src/budget/burst.ts `surplusOf`); undefined with no reading of the week. */
  readonly spare: Pick<Surplus, 'sparePct' | 'paceEnd'> | undefined;
  /**
   * A new hire's part of the team's daily budget today, in percent of the week like `spare` (src/budget/parts.ts
   * `addedSessionPct`): what a slice costs a day. Undefined while the team's daily budget is unknown.
   */
  readonly hirePct: number | undefined;
}

/** Statuses of work under way: a task such work needs stays with its area. */
const STARTED: readonly TaskStatus[] = ['in-progress', 'waiting', 'verifying'];

/** A count past what the pace finishes by more than this rounding is behind. */
const EPSILON = 1e-9;

interface Dated {
  readonly task: Task;
  /** Its effective due, in ms. */
  readonly at: number;
  readonly due: string;
}

/** Where an area falls furthest behind: the work due by a date against what its pace finishes by then. */
interface Behind {
  readonly due: string;
  readonly count: number;
  readonly finishes: number;
}

interface AreaNeed {
  readonly area: string;
  readonly done: number;
  readonly behind: Behind;
  readonly slice: readonly Dated[];
  /** The slice's latest task: the work walks by due date, so its last. */
  readonly last: Dated;
  /** Tasks still past their dates once the slice moves: started, or needed by started work. */
  readonly stuck: number;
}

/** p0, and the config's `hiring.scaleOut.topPriorities` most urgent levels: p0 takes none of those places. */
function topPriorityIds(config: ScaleOutInput['config']): ReadonlySet<number> {
  const ids = config.register.priorities.map((priority) => priority.id).sort((a, b) => a - b);
  return new Set([NOW_PRIORITY.id, ...ids.slice(0, config.hiring.scaleOut.topPriorities)]);
}

/** The area's active tasks of the top priorities with an effective due, by that due, then in plan order. */
function datedWork(area: string, tasks: readonly Task[], input: ScaleOutInput): Dated[] {
  const top = topPriorityIds(input.config);
  return tasks
    .filter((task) => task.owner === area && ACTIVE_STATUSES.includes(task.status) && top.has(task.priority))
    .flatMap((task) => {
      const effective = input.tree.effectiveDue(task.id);
      return effective === undefined ? [] : [{ task, at: effective.at, due: effective.due }];
    })
    .sort((a, b) => a.at - b.at || input.tree.byPlanOrder(a.task, b.task));
}

function isMovable(task: Task, tree: TaskTree): boolean {
  return task.status === 'open' && !tree.neededBy(task.id).some((needer) => STARTED.includes(needer.status));
}

/** What the pace finishes from now until `at`: none for a date passed. */
function finishesBy(pace: number, now: number, at: number): number {
  return (pace * Math.max(0, at - now)) / MS_PER_DAY;
}

/**
 * The slice to move: walking the work by due date, while more is due by a date than the pace finishes by then, the
 * latest movable task due by that date moves out. What is still behind after every movable task moved is stuck.
 */
function sliceOf(work: readonly Dated[], pace: number, now: number, tree: TaskTree): { slice: Dated[]; stuck: number } {
  const moved = new Set<Dated>();
  let stuck = 0;
  work.forEach((item, index) => {
    const finishes = finishesBy(pace, now, item.at);
    const late = () => index + 1 - moved.size - finishes;
    for (const candidate of work.slice(0, index + 1).reverse()) {
      if (late() <= EPSILON) {
        break;
      }
      if (!moved.has(candidate) && isMovable(candidate.task, tree)) {
        moved.add(candidate);
      }
    }
    stuck = Math.max(stuck, Math.ceil(late() - EPSILON));
  });
  return { slice: work.filter((item) => moved.has(item)), stuck };
}

/** The date the area is furthest behind on, before any task moves. */
function behindOf(work: readonly Dated[], pace: number, now: number): Behind | undefined {
  let worst: Behind | undefined;
  work.forEach((item, index) => {
    const finishes = finishesBy(pace, now, item.at);
    if (index + 1 > finishes + EPSILON && (worst === undefined || index + 1 - finishes > worst.count - worst.finishes)) {
      worst = { due: item.due, count: index + 1, finishes };
    }
  });
  return worst;
}

function needOf(area: string, tasks: readonly Task[], input: ScaleOutInput): AreaNeed | undefined {
  const { windowDays, minDone } = input.config.hiring.scaleOut;
  const now = input.now.getTime();
  const since = now - windowDays * MS_PER_DAY;
  const done = tasks.filter((task) => task.owner === area && task.status === 'done' && Date.parse(task.statusAt) >= since).length;
  if (done < minDone) {
    return undefined;
  }
  const pace = done / windowDays;
  const work = datedWork(area, tasks, input);
  const behind = behindOf(work, pace, now);
  if (behind === undefined) {
    return undefined;
  }
  const { slice, stuck } = sliceOf(work, pace, now, input.tree);
  const last = slice.at(-1);
  return last === undefined ? undefined : { area, done, behind, slice, last, stuck };
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

/** A scale-out flag's detail, its dues in the team's `zone`. */
function detailOf(need: AreaNeed, windowDays: number, costPct: number, sparePct: number, zone: TimeZone): string {
  const { behind, slice, last, stuck } = need;
  const ids = slice.map((item) => item.task.id).join(' ');
  const stuckText = stuck > 0 ? `; ${stuck} more stay late: started, or needed by started work` : '';
  return (
    `${behind.count} due by ${showStored(behind.due, zone)}, its pace finishes ${round(behind.finishes)} by then (${need.done} done in ${windowDays} d); ` +
    `slice ${ids}, due by ${showStored(last.due, zone)}, about ${formatPct(costPct)} of the week, ${formatPct(sparePct)} spare${stuckText}`
  );
}

/** The days of this week the slice runs: from now to its last due or the pace end, whichever comes first; one at least. */
function sliceDays(last: Dated, now: number, paceEnd: number): number {
  return Math.max(1, Math.ceil((Math.min(paceEnd, last.at) - now) / MS_PER_DAY));
}

/** The hires on the team that hold no active task and are not due to retire for a burst over. */
function idleHires(input: ScaleOutInput, tasks: readonly Task[]): string[] {
  return input.hires
    .filter((hire) => input.config.sessions.includes(hire.session) && !(hire.burst !== undefined && input.burstsOver.has(hire.burst)))
    .filter((hire) => !tasks.some((task) => task.owner === hire.session && ACTIVE_STATUSES.includes(task.status)))
    .map((hire) => hire.session);
}

function moveAction(to: string): string {
  return `the lead moves the slice to ${to}, an idle hire (${KIT_NAME} update <id> --owner ${to}, for each)`;
}

function hireAction(config: ScaleOutInput['config']): string {
  const owner = config.hiring.policy === 'owner';
  const hire = `${KIT_NAME} hire <new id> --scope "<the slice>" --reason "SCALE-OUT"${owner ? ' --approved-by "<who>"' : ''}`;
  return `the lead ${owner ? `asks ${ownerAsk(config)}, then ` : ''}hires for it (${hire}), then ${KIT_NAME} update <id> --owner <new id>, for each`;
}

/** SCALE-OUT on each area that needs one, within the spare, the one furthest behind first; an idle hire takes one slice. */
export function scaleOutFlags(input: ScaleOutInput): HireFlag[] {
  const { config, hirePct } = input;
  if (config.hiring.policy === 'off') {
    return [];
  }
  const tasks = [...input.tasks];
  const hiredOnTeam = new Set(input.hires.filter((hire) => config.sessions.includes(hire.session)).map((hire) => hire.session));
  const needs = config.sessions
    .filter((area) => area !== config.roles.lead && !hiredOnTeam.has(area))
    .flatMap((area) => needOf(area, tasks, input) ?? [])
    .sort((a, b) => b.behind.count - b.behind.finishes - (a.behind.count - a.behind.finishes));
  const idle = idleHires(input, tasks);
  const busy = new Set<string>();
  const flags: HireFlag[] = [];
  if (input.spare === undefined || hirePct === undefined) {
    return [];
  }
  const { paceEnd } = input.spare;
  let spare = input.spare.sparePct;
  const now = input.now.getTime();
  for (const need of needs) {
    const costPct = hirePct * sliceDays(need.last, now, paceEnd);
    if (spare < costPct) {
      continue;
    }
    const detail = detailOf(need, config.hiring.scaleOut.windowDays, costPct, spare, input.tree.zone);
    spare -= costPct;
    const to = idle.find((session) => !busy.has(session));
    if (to !== undefined) {
      busy.add(to);
      flags.push({ kind: 'SCALE-OUT', session: need.area, detail, action: moveAction(to) });
      continue;
    }
    flags.push({ kind: 'SCALE-OUT', session: need.area, detail, action: hireAction(config) });
  }
  return flags;
}
