import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { JERUSALEM } from '../testing/zone.ts';
import { AREA_MEASURES, standingOut, type AreaCell, type AreaGroup, type AreaMeasure, type AreaStats } from './area-stats.ts';
import { EVENT_VERSION, type RegisterEvent, type TaskFields } from './events.ts';
import type { TaskStatus } from './model.ts';
import { registerStats, type RegisterStats, type StatsInput, type StatsTeam } from './stats.ts';

const FIELDS: TaskFields = { title: 'Ship it', description: null, owner: 'alpha', source: 'lead', ref: null, priority: 2, due: null, goals: [], noGoal: false, week: null, after: [], size: null, type: null, critical: false, pin: null, workClass: null };

/** Thursday 2030-01-10 12:00 on the team's clock (UTC+2): the usual reads the day-ends of 12-11 to 01-09. */
const NOW = new Date('2030-01-10T10:00:00.000Z');

/** Before every day-end the usual reads, so a task made then counts at all 30. */
const LONG_AGO = '2029-11-01T10:00:00.000Z';

/** After the last day-end the usual reads: a task made then is in the count now and in no usual. */
const THIS_MORNING = '2030-01-10T08:00:00.000Z';

function create(id: string, at: string, fields: Partial<TaskFields> = {}): RegisterEvent {
  return { v: EVENT_VERSION, type: 'create', id, at, by: 'lead', task: { ...FIELDS, ...fields } };
}

function status(id: string, at: string, value: TaskStatus): RegisterEvent {
  return { v: EVENT_VERSION, type: 'status', id, at, by: 'alpha', status: value, note: 'n', evidence: null, skill: null };
}

/** `count` tasks of `owner`, numbered from `first`, so a test reads as who holds how many. */
function tasks(first: number, count: number, owner: string, at: string, fields: Partial<TaskFields> = {}): RegisterEvent[] {
  return Array.from({ length: count }, (_, index) => create(`T${first + index}`, at, { owner, ...fields }));
}

function team(events: readonly RegisterEvent[], name = 'alpha'): StatsTeam {
  return { team: name, lead: 'lead', events };
}

function statsOf(teams: readonly StatsTeam[], more: Partial<StatsInput> = {}): RegisterStats {
  return registerStats({ teams, range: '7d', now: NOW, zone: JERUSALEM, ownerMarker: 'owner', ...more });
}

function sessionsOf(events: readonly RegisterEvent[]): AreaGroup {
  return statsOf([team(events)]).areas.sessions;
}

function area(group: AreaGroup, name: string): AreaStats {
  const found = group.areas.find((each) => (each.session ?? each.team) === name);
  assert.ok(found !== undefined, `no area ${name}`);
  return found;
}

function ids(cell: AreaCell): string[] {
  return cell.tasks.map((each) => each.task.id);
}

function names(areas: readonly AreaStats[]): string[] {
  return areas.map((each) => each.session ?? each.team);
}

function levels(group: AreaGroup, measure: AreaMeasure, sessions: readonly string[]): string[] {
  return sessions.map((session) => area(group, session).cells[measure].level);
}

