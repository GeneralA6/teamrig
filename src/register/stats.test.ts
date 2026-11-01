import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { JERUSALEM } from '../testing/zone.ts';
import { EVENT_VERSION, type RegisterEvent, type TaskFields } from './events.ts';
import { ACTIVE_STATUSES, type TaskStatus } from './model.ts';
import { isStatsRange, registerStats, STATS_ACTIVE_STATUSES, type RegisterStats, type StatsDay, type StatsInput, type StatsRange, type StatsTeam } from './stats.ts';
import type { WaitReason } from './waits.ts';

const FIELDS: TaskFields = { title: 'Ship it', description: null, owner: 'alpha', source: 'lead', ref: null, priority: 2, due: null, goals: [], week: null, after: [], size: null, type: null, critical: false, pin: null };

/** Thursday 2030-01-10 12:00 on the team's clock (UTC+2): a 7 d range runs 01-04 to 01-10. */
const NOW = new Date('2030-01-10T10:00:00.000Z');

function create(id: string, at: string, fields: Partial<TaskFields> = {}): RegisterEvent {
  return { v: EVENT_VERSION, type: 'create', id, at, by: 'lead', task: { ...FIELDS, ...fields } };
}

function status(id: string, at: string, value: TaskStatus, waits?: readonly WaitReason[]): RegisterEvent {
  const event: RegisterEvent = { v: EVENT_VERSION, type: 'status', id, at, by: 'alpha', status: value, note: 'n', evidence: null, skill: null };
  return waits === undefined ? event : { ...event, waits };
}

function update(id: string, at: string, changes: Partial<TaskFields>): RegisterEvent {
  return { v: EVENT_VERSION, type: 'update', id, at, by: 'lead', changes, note: null };
}

function moved(id: string, at: string, to: string): RegisterEvent {
  return { v: EVENT_VERSION, type: 'moved', id, at, by: 'lead', to };
}

function team(events: readonly RegisterEvent[], name = 'alpha'): StatsTeam {
  return { team: name, lead: 'lead', events };
}

function statsOf(events: readonly RegisterEvent[], range: StatsRange = '7d', more: Partial<StatsInput> = {}): RegisterStats {
  return registerStats({ teams: [team(events)], range, now: NOW, zone: JERUSALEM, ownerMarker: 'owner', ...more });
}

function dayOf(stats: RegisterStats, day: string): StatsDay {
  const found = stats.days.find((each) => each.day === day);
  assert.ok(found !== undefined, `no day ${day}`);
  return found;
}

