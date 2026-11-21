import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SecretScanner } from '../core/secrets.ts';
import { EVENT_VERSION, type RegisterEvent, type TaskFields } from '../register/events.ts';
import type { Goal } from '../register/goals.ts';
import { GITHUB_SOURCE, type TaskStatus } from '../register/model.ts';
import { registerHealth } from '../register/stats-health.ts';
import { registerStats, type RegisterStats, type StatsScope } from '../register/stats.ts';
import type { WaitReason } from '../register/waits.ts';
import { JERUSALEM } from '../testing/zone.ts';
import { cutText, statsBody, type ServedStatsTask, type StatsBody } from './index.ts';

/** A text the shipped shapes take for a secret, built here so no secret-shaped line sits in the repository. */
const SECRET = ['pass', 'word', '=', 'hunter2'].join('');

const FIELDS: TaskFields = { title: 'Ship it', description: 'the long words', owner: 'alpha', source: 'lead', ref: null, priority: 2, due: null, goals: [], noGoal: false, week: null, after: [], size: null, type: null, critical: false, pin: null, workClass: null, prepares: null };

/** Thursday 2030-01-10 12:00 on the team's clock (UTC+2): a 7 d range runs 01-04 to 01-10. */
const NOW = new Date('2030-01-10T10:00:00.000Z');
const VALID_UNTIL = Date.parse('2030-01-10T22:00:00.000Z');

const CONNECTORS = [{ id: GITHUB_SOURCE, name: 'GitHub' }];

function create(id: string, at: string, fields: Partial<TaskFields> = {}): RegisterEvent {
  return { v: EVENT_VERSION, type: 'create', id, at, by: 'lead', task: { ...FIELDS, ...fields } };
}

function status(id: string, at: string, value: TaskStatus, waits?: readonly WaitReason[]): RegisterEvent {
  const event: RegisterEvent = { v: EVENT_VERSION, type: 'status', id, at, by: 'alpha', status: value, note: 'n', evidence: null, skill: null };
  return waits === undefined ? event : { ...event, waits };
}

function goal(tag: string, changes: Partial<Goal> = {}): Goal {
  return { tag, title: `Goal ${tag}`, start: '2030-01-04', target: '2030-02-01', parent: null, addedAt: '2030-01-04T08:00:00.000Z', addedBy: 'lead', slips: [], rank: null, slice: null, slices: [], ...changes };
}

/** T1 done on its goal, T2 an imported p1 past its due, T3 bravo's, waiting on the owner. */
const EVENTS: readonly RegisterEvent[] = [
  create('T1', '2030-01-05T08:00:00.000Z', { goals: ['A1'] }),
  status('T1', '2030-01-06T08:00:00.000Z', 'in-progress'),
  status('T1', '2030-01-08T08:00:00.000Z', 'done'),
  create('T2', '2030-01-07T08:00:00.000Z', { title: 'Fix the \u001b[31mred\u001b[0m login', source: GITHUB_SOURCE, priority: 1, due: '2030-01-08', type: 'bug' }),
  create('T3', '2030-01-09T08:00:00.000Z', { owner: 'bravo', source: 'owner' }),
  status('T3', '2030-01-09T09:00:00.000Z', 'waiting', [{ kind: 'decision', who: 'owner' }]),
];

interface Asked {
  readonly events?: readonly RegisterEvent[];
  readonly goals?: readonly Goal[];
  readonly session?: StatsScope;
  readonly owner?: string;
}

function foldOf(asked: Asked = {}): RegisterStats {
  return registerStats({
    teams: [{ team: 'app', lead: 'lead', events: asked.events ?? EVENTS }],
    range: '7d',
    now: NOW,
    zone: JERUSALEM,
    ownerMarker: asked.owner ?? 'owner',
    goals: new Map((asked.goals ?? [goal('A1')]).map((each) => [each.tag, each])),
    ...(asked.session === undefined ? {} : { session: asked.session }),
  });
}

function bodyOf(asked: Asked = {}): StatsBody {
  const stats = foldOf(asked);
  return statsBody({
    stats,
    health: registerHealth(stats),
    session: asked.session?.session ?? null,
    now: NOW.getTime(),
    validUntil: VALID_UNTIL,
    shapes: new SecretScanner(),
    names: { owner: asked.owner ?? 'owner', connectors: CONNECTORS },
  });
}

function rowOf(body: StatsBody, id: string): ServedStatsTask {
  const found = body.tasks.find((row) => row.id === id);
  assert.ok(found !== undefined, `${id} has a row`);
  return found;
}

