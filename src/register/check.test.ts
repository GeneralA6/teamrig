import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { testConfig } from '../testing/config.ts';
import { testTask } from '../testing/task.ts';
import { checkTasks, currentWeek, currentWeekOf, formatFlag } from './check.ts';
import { readRegister, type RegisterSnapshot } from './snapshot.ts';
import { waitContext } from './waits.ts';

const NOW = new Date('2030-01-10T12:00:00.000Z');
const FRESH = '2030-01-10T09:00:00.000Z';
const CONFIG = testConfig().register;

describe('currentWeek', () => {
  it('picks the newest week tag that has started', () => {
    const tasks = [testTask({ week: '2030-01-07' }), testTask({ week: '2029-12-31' }), testTask({ week: '2030-01-14' })];
    assert.equal(currentWeek(tasks, NOW), '2030-01-07');
    assert.equal(currentWeek([testTask()], NOW), null);
  });
});

describe('currentWeekOf', () => {
  const withTasks = (weeks: readonly (string | null)[], retired: RegisterSnapshot['retired']): RegisterSnapshot => {
    const empty = readRegister('');
    const tasks = new Map(weeks.map((week, index) => [`T${index + 1}`, testTask({ id: `T${index + 1}`, week })]));
    return { ...empty, state: { ...empty.state, tasks }, retired };
  };

  it('is the current week of the tasks read when nothing is retired, or nothing newer is', () => {
    assert.equal(currentWeekOf(withTasks(['2030-01-07', null], null), NOW), '2030-01-07');
    assert.equal(currentWeekOf(withTasks(['2030-01-07'], { count: 2, lastWeek: '2029-12-31' }), NOW), '2030-01-07');
    assert.equal(currentWeekOf(withTasks([null], { count: 2, lastWeek: null }), NOW), null);
  });

  it('is the newest week of the retired tasks when no task read is in a newer one that has started', () => {
    assert.equal(currentWeekOf(withTasks([null], { count: 1, lastWeek: '2029-12-31' }), NOW), '2029-12-31');
    assert.equal(currentWeekOf(withTasks(['2029-12-24', '2099-01-05'], { count: 1, lastWeek: '2029-12-31' }), NOW), '2029-12-31');
    assert.equal(currentWeekOf(withTasks([], { count: 1, lastWeek: '2099-01-05' }), NOW), null, 'a week that has not started');
  });
});

describe('checkTasks', () => {
  const kinds = (tasks: Parameters<typeof checkTasks>[0], week: string | null = null) =>
    checkTasks(tasks, NOW, week, CONFIG).map((flag) => `${flag.kind} ${flag.task.id}`);

  it('flags overdue tasks; a bare day is due at its end', () => {
    assert.deepEqual(kinds([testTask({ due: '2030-01-09', ownerSeenAt: FRESH, updatedAt: FRESH })]), ['OVERDUE T1']);
    assert.deepEqual(kinds([testTask({ due: '2030-01-10', ownerSeenAt: FRESH, updatedAt: FRESH })]), []);
  });

  it('flags a verifying task past its verify-by date, not as overdue work', () => {
    const late = testTask({ status: 'verifying', due: '2030-01-09', ownerSeenAt: FRESH, updatedAt: FRESH });
    assert.deepEqual(kinds([late]), ['VERIFY-OVERDUE T1']);
    const [flag] = checkTasks([late], NOW, null, CONFIG);
    assert.ok(flag);
    assert.equal(formatFlag(flag), 'VERIFY-OVERDUE (verify by 01-09) T1 verifying, p2, owner alpha, due 01-09, from lead | Add a health check');
    assert.deepEqual(kinds([testTask({ status: 'verifying', due: '2030-01-10', ownerSeenAt: FRESH, updatedAt: FRESH })]), []);
  });

  it('lets a verifying task with a due date wait quietly for its proof, and calls one with none stale', () => {
    const quiet = (due: string | null) => testTask({ status: 'verifying', due, ownerSeenAt: '2030-01-01T08:00:00.000Z', updatedAt: '2030-01-01T08:00:00.000Z' });
    assert.deepEqual(kinds([quiet('2030-01-12')]), []);
    assert.deepEqual(kinds([quiet(null)]), ['STALE T1']);
  });

  it('flags a task its owner has not touched since assignment, instead of calling it stale', () => {
    assert.deepEqual(kinds([testTask({ assignedAt: '2030-01-09T11:00:00.000Z', updatedAt: '2030-01-01T00:00:00.000Z' })]), [
      'NOT-PICKED-UP T1',
    ]);
    assert.deepEqual(kinds([testTask({ assignedAt: '2030-01-09T13:00:00.000Z', updatedAt: FRESH })]), []);
  });

  it('flags tasks with no event for the stale window', () => {
    const old = testTask({ ownerSeenAt: '2030-01-07T08:00:00.000Z', updatedAt: '2030-01-07T11:00:00.000Z', updatedBy: 'bravo' });
    const flags = checkTasks([old], NOW, null, CONFIG);
    assert.deepEqual(flags.map((flag) => formatFlag(flag)), ['STALE (last event 01-07 11:00 by bravo) T1 open, p2, owner alpha, from lead | Add a health check']);
  });

  it('flags owner orders and tasks due this week that are outside the week plan', () => {
    const seen = { ownerSeenAt: FRESH, updatedAt: FRESH };
    const tasks = [
      testTask({ id: 'T1', source: 'owner', ...seen }),
      testTask({ id: 'T2', due: '2030-01-12', ...seen }),
      testTask({ id: 'T3', due: '2030-01-14', ...seen }),
      testTask({ id: 'T4', source: 'owner', week: '2030-01-07', ...seen }),
      testTask({ id: 'T5', source: 'owner', status: 'done', ...seen }),
    ];
    assert.deepEqual(kinds(tasks, '2030-01-07'), ['OWNER-UNPLANNED T1', 'DUE-UNPLANNED T2']);
    assert.deepEqual(kinds(tasks), [], 'no week plan, no week flags');
  });

  it('reports the most urgent kinds first', () => {
    const tasks = [
      testTask({ id: 'T1', ownerSeenAt: FRESH, updatedAt: '2030-01-01T00:00:00.000Z' }),
      testTask({ id: 'T2', due: '2030-01-08', ownerSeenAt: FRESH, updatedAt: FRESH, priority: 4 }),
    ];
    assert.deepEqual(kinds(tasks), ['OVERDUE T2', 'STALE T1']);
  });

  it('reads its thresholds from the config', () => {
    const quick = testConfig({ register: { check: { staleAfterHours: 1, notPickedUpAfterHours: 1, weekLengthDays: 7 } } }).register;
    const flags = checkTasks([testTask({ ownerSeenAt: '2030-01-10T10:00:00.000Z', updatedAt: '2030-01-10T10:00:00.000Z' })], NOW, null, quick);
    assert.deepEqual(flags.map((flag) => flag.kind), ['STALE']);
  });
});