describe('registerStats: the days', () => {
  it('covers the range on the zone calendar, today included', () => {
    const days = statsOf([]).days.map((day) => day.day);
    assert.deepEqual(days, ['2030-01-04', '2030-01-05', '2030-01-06', '2030-01-07', '2030-01-08', '2030-01-09', '2030-01-10']);
    assert.equal(statsOf([], '30d').days.length, 30);
  });

  it("counts a creation on the zone's day: 23:30 UTC is the next day at UTC+2", () => {
    const stats = statsOf([create('T1', '2030-01-06T23:30:00.000Z')]);
    assert.deepEqual([dayOf(stats, '2030-01-06').opened, dayOf(stats, '2030-01-07').opened], [0, 1]);
    assert.equal(dayOf(stats, '2030-01-06').active.open, 0);
    assert.equal(dayOf(stats, '2030-01-07').active.open, 1);
  });

  it('starts the active counts from what happened before the range', () => {
    const stats = statsOf([create('T1', '2030-01-01T10:00:00.000Z'), status('T1', '2030-01-02T10:00:00.000Z', 'in-progress'), status('T1', '2030-01-05T10:00:00.000Z', 'done')]);
    assert.deepEqual(dayOf(stats, '2030-01-04').active, { open: 0, 'in-progress': 1, verifying: 0, waiting: 0 });
    assert.deepEqual([dayOf(stats, '2030-01-05').active['in-progress'], dayOf(stats, '2030-01-05').done], [0, 1]);
    assert.deepEqual([stats.opened, stats.closedTasks, stats.net], [0, 1, -1]);
  });

  it('counts each close of a reopened task on its day, the task once', () => {
    const stats = statsOf([
      create('T1', '2030-01-05T10:00:00.000Z'),
      status('T1', '2030-01-06T10:00:00.000Z', 'done'),
      status('T1', '2030-01-07T10:00:00.000Z', 'open'),
      status('T1', '2030-01-08T10:00:00.000Z', 'done'),
    ]);
    assert.deepEqual([dayOf(stats, '2030-01-06').done, dayOf(stats, '2030-01-07').active.open, dayOf(stats, '2030-01-08').done], [1, 1, 1]);
    assert.deepEqual([stats.closes, stats.closedTasks], [2, 1]);
  });

  it('reads a status the task already has as no move, and a close from a close as no close', () => {
    const stats = statsOf([
      create('T1', '2030-01-05T10:00:00.000Z'),
      status('T1', '2030-01-05T11:00:00.000Z', 'in-progress'),
      status('T1', '2030-01-06T10:00:00.000Z', 'in-progress'),
      status('T1', '2030-01-07T10:00:00.000Z', 'done'),
      status('T1', '2030-01-08T10:00:00.000Z', 'dropped'),
    ]);
    assert.deepEqual(dayOf(stats, '2030-01-06').active, { open: 0, 'in-progress': 1, verifying: 0, waiting: 0 });
    assert.deepEqual([stats.closes, dayOf(stats, '2030-01-08').dropped, stats.droppedTasks], [1, 0, 1]);
  });

  it('keeps the steps of a day the clock moves on: 03-29 is 23 hours at UTC+2 to +3', () => {
    const stats = statsOf([create('T1', '2030-03-29T21:30:00.000Z')], '7d', { now: new Date('2030-03-31T10:00:00.000Z') });
    assert.deepEqual(
      stats.days.map((day) => day.day),
      ['2030-03-25', '2030-03-26', '2030-03-27', '2030-03-28', '2030-03-29', '2030-03-30', '2030-03-31'],
    );
    assert.equal(dayOf(stats, '2030-03-30').opened, 1);
  });

  it("runs an 'all' range from the first task's creation day", () => {
    const stats = statsOf([create('T1', '2030-01-02T10:00:00.000Z'), create('T2', '2030-01-09T10:00:00.000Z')], 'all');
    assert.deepEqual([stats.days[0]?.day, stats.days.length, stats.opened], ['2030-01-02', 9, 2]);
    assert.deepEqual(statsOf([], 'all').days.map((day) => day.day), ['2030-01-10']);
  });

  it('nets the last 28 days whatever the range', () => {
    const stats = statsOf([
      create('T1', '2029-12-20T10:00:00.000Z'),
      create('T2', '2029-12-20T11:00:00.000Z'),
      status('T2', '2029-12-22T10:00:00.000Z', 'done'),
      create('T3', '2029-12-01T10:00:00.000Z'),
    ]);
    assert.deepEqual([stats.net, stats.recent], [0, { days: 28, net: 1 }]);
  });

  it("marks each zone day a limit stretch overlaps, its end excluded, and none with no stretch", () => {
    const limits = [{ start: Date.parse('2030-01-07T21:30:00.000Z'), end: Date.parse('2030-01-08T22:00:00.000Z') }];
    const marked = (stats: RegisterStats): string[] => stats.days.filter((day) => day.atLimit).map((day) => day.day);
    assert.deepEqual(marked(statsOf([], '7d', { limits })), ['2030-01-07', '2030-01-08']);
    assert.deepEqual(marked(statsOf([])), []);
  });
});