describe('statsBody', () => {
  it('says when it was counted, until when it holds, its range and that no session narrows it', () => {
    const body = bodyOf();
    assert.deepEqual([body.at, body.validUntil, body.range, body.session], ['2030-01-10T10:00:00.000Z', '2030-01-10T22:00:00.000Z', '7d', null]);
  });

  it('serves each day of the range with its flow and its active tasks by status', () => {
    const body = bodyOf();
    assert.deepEqual(body.days.map((day) => day.day), ['2030-01-04', '2030-01-05', '2030-01-06', '2030-01-07', '2030-01-08', '2030-01-09', '2030-01-10']);
    assert.deepEqual(body.days[4], { day: '2030-01-08', opened: 0, done: 1, dropped: 0, active: { open: 1, 'in-progress': 0, verifying: 0, waiting: 0 }, atLimit: false });
    assert.deepEqual(body.days[5]?.active, { open: 1, 'in-progress': 0, verifying: 0, waiting: 1 });
  });

  it('marks a day the week sat at its usage limit', () => {
    const stats = registerStats({ teams: [{ team: 'app', lead: 'lead', events: EVENTS }], range: '7d', now: NOW, zone: JERUSALEM, ownerMarker: 'owner', limits: [{ start: Date.parse('2030-01-07T09:00:00.000Z'), end: Date.parse('2030-01-07T11:00:00.000Z') }] });
    const body = statsBody({ stats, health: registerHealth(stats), session: null, now: NOW.getTime(), validUntil: VALID_UNTIL, shapes: new SecretScanner(), names: { owner: 'owner', connectors: CONNECTORS } });
    assert.deepEqual(body.days.filter((day) => day.atLimit).map((day) => day.day), ['2030-01-07']);
  });

  it('serves the flow, the times, the new work, the waits, the bugs and the people under the names the fold gives them', () => {
    const stats = foldOf();
    const body = bodyOf();
    assert.deepEqual([body.opened, body.closedTasks, body.droppedTasks, body.net, body.closes], [3, 1, 0, 2, 1]);
    assert.deepEqual(body.recent, { days: 28, net: 2 });
    assert.deepEqual(body.active, { open: 1, 'in-progress': 0, verifying: 0, waiting: 1 });
    assert.deepEqual(body.all, { active: 2, leadTime: { count: 1, median: 3, p85: 3 }, cycleTime: { count: 1, median: 2, p85: 2 }, overdue: { count: 1, p1: 1 }, due: { total: 0, onTime: 0 } });
    assert.deepEqual(body.newWork, { total: 3, bySource: { self: 0, owner: 1, lead: 1, github: 1, session: 0 }, bugs: 1, byPriority: [{ priority: 1, count: 1 }, { priority: 2, count: 2 }], byGoal: [{ goal: 'A1', count: 1 }], noGoal: 2 });
    assert.deepEqual(body.waits.byKind, { decision: 1, approval: 0, task: 0, time: 0 });
    assert.deepEqual([body.waits.waiting, body.waits.ownerDecisions.count], [1, 1]);
    assert.deepEqual(body.bugs, { active: 1, opened: 1, fixed: 0 });
    assert.deepEqual(body.people, [{ team: 'app', session: 'alpha', done: 1 }]);
    assert.deepEqual([body.neverStarted, body.dueMoved, body.splits], [0, 0, []]);
    assert.deepEqual([body.activeByAge, body.lateDays], [stats.activeByAge, stats.lateDays]);
    assert.deepEqual(body.activeByAge.find((band) => band.label === '2-7 d'), { label: '2-7 d', count: 1 });
  });

  it('serves the five Health tiles with their levels', () => {
    const body = bodyOf();
    assert.deepEqual(body.health, registerHealth(foldOf()));
    assert.deepEqual(body.health.overdue, { level: 'bad', count: 1, p1: 1 });
    assert.deepEqual(Object.keys(body.health), ['closeOpen', 'backlog', 'overdue', 'ownerDecisions', 'backlogClears']);
  });

  it('names the tasks behind a count by id, in the count\'s order, and serves each one\'s row once', () => {
    const body = bodyOf();
    assert.deepEqual(body.behind, { active: ['T2', 'T3'], opened: ['T1', 'T2', 'T3'], closed: ['T1'], overdue: ['T2'], overdueP1: ['T2'], ownerDecisions: ['T3'] });
    assert.deepEqual(body.tasks.map((row) => row.id), ['T1', 'T2', 'T3']);
    assert.deepEqual(rowOf(body, 'T1'), { id: 'T1', title: { text: 'Ship it', source: 'team' }, owner: 'alpha', priority: 2, status: 'done', due: null });
    assert.deepEqual([rowOf(body, 'T2').due, rowOf(body, 'T3').status], ['2030-01-08', 'waiting']);
  });

  it('orders the rows by the number of their id, not as text', () => {
    const body = bodyOf({ events: [create('T10', '2030-01-05T08:00:00.000Z'), create('T9', '2030-01-06T08:00:00.000Z')] });
    assert.deepEqual(body.tasks.map((row) => row.id), ['T9', 'T10']);
  });

  it('serves no field of a task but its row\'s, and no per-team copy of the whole', () => {
    const body = bodyOf();
    assert.ok(!JSON.stringify(body).includes('the long words'));
    assert.deepEqual(Object.keys(rowOf(body, 'T2')), ['id', 'title', 'owner', 'priority', 'status', 'due']);
    assert.ok(!Object.keys(body).includes('teams'));
  });

  it('serves a goal over its history, its texts scanned, its slips as instants and its tasks by id', () => {
    const moved = { at: '2030-01-09T08:00:00.000Z', by: 'lead', from: '2030-02-01', to: '2030-02-10', note: 'the audit took a week' };
    const body = bodyOf({ goals: [goal('A1', { target: '2030-02-10', slips: [moved] }), goal('B2', { title: SECRET, parent: 'A1' })] });
    const [first, second] = body.goals.goals;
    assert.deepEqual(first, {
      tag: 'A1',
      title: 'Goal A1',
      start: '2030-01-04',
      target: '2030-02-10',
      parent: null,
      slips: [moved],
      done: 1,
      open: 0,
      doneDays: [{ day: '2030-01-08', done: 1 }],
      pace: 1 / 14,
      forecast: null,
      state: 'done',
      tasks: ['T1'],
    });
    const shape = new SecretScanner().find(SECRET)?.description;
    assert.ok(shape !== undefined);
    assert.deepEqual([second?.title, second?.parent, second?.tasks], [cutText(shape), 'A1', []]);
    assert.deepEqual(body.cuts, [{ id: 'B2', field: 'title', shape }]);
    assert.deepEqual([body.goals.offGoal, body.goals.doneInRange], [0, 1]);
  });

  it('marks an imported task\'s title as outside text and escapes what a terminal would run', () => {
    const { title } = rowOf(bodyOf(), 'T2');
    assert.equal(title.source, 'outside');
    assert.ok(!title.text.includes('\u001b') && title.text.includes('login'));
  });

  it('reads the owner\'s marker before a connector\'s id, as a task\'s source is read', () => {
    const body = bodyOf({ owner: GITHUB_SOURCE });
    assert.equal(rowOf(body, 'T2').title.source, 'team');
  });

  it('cuts a title that has a secret\'s shape once, however many counts name its task', () => {
    const body = bodyOf({ events: [create('T1', '2030-01-09T08:00:00.000Z', { title: SECRET, priority: 1, due: '2030-01-09' })] });
    const shape = new SecretScanner().find(SECRET)?.description;
    assert.ok(shape !== undefined);
    assert.deepEqual([body.behind.active, body.behind.opened, body.behind.overdue], [['T1'], ['T1'], ['T1']]);
    assert.deepEqual(rowOf(body, 'T1').title, { text: cutText(shape), source: 'team' });
    assert.deepEqual(body.cuts, [{ id: 'T1', field: 'title', shape }]);
    assert.ok(!JSON.stringify(body).includes(SECRET));
  });

  it('holds each session against the others, a cell\'s tasks by id with their rows, and no team while one is counted', () => {
    const body = bodyOf();
    assert.deepEqual(body.areas.teams, { areas: [], median: { bugs: 0, p1: 0, p1Late: 0, low: 0, waits: 0, active: 0 } });
    const alpha = body.areas.sessions.areas.find((area) => area.session === 'alpha');
    assert.ok(alpha !== undefined);
    assert.deepEqual([alpha.team, alpha.active], ['app', 1]);
    assert.deepEqual(Object.keys(alpha.cells), ['bugs', 'p1', 'p1Late', 'low', 'waits']);
    assert.deepEqual([alpha.cells.bugs.value, alpha.cells.bugs.tasks, alpha.cells.p1Late.tasks], [1, ['T2'], ['T2']]);
    assert.deepEqual(Object.keys(alpha.cells.bugs), ['value', 'usual', 'level', 'tasks']);
    assert.deepEqual(Object.keys(body.areas.sessions.median), ['bugs', 'p1', 'p1Late', 'low', 'waits', 'active']);
  });

  it('names the one session its numbers are narrowed to', () => {
    const body = bodyOf({ session: { team: 'app', session: 'bravo' } });
    assert.deepEqual([body.session, body.opened, body.behind.active], ['bravo', 1, ['T3']]);
    assert.deepEqual(body.tasks.map((row) => row.id), ['T3']);
  });
});
