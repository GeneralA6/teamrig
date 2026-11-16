import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TimeZone } from '../core/zone.ts';
import { testRanking } from '../testing/ranking.ts';
import { testTask } from '../testing/task.ts';
import type { Task } from './fold.ts';
import { foldGoals, type GoalRecord, type GoalSliceRecord } from './goals.ts';
import { sliceLateFlags } from './slice-late.ts';
import { NO_TASKS_ELSEWHERE, TaskTree } from './tree.ts';

const NOW = new Date('2030-01-16T12:00:00.000Z');

const SLICE: GoalSliceRecord = {
  type: 'goal-slice',
  at: '2030-01-09T10:00:00.000Z',
  by: 'lead',
  tag: 'A1',
  slice: 1,
  title: 'Pane reads slices',
  owner: 'tr-pane',
  ship: '2030-01-15',
  proof: 'the pane shows A1:1 live',
  tasks: ['T10', 'T11', 'T12'],
  size: null,
  proven: null,
  note: 'first slice',
};

const ADD: GoalRecord = { type: 'goal-add', at: '2030-01-08T10:00:00.000Z', by: 'lead', tag: 'A1', title: 'Goal A1', start: '2030-01-08', target: '2030-01-31', parent: null };
const RECORDS: readonly GoalRecord[] = [ADD, SLICE];

function flagsOf(records: readonly GoalRecord[], tasks: readonly Task[]): string[] {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const tree = new TaskTree(byId, NOW, TimeZone.UTC, null, NO_TASKS_ELSEWHERE, testRanking());
  return sliceLateFlags(foldGoals(records).goals, byId, tree, '2030-01-16').map((flag) => `${flag.kind} ${flag.task.id}: ${flag.detail}`);
}

describe('sliceLateFlags', () => {
  it("flags a late slice on its first active task in plan order, naming how to prove it or move its ship day", () => {
    const tasks = [testTask({ id: 'T10', status: 'done' }), testTask({ id: 'T11' }), testTask({ id: 'T12', status: 'in-progress' })];
    assert.deepEqual(flagsOf(RECORDS, tasks), [
      'SLICE-LATE T12: slice A1:1 Pane reads slices, owner tr-pane, was to ship 2030-01-15 and its proof is not recorded: once it shows, goal slice A1 1 --proven "<evidence>"; else the lead moves its --ship',
    ]);
  });

  it('falls back to its first task the register holds once none is active, and raises none when it holds none', () => {
    assert.deepEqual(
      flagsOf(RECORDS, [testTask({ id: 'T11', status: 'done' }), testTask({ id: 'T12', status: 'done' })]).map((line) => line.slice(0, 15)),
      ['SLICE-LATE T11:'],
    );
    assert.deepEqual(flagsOf(RECORDS, [testTask({ id: 'T99' })]), []);
  });

  it('raises none for a slice due today or proven', () => {
    const tasks = [testTask({ id: 'T10' })];
    assert.deepEqual(flagsOf([ADD, { ...SLICE, ship: '2030-01-16' }], tasks), []);
    assert.deepEqual(flagsOf([...RECORDS, { ...SLICE, at: '2030-01-14T10:00:00.000Z', title: null, owner: null, ship: null, proof: null, tasks: null, proven: 'shown live' }], tasks), []);
  });
});