describe('registerStats: moved tasks', () => {
  it('counts a moved task once, in the team holding it, and names the split day', () => {
    const created = create('T1', '2030-01-05T10:00:00.000Z');
    const parent = team([created, create('T2', '2030-01-05T11:00:00.000Z'), moved('T1', '2030-01-06T10:00:00.000Z', 'bravo')]);
    const child = team([created, status('T1', '2030-01-08T10:00:00.000Z', 'done')], 'bravo');
    const stats = statsOf([], '7d', { teams: [parent, child] });
    assert.deepEqual([stats.opened, stats.closedTasks, stats.active.open], [2, 1, 1]);
    assert.deepEqual(
      stats.teams.map((each) => [each.team, each.active]),
      [
        ['alpha', 1],
        ['bravo', 0],
      ],
    );
    assert.deepEqual(stats.splits, [{ day: '2030-01-06', from: 'alpha', to: 'bravo', tasks: 1 }]);
  });
});

describe('registerStats: new work', () => {
  it('sorts the asks by source, type, priority and goal', () => {
    const stats = statsOf([
      create('T1', '2030-01-05T10:00:00.000Z', { source: 'alpha', priority: 1, goals: ['G1'] }),
      create('T2', '2030-01-05T10:00:00.000Z', { source: 'owner', priority: 1, goals: ['G1', 'G2', 'G1'], type: 'bug' }),
      create('T3', '2030-01-05T10:00:00.000Z', { source: 'lead', priority: 3 }),
      create('T4', '2030-01-05T10:00:00.000Z', { source: 'github', type: 'bug' }),
      create('T5', '2030-01-05T10:00:00.000Z', { source: 'bravo', goals: ['G0'] }),
      create('T6', '2029-12-20T10:00:00.000Z', { source: 'owner' }),
    ]);
    assert.deepEqual(stats.newWork, {
      total: 5,
      bySource: { self: 1, owner: 1, lead: 1, github: 1, session: 1 },
      bugs: 2,
      byPriority: [
        { priority: 1, count: 2 },
        { priority: 2, count: 2 },
        { priority: 3, count: 1 },
      ],
      byGoal: [
        { goal: 'G1', count: 2 },
        { goal: 'G0', count: 1 },
        { goal: 'G2', count: 1 },
      ],
      noGoal: 2,
    });
  });
});

describe('registerStats: speed', () => {
  const stats = statsOf([
    create('T1', '2030-01-04T12:00:00.000Z'),
    status('T1', '2030-01-05T00:00:00.000Z', 'in-progress'),
    status('T1', '2030-01-05T12:00:00.000Z', 'done'),
    create('T2', '2030-01-04T12:00:00.000Z'),
    status('T2', '2030-01-05T12:00:00.000Z', 'in-progress'),
    status('T2', '2030-01-06T12:00:00.000Z', 'done'),
    create('T3', '2030-01-04T12:00:00.000Z'),
    status('T3', '2030-01-08T12:00:00.000Z', 'done'),
    create('T4', '2030-01-04T12:00:00.000Z'),
    status('T4', '2030-01-05T12:00:00.000Z', 'dropped'),
  ]);

  it('spreads the lead time of the tasks done in the range, the dropped one left out', () => {
    assert.deepEqual(stats.all.leadTime.count, 3);
    assert.equal(stats.all.leadTime.median, 2);
    assert.ok(Math.abs((stats.all.leadTime.p85 ?? 0) - 3.4) < 1e-9);
  });

  it('spreads the cycle time of the started ones and counts the rest as never started', () => {
    assert.equal(stats.all.cycleTime.count, 2);
    assert.ok(Math.abs((stats.all.cycleTime.median ?? 0) - 0.75) < 1e-9);
    assert.ok(Math.abs((stats.all.cycleTime.p85 ?? 0) - 0.925) < 1e-9);
    assert.equal(stats.neverStarted, 1);
  });

  it('gives no spread with nothing done', () => {
    assert.deepEqual(statsOf([]).all.leadTime, { count: 0, median: null, p85: null });
  });

  it('bands the active tasks by age', () => {
    const aged = statsOf([
      create('T1', '2030-01-09T10:00:00.000Z'),
      create('T2', '2030-01-07T10:00:00.000Z'),
      create('T3', '2029-12-31T10:00:00.000Z'),
      create('T4', '2029-12-21T10:00:00.000Z'),
      create('T5', '2029-12-21T10:00:00.000Z'),
      status('T5', '2030-01-05T10:00:00.000Z', 'done'),
    ]);
    assert.deepEqual(
      aged.activeByAge.map((band) => [band.label, band.count]),
      [
        ['<2 d', 1],
        ['2-7 d', 1],
        ['7-14 d', 1],
        ['14+ d', 1],
      ],
    );
  });
});