describe('areaStats: the counts now', () => {
  it('counts each measure with the very tasks behind it, the low share in whole percent', () => {
    const { cells, active } = area(
      sessionsOf([
        create('T1', LONG_AGO, { type: 'bug' }),
        create('T2', LONG_AGO, { priority: 1, due: '2030-01-09' }),
        create('T3', LONG_AGO, { priority: 1, due: '2030-01-11' }),
        create('T4', LONG_AGO, { priority: 3 }),
        create('T5', LONG_AGO, { priority: 4 }),
        status('T5', '2030-01-01T10:00:00.000Z', 'waiting'),
        create('T6', LONG_AGO),
        status('T6', '2030-01-09T10:00:00.000Z', 'waiting'),
        create('T7', LONG_AGO, { type: 'bug' }),
        status('T7', '2030-01-02T10:00:00.000Z', 'done'),
      ]),
      'alpha',
    );
    assert.equal(active, 6);
    assert.deepEqual(
      AREA_MEASURES.map((measure) => [measure, cells[measure].value, ids(cells[measure])]),
      [
        ['bugs', 1, ['T1']],
        ['p1', 2, ['T2', 'T3']],
        ['p1Late', 1, ['T2']],
        ['low', 33, ['T4', 'T5']],
        ['waits', 1, ['T5']],
      ],
    );
  });

  it('counts a p0 as top priority, on time or late', () => {
    const { cells } = area(sessionsOf([create('T1', LONG_AGO, { priority: 0, due: '2030-01-09' })]), 'alpha');
    assert.deepEqual([cells.p1.value, cells.p1Late.value], [1, 1]);
  });

  it('calls a wait long only past three days', () => {
    const group = sessionsOf([
      create('T1', LONG_AGO),
      status('T1', '2030-01-07T10:00:00.000Z', 'waiting'),
      create('T2', LONG_AGO),
      status('T2', '2030-01-07T09:59:59.000Z', 'waiting'),
    ]);
    assert.deepEqual(ids(area(group, 'alpha').cells.waits), ['T2']);
  });

  it('leaves out an area with no active task, from the rows and from the median', () => {
    const group = sessionsOf([...tasks(1, 2, 'alpha', LONG_AGO), ...tasks(3, 4, 'bravo', LONG_AGO), status('T3', LONG_AGO, 'done'), status('T4', LONG_AGO, 'done'), status('T5', LONG_AGO, 'done'), status('T6', LONG_AGO, 'dropped')]);
    assert.deepEqual(names(group.areas), ['alpha']);
    assert.equal(group.median.active, 2);
  });
});

describe('areaStats: the usual', () => {
  it('is the median of the day-ends before today: a task there for most of them counts, one there for few does not', () => {
    const { cells: most } = area(sessionsOf([create('T1', '2029-12-20T10:00:00.000Z', { type: 'bug' })]), 'alpha');
    const { cells: few } = area(sessionsOf([create('T1', '2030-01-05T10:00:00.000Z', { type: 'bug' })]), 'alpha');
    assert.deepEqual([most.bugs.usual, few.bugs.usual], [1, 0]);
  });

  it("keeps today's spike out of its own usual", () => {
    const { cells } = area(sessionsOf([...tasks(1, 2, 'alpha', LONG_AGO, { type: 'bug' }), ...tasks(3, 3, 'alpha', THIS_MORNING, { type: 'bug' })]), 'alpha');
    assert.deepEqual([cells.bugs.value, cells.bugs.usual], [5, 2]);
  });

  it('counts a late p1 from its due date and a long wait from three days in, not for all of the task\'s life', () => {
    const { cells } = area(
      sessionsOf([create('T1', LONG_AGO, { priority: 1, due: '2030-01-05' }), create('T2', LONG_AGO), status('T2', '2030-01-02T10:00:00.000Z', 'waiting')]),
      'alpha',
    );
    assert.deepEqual([cells.p1Late.value, cells.p1Late.usual, cells.waits.value, cells.waits.usual], [1, 0, 1, 0]);
  });

  it('counts a task for whoever owned it then, not for its owner now', () => {
    const handedOver: RegisterEvent = { v: EVENT_VERSION, type: 'update', id: 'T1', at: '2029-12-20T10:00:00.000Z', by: 'lead', changes: { owner: 'bravo' }, note: null };
    const group = sessionsOf([create('T1', LONG_AGO, { type: 'bug' }), handedOver, create('T2', LONG_AGO)]);
    assert.deepEqual([area(group, 'alpha').cells.bugs.usual, area(group, 'bravo').cells.bugs.usual], [0, 1]);
  });

  it('leaves out a task that moved away, now and in the usual', () => {
    const away: RegisterEvent = { v: EVENT_VERSION, type: 'moved', id: 'T1', at: '2030-01-09T10:00:00.000Z', by: 'lead', to: 'bravo' };
    const { cells } = area(sessionsOf([create('T1', LONG_AGO, { type: 'bug' }), away, create('T2', LONG_AGO, { type: 'bug' })]), 'alpha');
    assert.deepEqual([cells.bugs.value, cells.bugs.usual], [1, 1]);
  });

  it('takes an event written just out of time order in at the next day-end, and loses none after it', () => {
    const written = [create('T1', '2029-12-20T10:00:00.000Z'), create('T2', '2029-12-19T10:00:00.000Z', { type: 'bug' }), create('T3', '2029-12-20T11:00:00.000Z', { type: 'bug' })];
    const { cells } = area(sessionsOf(written), 'alpha');
    assert.deepEqual([cells.bugs.value, cells.bugs.usual], [2, 2]);
  });
});

