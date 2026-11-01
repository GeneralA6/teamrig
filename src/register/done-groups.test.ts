import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TimeZone } from '../core/zone.ts';
import { testTask } from '../testing/task.ts';
import { JERUSALEM } from '../testing/zone.ts';
import { doneGroups, doneGroupTitle, URGENT_PRIORITY, type DoneGroup, type DoneGroupsInput } from './done-groups.ts';
import type { Task } from './fold.ts';

const OWNER = 'owner';
const FROM = Date.parse('2030-01-08T00:00:00.000Z');
const TO = Date.parse('2030-01-09T00:00:00.000Z');
/** Inside the span. */
const AT = '2030-01-08T10:00:00.000Z';

function done(id: string, overrides: Partial<Task> = {}): Task {
  return testTask({ id, status: 'done', statusAt: AT, ...overrides });
}

function groupsOf(tasks: readonly Task[], overrides: Partial<DoneGroupsInput> = {}): string[] {
  return doneGroups({ tasks, ownerMarker: OWNER, zone: TimeZone.UTC, from: FROM, to: TO, ...overrides }).groups.map(
    (group) => `${doneGroupTitle(group)}: ${group.tasks.map((task) => task.id).join(' ')}`,
  );
}

describe('doneGroups', () => {
  it('counts a task done or dropped from the start of the span up to, not at, its end', () => {
    const result = doneGroups({
      tasks: [
        done('T1', { statusAt: '2030-01-07T23:59:59.999Z' }),
        done('T2', { statusAt: '2030-01-08T00:00:00.000Z' }),
        done('T3', { statusAt: '2030-01-09T00:00:00.000Z' }),
        done('T4', { status: 'verifying' }),
        done('T5', { status: 'open' }),
        done('T6', { status: 'dropped' }),
      ],
      ownerMarker: OWNER,
      zone: TimeZone.UTC,
      from: FROM,
      to: TO,
    });
    assert.deepEqual(result.groups.flatMap((group) => group.tasks.map((task) => task.id)), ['T2']);
    assert.equal(result.done, 1);
    assert.deepEqual(result.dropped.map((task) => task.id), ['T6']);
  });

  it('puts a task in the first group it fits: owner asked, goal, urgent, this week, other', () => {
    const tasks = [
      done('T1', { source: OWNER, goals: ['G1'], priority: 1, week: '2030-01-07' }),
      done('T2', { goals: ['G1'], priority: 1, week: '2030-01-07' }),
      done('T3', { priority: 1, week: '2030-01-07' }),
      done('T4', { week: '2030-01-07' }),
      done('T5'),
    ];
    assert.deepEqual(groupsOf(tasks), ['Owner asked: T1', 'G1: T2', 'Urgent p1: T3', "This week's plan: T4", 'Other work: T5']);
  });

  it('takes p0 and p1 as urgent and leaves p2 to the groups after it', () => {
    const tasks = [done('T1', { priority: 0 }), done('T2', { priority: URGENT_PRIORITY }), done('T3', { priority: URGENT_PRIORITY + 1 })];
    assert.deepEqual(groupsOf(tasks), ['Urgent p1: T1 T2', 'Other work: T3']);
  });

  it('gives each goal its own group, by its first goal, ordered by tag with numbers read as numbers', () => {
    const tasks = [done('T1', { goals: ['A10'] }), done('T2', { goals: ['A2', 'A10'] }), done('T3', { goals: ['A2.1'] }), done('T4', { goals: ['A2'] })];
    assert.deepEqual(groupsOf(tasks), ['A2: T2 T4', 'A2.1: T3', 'A10: T1']);
  });

  it('lists only the groups that hold a task', () => {
    assert.deepEqual(groupsOf([done('T1', { source: OWNER }), done('T2')]), ['Owner asked: T1', 'Other work: T2']);
    assert.deepEqual(groupsOf([]), []);
  });

  it('orders a group by priority, then by when it was done, then by id', () => {
    const tasks = [
      done('T10', { statusAt: '2030-01-08T09:00:00.000Z' }),
      done('T9', { statusAt: '2030-01-08T09:00:00.000Z' }),
      done('T1', { statusAt: '2030-01-08T11:00:00.000Z' }),
      done('T2', { statusAt: '2030-01-08T12:00:00.000Z', priority: 3 }),
      done('T3', { statusAt: '2030-01-08T08:00:00.000Z' }),
    ];
    assert.deepEqual(groupsOf(tasks), ['Other work: T3 T9 T10 T1 T2']);
  });

  it('keeps dropped tasks apart, in the same order, out of the groups and the done count', () => {
    const result = doneGroups({
      tasks: [
        done('T1', { status: 'dropped', source: OWNER, statusAt: '2030-01-08T11:00:00.000Z' }),
        done('T2', { status: 'dropped', priority: 1, statusAt: '2030-01-08T12:00:00.000Z' }),
        done('T3', { status: 'dropped', statusAt: '2030-01-08T09:00:00.000Z' }),
        done('T4'),
      ],
      ownerMarker: OWNER,
      zone: TimeZone.UTC,
      from: FROM,
      to: TO,
    });
    assert.deepEqual(result.dropped.map((task) => task.id), ['T2', 'T3', 'T1']);
    assert.equal(result.done, 1);
    assert.deepEqual(result.groups.map((group) => group.kind), ['other']);
  });

  it("takes this week's plan from the start of the week tag's day on the team's clock to the start of the day a week on", () => {
    const span = { zone: JERUSALEM, from: Date.parse('2030-01-01T00:00:00.000Z'), to: Date.parse('2030-02-01T00:00:00.000Z') };
    const week = '2030-01-07';
    const tasks = [
      done('T1', { week, statusAt: '2030-01-06T21:59:59.999Z' }),
      done('T2', { week, statusAt: '2030-01-06T22:00:00.000Z' }),
      done('T3', { week, statusAt: '2030-01-13T21:59:59.999Z' }),
      done('T4', { week, statusAt: '2030-01-13T22:00:00.000Z' }),
    ];
    assert.deepEqual(groupsOf(tasks, span), ["This week's plan: T2 T3", 'Other work: T1 T4']);
  });

  it('ends a week across a clock change at midnight of its last day, not seven times 24 hours on', () => {
    // Israel moves to summer time on Fri 2030-03-29: the week of Mon 03-25 starts 03-24 22:00 UTC (IST) and ends at
    // midnight IDT of 04-01, 03-31 21:00 UTC; 24-hour days would end it an hour later.
    const span = { zone: JERUSALEM, from: Date.parse('2030-03-01T00:00:00.000Z'), to: Date.parse('2030-05-01T00:00:00.000Z') };
    const week = '2030-03-25';
    const tasks = [done('T1', { week, statusAt: '2030-03-31T20:59:59.999Z' }), done('T2', { week, statusAt: '2030-03-31T21:30:00.000Z' })];
    assert.deepEqual(groupsOf(tasks, span), ["This week's plan: T1", 'Other work: T2']);
  });

  it('sends a task with a malformed week tag to other work', () => {
    assert.deepEqual(groupsOf([done('T1', { week: '2030-13-01' }), done('T2', { week: 'next week' })]), ['Other work: T1 T2']);
  });
});

describe('doneGroupTitle', () => {
  it('names each kind of group, a goal group by its tag', () => {
    const group = (kind: DoneGroup['kind'], goal: string | null = null): DoneGroup => ({ kind, goal, tasks: [] });
    assert.deepEqual(
      [group('owner'), group('goal', 'A3.3'), group('urgent'), group('plan'), group('other')].map(doneGroupTitle),
      ['Owner asked', 'A3.3', 'Urgent p1', "This week's plan", 'Other work'],
    );
  });
});
