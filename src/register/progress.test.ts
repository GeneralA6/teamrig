import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG_LIMITS } from '../config/limits.ts';
import { TimeZone } from '../core/zone.ts';
import { testTask } from '../testing/task.ts';
import { JERUSALEM } from '../testing/zone.ts';
import { RETAIN_DAYS } from './compaction.ts';
import type { Task } from './fold.ts';
import { noProgressFlag, type ProgressInput } from './progress.ts';
import { TaskTree } from './tree.ts';

const NOW = new Date('2030-01-10T12:00:00.000Z');
const DAY_START = Date.parse('2030-01-10T00:00:00.000Z');
/** Inside the span of one day: after the start of the day before. */
const YESTERDAY = '2030-01-09T15:00:00.000Z';
/** Before the span of one day. */
const EARLIER = '2030-01-08T15:00:00.000Z';

function flagOf(tasks: readonly Task[], overrides: Partial<Omit<ProgressInput, 'tasks' | 'tree'>> = {}, zone = TimeZone.UTC): string | undefined {
  const tree = new TaskTree(new Map(tasks.map((task) => [task.id, task])), NOW, zone);
  const flag = noProgressFlag({ tasks, tree, dayStart: DAY_START, days: 1, leftPct: 40, ...overrides });
  return flag === undefined ? undefined : `${flag.kind} ${flag.task.id} (${flag.detail})`;
}

const planned = (overrides: Partial<Task> = {}): Task => testTask({ goals: ['G1'], ...overrides });

describe('noProgressFlag', () => {
  it('flags the first planned task when no planned task moved since the start of the day before', () => {
    assert.equal(flagOf([planned()]), 'NO-PROGRESS T1 (no goal or week-plan task moved since 01-09 00:00 UTC (1 day); the first to move)');
    assert.equal(flagOf([testTask({ week: '2030-01-07' })]), 'NO-PROGRESS T1 (no goal or week-plan task moved since 01-09 00:00 UTC (1 day); the first to move)', 'a week tag plans it too');
  });

  it("writes the span's start on the team's clock", () => {
    assert.equal(flagOf([planned()], {}, JERUSALEM), 'NO-PROGRESS T1 (no goal or week-plan task moved since 01-09 02:00 IST (1 day); the first to move)');
  });

  it('raises nothing once its owner started, noted, handed on, shipped or closed a planned task in the span', () => {
    for (const status of ['in-progress', 'waiting', 'verifying', 'done'] as const) {
      const moved = planned({ id: 'T2', status, ownerSeenAt: YESTERDAY });
      assert.equal(flagOf([planned(), moved]), undefined, status);
    }
  });

  it('counts no owner write before the span, on an open or dropped task, or on unplanned work', () => {
    const before = planned({ id: 'T2', status: 'in-progress', ownerSeenAt: EARLIER });
    const touchedOpen = planned({ id: 'T3', ownerSeenAt: YESTERDAY });
    const dropped = planned({ id: 'T4', status: 'dropped', ownerSeenAt: YESTERDAY });
    const unplanned = testTask({ id: 'T5', status: 'done', ownerSeenAt: YESTERDAY });
    assert.match(flagOf([planned(), before, touchedOpen, dropped, unplanned]) ?? '', /^NO-PROGRESS T1 /);
  });

  it('names the first planned task in plan order its owner can move now', () => {
    const later = planned({ id: 'T2', priority: 3 });
    const urgent = planned({ id: 'T3', priority: 1, status: 'in-progress', ownerSeenAt: EARLIER });
    const blocked = planned({ id: 'T4', priority: 1, status: 'waiting' });
    const shipped = planned({ id: 'T5', priority: 1, status: 'verifying' });
    assert.match(flagOf([later, urgent, blocked, shipped]) ?? '', /^NO-PROGRESS T3 /);
  });

  it('waits for a day to end on a plan made in it, and raises nothing with no planned work to move', () => {
    assert.equal(flagOf([planned({ createdAt: '2030-01-10T08:00:00.000Z' })]), undefined, 'planned today');
    assert.match(flagOf([planned({ createdAt: '2030-01-09T23:00:00.000Z' })]) ?? '', /^NO-PROGRESS T1 /, 'planned in the day that ended');
    assert.equal(flagOf([planned({ status: 'waiting' }), testTask({ id: 'T2' })]), undefined);
  });

  it('spans the days asked, is off at 0, and raises nothing once the week is spent', () => {
    const movedEarlier = planned({ id: 'T2', status: 'done', ownerSeenAt: EARLIER });
    assert.equal(flagOf([planned(), movedEarlier], { days: 2 }), undefined);
    assert.equal(flagOf([planned()], { days: 2 }), 'NO-PROGRESS T1 (no goal or week-plan task moved since 01-08 00:00 UTC (2 days); the first to move)');
    assert.equal(flagOf([planned()], { days: 0 }), undefined);
    assert.equal(flagOf([planned()], { leftPct: 0 }), undefined);
    assert.match(flagOf([planned()], { leftPct: undefined }) ?? '', /^NO-PROGRESS T1 /, 'no reading is no proof the week is spent');
  });

  it('spans no more days than a compaction keeps a finished task', () => {
    assert.ok(CONFIG_LIMITS.goalProgressDays.max + 1 <= RETAIN_DAYS);
  });
});