describe('areaStats: the levels', () => {
  const BUGS = { type: 'bug' } as const;

  /** Five areas whose bugs now read 4, 4, 1, 1, 1: a median of 1 and a top quarter of two. In write order, as a log is. */
  const FIVE = [
    ...tasks(1, 1, 'alpha', LONG_AGO, BUGS),
    ...tasks(2, 4, 'bravo', LONG_AGO, BUGS),
    ...tasks(6, 1, 'charlie', LONG_AGO, BUGS),
    ...tasks(7, 1, 'echo', LONG_AGO, BUGS),
    ...tasks(8, 3, 'alpha', THIS_MORNING, BUGS),
    ...tasks(11, 1, 'delta', THIS_MORNING, BUGS),
  ];

  it('marks red for high against both, amber for one, nothing for neither', () => {
    const group = sessionsOf(FIVE);
    assert.deepEqual(levels(group, 'bugs', ['alpha', 'bravo', 'charlie', 'delta', 'echo']), ['bad', 'warn', 'good', 'warn', 'good']);
  });

  it('takes ties with the last of the top quarter in', () => {
    const group = sessionsOf([...tasks(1, 3, 'alpha', LONG_AGO, BUGS), ...tasks(4, 3, 'bravo', LONG_AGO, BUGS), ...tasks(7, 1, 'charlie', LONG_AGO), ...tasks(8, 1, 'delta', LONG_AGO)]);
    assert.deepEqual(levels(group, 'bugs', ['alpha', 'bravo']), ['warn', 'warn']);
  });

  it('wants twice the median, not only the top quarter', () => {
    const group = sessionsOf([...tasks(1, 3, 'alpha', LONG_AGO, BUGS), ...tasks(4, 2, 'bravo', LONG_AGO, BUGS), ...tasks(6, 2, 'charlie', LONG_AGO, BUGS), ...tasks(8, 2, 'delta', LONG_AGO, BUGS)]);
    assert.equal(area(group, 'alpha').cells.bugs.level, 'good');
  });

  it('never marks a zero, whatever its peers and usual', () => {
    const group = sessionsOf(tasks(1, 2, 'alpha', LONG_AGO));
    assert.deepEqual(AREA_MEASURES.map((measure) => area(group, 'alpha').cells[measure].level), ['good', 'good', 'good', 'good', 'good']);
  });

  it('holds the low share to points over the median, never to a count', () => {
    const LOW = { priority: 3 } as const;
    const peers = [...tasks(1, 1, 'bravo', LONG_AGO, LOW), ...tasks(2, 1, 'bravo', LONG_AGO), ...tasks(3, 1, 'charlie', LONG_AGO, LOW), ...tasks(4, 1, 'charlie', LONG_AGO), ...tasks(5, 1, 'delta', LONG_AGO, LOW), ...tasks(6, 1, 'delta', LONG_AGO)];
    const highShare = sessionsOf([...peers, ...tasks(7, 3, 'alpha', LONG_AGO, LOW), ...tasks(10, 1, 'alpha', LONG_AGO)]);
    const justUnder = sessionsOf([...peers, ...tasks(7, 3, 'alpha', LONG_AGO, LOW), ...tasks(10, 2, 'alpha', LONG_AGO)]);
    const manyButFew = sessionsOf([...peers, ...tasks(7, 10, 'alpha', LONG_AGO, LOW), ...tasks(17, 20, 'alpha', LONG_AGO)]);
    assert.deepEqual([area(highShare, 'alpha').cells.low.value, area(highShare, 'alpha').cells.low.level], [75, 'warn']);
    assert.deepEqual([area(justUnder, 'alpha').cells.low.value, area(justUnder, 'alpha').cells.low.level], [60, 'good']);
    assert.deepEqual([area(manyButFew, 'alpha').cells.low.value, area(manyButFew, 'alpha').cells.low.level], [33, 'good']);
  });

  it('orders by red cells, then amber cells, then active tasks, then name', () => {
    const group = sessionsOf(FIVE);
    assert.deepEqual(names(group.areas), ['alpha', 'bravo', 'delta', 'charlie', 'echo']);
  });

  it('gives the median of the group on each measure and on its active tasks', () => {
    assert.deepEqual(sessionsOf(FIVE).median, { active: 1, bugs: 1, p1: 0, p1Late: 0, low: 0, waits: 0 });
  });

  it('stands an area out by a red cell: an amber one is not enough among peers', () => {
    assert.deepEqual(names(standingOut(sessionsOf(FIVE))), ['alpha']);
  });
});

