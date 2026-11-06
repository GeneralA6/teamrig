import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_FOCUS } from '../config/defaults.ts';
import { MS_PER_DAY } from '../core/time.ts';
import { TimeZone } from '../core/zone.ts';
import { testTask } from '../testing/task.ts';
import type { Task } from './fold.ts';
import { goalScores, isLate, type BoardTeam, type GoalScore } from './goal-board.ts';
import type { Goal, GoalSlip } from './goals.ts';
import { TaskTree } from './tree.ts';

const NOW = Date.parse('2030-01-08T10:00:00Z');

function goalOf(tag: string, rank: number | null, parent: string | null = null, slips: readonly GoalSlip[] = []): Goal {
  return { tag, title: `Goal ${tag}`, start: '2030-01-01', target: '2030-02-01', parent, addedAt: '2030-01-01T10:00:00.000Z', addedBy: 'lead', slips, rank };
}

function mapOf(goals: readonly Goal[]): ReadonlyMap<string, Goal> {
  return new Map(goals.map((goal) => [goal.tag, goal]));
}

interface TeamFacts {
  readonly team?: string;
  /** Every task of the history; `working` names those a compaction left, all of them by default. */
  readonly tasks: readonly Task[];
  readonly working?: readonly Task[];
  readonly goals: ReadonlyMap<string, Goal>;
  readonly spent?: ReadonlyMap<string, number>;
  readonly likeMedianPct?: number;
}

function teamOf({ team, tasks, working = tasks, goals, spent = new Map(), likeMedianPct }: TeamFacts): BoardTeam {
  return {
    team,
    tasks,
    tree: new TaskTree(new Map(working.map((task) => [task.id, task])), new Date(NOW), TimeZone.UTC),
    goals,
    ranking: { focus: DEFAULT_FOCUS, sizingOf: (task) => ({ size: task.size ?? null, spentPct: spent.get(task.id) ?? 0, likeMedianPct }) },
  };
}

function onlyRow(rows: readonly GoalScore[]): GoalScore {
  const [row, ...rest] = rows;
  assert.ok(row !== undefined && rest.length === 0, `one row, got ${rows.length}`);
  return row;
}