describe('checkTasks: PRIORITY-SKIP', () => {
  const seen = { ownerSeenAt: FRESH, updatedAt: FRESH };
  const since = (iso: string) => ({ assignedAt: iso, statusAt: iso, priorityAt: iso });
  /** alpha's p1 open since 01-08 09:00, and its p3 in progress since 01-08 10:00. */
  const waiting = testTask({ id: 'T1', priority: 1, ...seen, ...since('2030-01-08T09:00:00.000Z') });
  const working = testTask({ id: 'T2', priority: 3, status: 'in-progress', ...seen, ...since('2030-01-08T10:00:00.000Z') });
  const skips = (tasks: Parameters<typeof checkTasks>[0], config = CONFIG) =>
    checkTasks(tasks, NOW, null, config).map((flag) => formatFlag(flag));

  it('flags work in progress below its own open p1, counted from the later of the two', () => {
    assert.deepEqual(skips([waiting, working]), [
      'PRIORITY-SKIP (p1 T1 waits open, skipped since 01-08 10:00) T2 in-progress, p3, owner alpha, from lead | Add a health check',
    ]);
  });

  it('leaves a waiting p1, another owner\'s p1, a p1 in progress and work that is not in progress alone', () => {
    assert.deepEqual(skips([{ ...waiting, status: 'waiting' }, working]), []);
    assert.deepEqual(skips([{ ...waiting, owner: 'bravo' }, working]), []);
    assert.deepEqual(skips([waiting, { ...working, priority: 1 }]), []);
    assert.deepEqual(skips([waiting, { ...working, status: 'open' }]), []);
  });

  it('waits the configured hours after the latest owner, status or priority change of either task', () => {
    const recent = '2030-01-10T00:00:00.000Z';
    assert.deepEqual(skips([{ ...waiting, priorityAt: recent }, working]), [], 'raised to p1 12 h ago');
    assert.deepEqual(skips([{ ...waiting, statusAt: recent }, working]), [], 'back from waiting 12 h ago');
    assert.deepEqual(skips([waiting, { ...working, assignedAt: recent }]), [], 'handed to alpha 12 h ago');
    const quick = testConfig({ register: { check: { prioritySkipAfterHours: 6 } } }).register;
    assert.equal(skips([{ ...waiting, statusAt: recent }, working], quick).length, 1);
  });

  it('names the p1 that has waited longest', () => {
    const older = testTask({ id: 'T3', priority: 1, ...seen, ...since('2030-01-07T09:00:00.000Z') });
    const newer = { ...waiting, ...since('2030-01-08T11:00:00.000Z') };
    assert.match(skips([newer, older, working])[0] ?? '', /^PRIORITY-SKIP \(p1 T3 waits open, skipped since 01-08 10:00\) T2 /);
  });

  it('leaves a p1 planned after a task not finished yet alone, and counts it once that task finished', () => {
    const first = testTask({ id: 'T3', priority: 2, status: 'open', ...seen, ...since('2030-01-08T09:00:00.000Z') });
    const planned = { ...waiting, after: ['T3'] };
    assert.deepEqual(skips([planned, working, first]), []);
    assert.equal(skips([planned, working, { ...first, status: 'done' }]).length, 1);
    assert.equal(skips([planned, working]).length, 1, 'a task the read lacks was retired, so finished');
  });

  it('takes the top priority from the config, and skips the flag when the config names none', () => {
    const levels = testConfig({ register: { priorities: [{ id: 2, name: 'now' }, { id: 3, name: 'later' }] } }).register;
    assert.match(skips([{ ...waiting, priority: 2 }, working], levels)[0] ?? '', /^PRIORITY-SKIP \(p2 T1 /);
    assert.deepEqual(skips([waiting, working], { ...CONFIG, priorities: [] }), []);
  });
});

describe('checkTasks: READY', () => {
  const seen = { ownerSeenAt: FRESH, updatedAt: FRESH };
  const ready = (tasks: Parameters<typeof checkTasks>[0]) =>
    checkTasks(tasks, NOW, null, CONFIG)
      .filter((flag) => flag.kind === 'READY')
      .map((flag) => flag.task.id);

  it('flags a waiting task once every reason cleared: its tasks finished and its time passed', () => {
    const done = testTask({ id: 'T2', status: 'done', ...seen });
    const busy = testTask({ id: 'T3', status: 'in-progress', ...seen });
    const passed = { kind: 'time' as const, at: '2030-01-10 11:00' };
    const tasks = [
      testTask({ id: 'T1', status: 'waiting', waits: [{ kind: 'task', id: 'T2' }, passed], ...seen }),
      testTask({ id: 'T4', status: 'waiting', waits: [{ kind: 'task', id: 'T3' }], ...seen }),
      testTask({ id: 'T5', status: 'waiting', waits: [{ kind: 'time', at: '2030-01-10 13:00' }], ...seen }),
      testTask({ id: 'T6', status: 'waiting', waits: [passed, { kind: 'decision', who: 'owner' }], ...seen }),
      testTask({ id: 'T7', status: 'waiting', ...seen }),
      testTask({ id: 'T8', status: 'waiting', waits: [{ kind: 'task', id: 'T99' }], ...seen }),
      done,
      busy,
    ];
    assert.deepEqual(ready(tasks), ['T1', 'T8'], 'a task the read lacks was retired, so finished');
  });

  it('prints why, with each ready reason marked', () => {
    const tasks = [
      testTask({ id: 'T1', status: 'waiting', note: 'needs the export', waits: [{ kind: 'task', id: 'T2' }], ...seen }),
      testTask({ id: 'T2', status: 'dropped', ...seen }),
    ];
    const [flag] = checkTasks(tasks, NOW, null, CONFIG);
    assert.equal(
      flag === undefined ? undefined : formatFlag(flag, undefined, waitContext(new Map(tasks.map((task) => [task.id, task])), NOW)),
      'READY (every reason cleared; set its next status) T1 waiting, p2, owner alpha, from lead | Add a health check (waiting: on T2 ready; needs the export)',
    );
  });
});

describe('checkTasks: OFF-GOAL', () => {
  const seen = { ownerSeenAt: FRESH, updatedAt: FRESH };
  const kinds = (tasks: Parameters<typeof checkTasks>[0], week: string | null = '2030-01-07') =>
    checkTasks(tasks, NOW, week, CONFIG).map((flag) => `${flag.kind} ${flag.task.id}`);

  it('flags work in progress with no goal outside the week plan', () => {
    const tasks = [
      testTask({ id: 'T1', status: 'in-progress', ...seen }),
      testTask({ id: 'T2', status: 'in-progress', goals: ['G1'], ...seen }),
      testTask({ id: 'T3', status: 'in-progress', week: '2030-01-07', ...seen }),
      testTask({ id: 'T4', ...seen }),
      testTask({ id: 'T5', status: 'waiting', ...seen }),
    ];
    assert.deepEqual(kinds(tasks), ['OFF-GOAL T1']);
    assert.deepEqual(kinds(tasks, null), [], 'no week plan, no week flags');
    assert.deepEqual(
      checkTasks(tasks, NOW, '2030-01-07', CONFIG).map((flag) => formatFlag(flag)),
      ['OFF-GOAL (in progress with no goal, not in week 2030-01-07) T1 in-progress, p2, owner alpha, from lead | Add a health check'],
    );
  });

  it('raises the more specific week flag instead on an owner order or a task due this week', () => {
    const tasks = [
      testTask({ id: 'T1', status: 'in-progress', source: 'owner', ...seen }),
      testTask({ id: 'T2', status: 'in-progress', due: '2030-01-12', ...seen }),
    ];
    assert.deepEqual(kinds(tasks), ['OWNER-UNPLANNED T1', 'DUE-UNPLANNED T2']);
  });
});