describe('areaStats: teams and sessions', () => {
  const ALPHA = [...tasks(1, 2, 'one', LONG_AGO, { type: 'bug' }), ...tasks(3, 1, 'two', LONG_AGO, { priority: 3 })];
  const BRAVO = tasks(1, 1, 'three', LONG_AGO);

  it('adds the teams as a group of their own, each its sessions summed, and keeps sessions among sessions', () => {
    const { teams, sessions } = statsOf([team(ALPHA, 'alpha'), team(BRAVO, 'bravo')]).areas;
    assert.deepEqual(names(teams.areas), ['alpha', 'bravo']);
    assert.deepEqual([area(teams, 'alpha').session, area(teams, 'alpha').active, area(teams, 'alpha').cells.bugs.value, area(teams, 'alpha').cells.bugs.usual], [null, 3, 2, 2]);
    assert.deepEqual(names(sessions.areas), ['one', 'two', 'three']);
    assert.equal(area(sessions, 'three').team, 'bravo');
  });

  it("takes a team's low usual from its summed counts, not from its sessions' shares", () => {
    const { teams } = statsOf([team(ALPHA, 'alpha'), team(BRAVO, 'bravo')]).areas;
    assert.deepEqual([area(teams, 'alpha').cells.low.value, area(teams, 'alpha').cells.low.usual], [33, 33]);
  });

  it('holds no team group for one team, nor a team with no active task among the teams', () => {
    assert.deepEqual(statsOf([team(ALPHA)]).areas.teams, { areas: [], median: { active: 0, bugs: 0, p1: 0, p1Late: 0, low: 0, waits: 0 } });
    assert.deepEqual(names(statsOf([team(ALPHA, 'alpha'), team([], 'bravo')]).areas.teams.areas), ['alpha']);
  });

  it('narrows to the one session in a session scope, with no peers to be red against', () => {
    const events = [...tasks(1, 1, 'one', LONG_AGO, { type: 'bug' }), ...tasks(2, 9, 'two', LONG_AGO, { type: 'bug' }), ...tasks(11, 2, 'one', THIS_MORNING, { type: 'bug' })];
    const { teams, sessions } = statsOf([team(events, 'alpha'), team(BRAVO, 'bravo')], { session: { team: 'alpha', session: 'one' } }).areas;
    assert.deepEqual([teams.areas.length, names(sessions.areas)], [0, ['one']]);
    assert.deepEqual([area(sessions, 'one').cells.bugs.value, area(sessions, 'one').cells.bugs.usual, area(sessions, 'one').cells.bugs.level], [3, 1, 'warn']);
    assert.deepEqual(names(standingOut(sessions)), ['one']);
  });

  it('gives the same areas over every range: a usual is its own 30 days', () => {
    const areasIn = (range: StatsInput['range']): string[] => statsOf([team(ALPHA)], { range }).areas.sessions.areas.map((each) => `${each.session} ${each.cells.bugs.usual}`);
    assert.deepEqual(areasIn('7d'), areasIn('1y'));
  });
});