describe('the goal scoreboard (T2092)', () => {
  it('lists the ranked goals, best rank first, a tie in the order added, and leaves the unranked out', () => {
    const goals = mapOf([goalOf('C1', 2), goalOf('D1', null), goalOf('A1', 1), goalOf('B1', 2)]);
    const rows = goalScores(goals, [teamOf({ tasks: [], goals })], NOW);
    assert.deepEqual(
      rows.map((row) => row.tag),
      ['A1', 'C1', 'B1'],
    );
  });

  it('says what a goal is, with nothing counted when no task serves it', () => {
    const goals = mapOf([goalOf('A1', 1)]);
    assert.deepEqual(goalScores(goals, [teamOf({ tasks: [testTask({ goals: ['B1'] })], goals })], NOW), [
      { tag: 'A1', title: 'Goal A1', rank: 1, target: '2030-02-01', done: 0, total: 0, spentPct: 0, sizePct: 0, slips: 0, overdue: 0, waiting: [] },
    ]);
  });

  it("counts a task on a key result toward its objective too, and a task on the objective not toward the key result", () => {
    const goals = mapOf([goalOf('A1', 1), goalOf('A1.1', 2, 'A1')]);
    const rows = goalScores(goals, [teamOf({ tasks: [testTask({ id: 'T1', goals: ['A1.1'] }), testTask({ id: 'T2', goals: ['A1'] })], goals })], NOW);
    assert.deepEqual(
      rows.map((row) => [row.tag, row.total]),
      [
        ['A1', 2],
        ['A1.1', 1],
      ],
    );
  });

  it('counts a task that names two parts of a goal once', () => {
    const goals = mapOf([goalOf('A1', 1), goalOf('A1.1', null, 'A1'), goalOf('A1.2', null, 'A1')]);
    const row = onlyRow(goalScores(goals, [teamOf({ tasks: [testTask({ goals: ['A1.1', 'A1.2'] })], goals })], NOW));
    assert.equal(row.total, 1);
  });

  it('counts done and total over the whole history, so a compaction never lowers them, and leaves a dropped task out', () => {
    const goals = mapOf([goalOf('A1', 1)]);
    const retired = testTask({ id: 'T1', goals: ['A1'], status: 'done' });
    const live = testTask({ id: 'T2', goals: ['A1'] });
    const dropped = testTask({ id: 'T3', goals: ['A1'], status: 'dropped' });
    const row = onlyRow(goalScores(goals, [teamOf({ tasks: [retired, live, dropped], working: [live, dropped], goals })], NOW));
    assert.deepEqual([row.done, row.total], [1, 2]);
  });

  it('reads spend and size from the working set alone, as the meter keeps 8 days', () => {
    const goals = mapOf([goalOf('A1', 1)]);
    const retired = testTask({ id: 'T1', goals: ['A1'], status: 'done', size: 5 });
    const live = testTask({ id: 'T2', goals: ['A1'], size: 2 });
    const spent = new Map([
      ['T1', 9],
      ['T2', 0.5],
    ]);
    const row = onlyRow(goalScores(goals, [teamOf({ tasks: [retired, live], working: [live], goals, spent })], NOW));
    assert.deepEqual([row.spentPct, row.sizePct], [0.5, 2]);
  });

  it("sizes a task with no size by the team's chain, what like tasks took, else the default, and takes nothing off for its spend", () => {
    const goals = mapOf([goalOf('A1', 1)]);
    const spent = new Map([['T1', 0.5]]);
    const tasks = [testTask({ id: 'T1', goals: ['A1'] }), testTask({ id: 'T2', goals: ['A1'] })];
    assert.equal(onlyRow(goalScores(goals, [teamOf({ tasks, goals, spent })], NOW)).sizePct, 2 * DEFAULT_FOCUS.score.defaultSizePct);
    assert.equal(onlyRow(goalScores(goals, [teamOf({ tasks, goals, spent, likeMedianPct: 4 })], NOW)).sizePct, 8);
  });

  it("counts the goal's target moves as slips", () => {
    const slip: GoalSlip = { at: '2030-01-05T10:00:00.000Z', by: 'lead', from: '2030-01-20', to: '2030-02-01', note: 'scope grew' };
    const goals = mapOf([goalOf('A1', 1, null, [slip, slip])]);
    assert.equal(onlyRow(goalScores(goals, [teamOf({ tasks: [], goals })], NOW)).slips, 2);
  });

  it('counts the active tasks past their effective due, and not a finished one', () => {
    const goals = mapOf([goalOf('A1', 1)]);
    const late = testTask({ id: 'T1', goals: ['A1'], due: '2030-01-07' });
    const inherited = testTask({ id: 'T2', goals: ['A1'] });
    const needer = testTask({ id: 'T3', due: '2030-01-07', after: ['T2'] });
    const finished = testTask({ id: 'T4', goals: ['A1'], due: '2030-01-07', status: 'done' });
    const onTime = testTask({ id: 'T5', goals: ['A1'], due: '2030-01-09' });
    assert.equal(onlyRow(goalScores(goals, [teamOf({ tasks: [late, inherited, needer, finished, onTime], goals })], NOW)).overdue, 2);
  });

  it('names the waiting tasks in plan order, a team under the meeting after its own by <team>/<id>', () => {
    const goals = mapOf([goalOf('A1', 1)]);
    const waiting = { goals: ['A1'], status: 'waiting' as const, waits: [{ kind: 'time' as const, at: '2030-02-01 09:00' }] };
    const own = [testTask({ ...waiting, id: 'T2', priority: 3 }), testTask({ ...waiting, id: 'T1', priority: 1 }), testTask({ id: 'T3', goals: ['A1'] })];
    const web = [testTask({ ...waiting, id: 'T7' })];
    const row = onlyRow(goalScores(goals, [teamOf({ tasks: own, goals }), teamOf({ team: 'web', tasks: web, goals })], NOW));
    assert.deepEqual(row.waiting, ['T1', 'T2', 'web/T7']);
    assert.equal(row.total, 4);
  });

  it("reads a task of a team under the meeting through that team's own goals", () => {
    const goals = mapOf([goalOf('A1', 1)]);
    const below = mapOf([goalOf('A1', 1), goalOf('W1', null, 'A1')]);
    const row = onlyRow(goalScores(goals, [teamOf({ tasks: [], goals }), teamOf({ team: 'web', tasks: [testTask({ goals: ['W1'] })], goals: below })], NOW));
    assert.equal(row.total, 1);
  });
});

describe('isLate (T2092)', () => {
  const treeOf = (tasks: readonly Task[]): TaskTree => new TaskTree(new Map(tasks.map((task) => [task.id, task])), new Date(NOW), TimeZone.UTC);

  it('holds for an active task past its due, not before it and not with none', () => {
    const late = testTask({ id: 'T1', due: '2030-01-07' });
    const onTime = testTask({ id: 'T2', due: '2030-01-09' });
    const undated = testTask({ id: 'T3' });
    const tree = treeOf([late, onTime, undated]);
    assert.equal(isLate(late, tree, NOW), true);
    assert.equal(isLate(late, tree, NOW - 7 * MS_PER_DAY), false);
    assert.equal(isLate(onTime, tree, NOW), false);
    assert.equal(isLate(undated, tree, NOW), false);
  });
});