describe('registerStats: delays', () => {
  it('counts the active tasks past due, a bare day due at its end on the zone clock', () => {
    const stats = statsOf([
      create('T1', '2030-01-05T10:00:00.000Z', { due: '2030-01-09', priority: 1 }),
      create('T2', '2030-01-05T10:00:00.000Z', { due: '2030-01-08 10:00' }),
      create('T3', '2030-01-05T10:00:00.000Z', { due: '2030-01-10' }),
      create('T4', '2030-01-05T10:00:00.000Z', { due: '2030-01-08' }),
      status('T4', '2030-01-09T10:00:00.000Z', 'done'),
    ]);
    assert.deepEqual(stats.all.overdue, { count: 2, p1: 1 });
  });

  it('counts the done tasks by their due date and bands the late ones by whole days', () => {
    const due = { due: '2030-01-05 10:00' };
    const stats = statsOf([
      create('T1', '2030-01-04T10:00:00.000Z', due),
      status('T1', '2030-01-05T09:00:00.000Z', 'done'),
      create('T2', '2030-01-04T10:00:00.000Z', due),
      status('T2', '2030-01-05T12:00:00.000Z', 'done'),
      create('T3', '2030-01-04T10:00:00.000Z', due),
      status('T3', '2030-01-07T11:00:00.000Z', 'done'),
      create('T4', '2030-01-04T10:00:00.000Z', due),
      status('T4', '2030-01-09T12:00:00.000Z', 'done'),
      create('T5', '2030-01-04T10:00:00.000Z'),
      status('T5', '2030-01-09T12:00:00.000Z', 'done'),
    ]);
    assert.deepEqual(stats.all.due, { total: 4, onTime: 1 });
    assert.deepEqual(
      stats.lateDays.map((band) => [band.label, band.count]),
      [
        ['1 d', 1],
        ['2-3 d', 1],
        ['4+ d', 1],
      ],
    );
  });

  it('counts a task that changed or cleared its due in the range once, a restated or first due as none', () => {
    const stats = statsOf([
      create('T1', '2030-01-01T10:00:00.000Z', { due: '2030-01-20' }),
      update('T1', '2030-01-05T10:00:00.000Z', { due: '2030-01-25' }),
      update('T1', '2030-01-06T10:00:00.000Z', { due: '2030-01-27' }),
      create('T2', '2030-01-01T10:00:00.000Z', { due: '2030-01-20' }),
      update('T2', '2030-01-05T10:00:00.000Z', { due: '2030-01-20', priority: 1 }),
      create('T3', '2030-01-01T10:00:00.000Z', { due: '2030-01-20' }),
      update('T3', '2030-01-02T10:00:00.000Z', { due: '2030-01-22' }),
      create('T4', '2030-01-01T10:00:00.000Z'),
      update('T4', '2030-01-05T10:00:00.000Z', { due: '2030-01-22' }),
      create('T5', '2030-01-01T10:00:00.000Z', { due: '2030-01-20' }),
      update('T5', '2030-01-05T10:00:00.000Z', { due: null }),
    ]);
    assert.equal(stats.dueMoved, 2);
  });
});

