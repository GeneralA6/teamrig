import { goalChain } from './focus.ts';
import type { Task } from './fold.ts';
import type { Goal } from './goals.ts';
import { ACTIVE_STATUSES } from './model.ts';
import { sizePctOf } from './score.ts';
import type { TaskTree, TreeRanking } from './tree.ts';
import { taskLabel } from './views.ts';

/**
 * The goal scoreboard the daily agenda opens with (T2076 2D): for each ranked goal, how far its work has come, what it
 * spent against its size, what puts its target at risk and what holds it up. Pure: the caller reads the goals, the
 * registers and each register's history.
 */

/** A register a scoreboard counts tasks from. */
export interface BoardTeam {
  /** Its name for a register under the meeting's, which labels its tasks (`web/T5`); undefined for the meeting's own. */
  readonly team: string | undefined;
  /** Its whole history: a compaction retires a done task after 8 days, and a done count read from less would fall. */
  readonly tasks: readonly Task[];
  /** Its working set, the only tasks the meter still knows: spend and size count these alone. */
  readonly tree: TaskTree;
  /** The goals its tasks may serve, which a team under the meeting's reads through its own chain. */
  readonly goals: ReadonlyMap<string, Pick<Goal, 'parent'>>;
  readonly ranking: Pick<TreeRanking, 'focus' | 'sizingOf'>;
}

/** One goal's row. */
export interface GoalScore {
  readonly tag: string;
  readonly title: string;
  readonly rank: number;
  readonly target: string;
  /** Its tasks, dropped ones left out, and how many of them are done. */
  readonly done: number;
  readonly total: number;
  /** In percent of the week. */
  readonly spentPct: number;
  readonly sizePct: number;
  /** How many times its target moved. */
  readonly slips: number;
  /** Its active tasks past their effective due. */
  readonly overdue: number;
  /** Its waiting tasks, in plan order, each team's after the one before. */
  readonly waiting: readonly string[];
}

type RankedRecord = Goal & { readonly rank: number };

function isRanked(goal: Goal): goal is RankedRecord {
  return goal.rank !== null;
}

/** True for an active task past its effective due: its own, or an earlier one of a task that needs it. */
export function isLate(task: Task, tree: TaskTree, now: number): boolean {
  return ACTIVE_STATUSES.includes(task.status) && (tree.dueTime(task) ?? Number.POSITIVE_INFINITY) < now;
}

/** A team's tasks that serve a goal: any of their tags, or a goal up that tag's chain. A dropped task serves nothing. */
function servingTasks(team: BoardTeam, tag: string): Task[] {
  return team.tasks.filter((task) => task.status !== 'dropped' && task.goals.some((own) => goalChain(own, team.goals).some(([at]) => at === tag)));
}

function total(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0);
}

function goalScore(goal: RankedRecord, teams: readonly BoardTeam[], now: number): GoalScore {
  const serving = teams.map((team) => ({ team, tasks: servingTasks(team, goal.tag) }));
  const tasks = serving.flatMap((read) => read.tasks);
  const sized = serving.flatMap(({ team, tasks: own }) =>
    own
      .filter((task) => team.tree.task(task.id) !== undefined)
      .map((task) => {
        const facts = team.ranking.sizingOf(task);
        return { spentPct: facts.spentPct, sizePct: sizePctOf(facts, team.ranking.focus.score) };
      }),
  );
  return {
    tag: goal.tag,
    title: goal.title,
    rank: goal.rank,
    target: goal.target,
    done: tasks.filter((task) => task.status === 'done').length,
    total: tasks.length,
    spentPct: total(sized.map((facts) => facts.spentPct)),
    sizePct: total(sized.map((facts) => facts.sizePct)),
    slips: goal.slips.length,
    overdue: serving.flatMap(({ team, tasks: own }) => own.filter((task) => isLate(task, team.tree, now))).length,
    waiting: serving.flatMap(({ team, tasks: own }) => team.tree.inPlanOrder(own.filter((task) => task.status === 'waiting')).map((task) => taskLabel(task, team.team))),
  };
}

/**
 * The rows of a meeting's ranked goals, best rank first, a tie in the order added. `goals` are the root team's, as the
 * meeting is the root lead's; a tag a team under it also holds reads as one row, by tag.
 */
export function goalScores(goals: ReadonlyMap<string, Goal>, teams: readonly BoardTeam[], now: number): GoalScore[] {
  return [...goals.values()]
    .filter(isRanked)
    .sort((a, b) => a.rank - b.rank)
    .map((goal) => goalScore(goal, teams, now));
}