describe('registerStats: waits, bugs and people', () => {
  it('counts the waiting tasks by kind, each kind once a task, and the oldest wait on the owner', () => {
    const stats = statsOf([
      create('T1', '2030-01-01T10:00:00.000Z'),
      status('T1', '2030-01-08T10:00:00.000Z', 'waiting', [
        { kind: 'task', id: 'T9' },
        { kind: 'time', at: '2030-01-11 10:00' },
      ]),
      create('T2', '2030-01-01T10:00:00.000Z'),
      status('T2', '2030-01-05T10:00:00.000Z', 'waiting', [{ kind: 'decision', who: 'owner' }]),
      create('T3', '2030-01-01T10:00:00.000Z'),
      status('T3', '2030-01-09T10:00:00.000Z', 'verifying', [{ kind: 'approval', who: 'owner' }]),
      create('T4', '2030-01-01T10:00:00.000Z'),
      status('T4', '2030-01-09T10:00:00.000Z', 'waiting', [
        { kind: 'approval', who: 'lead' },
        { kind: 'approval', who: 'bravo' },
      ]),
    ]);
    assert.deepEqual(stats.waits, { waiting: 3, byKind: { decision: 1, approval: 1, task: 1, time: 1 }, ownerDecisions: { count: 2, oldestDays: 5 } });
    assert.deepEqual(statsOf([]).waits.ownerDecisions, { count: 0, oldestDays: null });
  });

  it('counts the bugs active, opened and fixed', () => {
    const bug = { type: 'bug' } as const;
    const stats = statsOf([
      create('T1', '2029-12-20T10:00:00.000Z', bug),
      create('T2', '2030-01-05T10:00:00.000Z', bug),
      status('T2', '2030-01-06T10:00:00.000Z', 'done'),
      create('T3', '2030-01-05T10:00:00.000Z'),
    ]);
    assert.deepEqual(stats.bugs, { active: 1, opened: 1, fixed: 1 });
  });

  it('counts the done tasks of each session in each team, most first', () => {
    const done = (id: string, owner: string): RegisterEvent[] => [create(id, '2030-01-05T10:00:00.000Z', { owner }), status(id, '2030-01-06T10:00:00.000Z', 'done')];
    const stats = statsOf([], '7d', {
      teams: [team([...done('T1', 'alpha'), ...done('T2', 'bravo'), ...done('T3', 'bravo')]), team([...done('T1', 'alpha'), ...done('T2', 'alpha')], 'bravo')],
    });
    assert.deepEqual(stats.people, [
      { team: 'alpha', session: 'bravo', done: 2 },
      { team: 'bravo', session: 'alpha', done: 2 },
      { team: 'alpha', session: 'alpha', done: 1 },
    ]);
  });
});

describe('registerStats: a session scope', () => {
  it('counts only the tasks the session owns now in its team', () => {
    const alpha = team([create('T1', '2030-01-05T10:00:00.000Z'), create('T2', '2030-01-05T10:00:00.000Z', { owner: 'bravo' }), create('T3', '2030-01-05T10:00:00.000Z', { owner: 'bravo' }), update('T3', '2030-01-06T10:00:00.000Z', { owner: 'alpha' })]);
    const bravo = team([create('T1', '2030-01-05T10:00:00.000Z')], 'bravo');
    const stats = statsOf([], '7d', { teams: [alpha, bravo], session: { team: 'alpha', session: 'alpha' } });
    assert.deepEqual([stats.opened, stats.active.open], [2, 2]);
    assert.deepEqual(
      stats.teams.map((each) => each.team),
      ['alpha'],
    );
  });
});

describe('stats ranges and statuses', () => {
  it('reads the ranges it names and no other', () => {
    assert.deepEqual(['7d', '14d', '30d', 'all', '1d', 7].map(isStatsRange), [true, true, true, true, false, false]);
  });

  it('holds the active statuses equal to the model', () => {
    assert.deepEqual([...STATS_ACTIVE_STATUSES], [...ACTIVE_STATUSES]);
  });
});
