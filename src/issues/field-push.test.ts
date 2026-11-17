import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_ISSUE_FIELDS } from '../config/defaults.ts';
import type { Task } from '../register/fold.ts';
import { testTask } from '../testing/task.ts';
import { JERUSALEM } from '../testing/zone.ts';
import { fieldWriteLine, kindOf, planFieldPush, type FieldPushInput, type FieldsRead } from './field-push.ts';
import type { FieldValue, FieldedIssue, HostField } from './fields.ts';

const REPO = 'acme/web';
const PRIORITY: HostField = { name: 'Priority', kind: 'single-select', id: 11, options: ['P0', 'P1 - high', 'P2', 'P10'] };
const START: HostField = { name: 'Start date', kind: 'date', id: 12, options: [] };
const TARGET: HostField = { name: 'Target date', kind: 'date', id: 13, options: [] };
const SCORE: HostField = { name: 'Score', kind: 'number', id: 14, options: [] };

function issue(number: number, values: Readonly<Record<string, FieldValue>> = {}, type?: string): FieldedIssue {
  return { number, type, values: new Map(Object.entries(values).map(([name, value]) => [name.toLowerCase(), value])) };
}

function fieldsRead(issues: readonly FieldedIssue[], overrides: Partial<FieldsRead> = {}): FieldsRead {
  return { kind: 'read', fields: [PRIORITY, START, TARGET, SCORE], types: ['Task', 'Bug', 'Feature'], issues, notes: [], ...overrides };
}

function held(number: number, overrides: Partial<Task> = {}): Task {
  return testTask({ id: `T${number}`, ref: `gh:${REPO}#${number}`, ...overrides });
}

function plan(overrides: Partial<FieldPushInput>): ReturnType<typeof planFieldPush> {
  return planFieldPush({
    repo: REPO,
    read: fieldsRead([]),
    tasks: [],
    labelsOf: () => [],
    config: DEFAULT_ISSUE_FIELDS,
    zone: JERUSALEM,
    scoreOf: () => undefined,
    writes: 100,
    ...overrides,
  });
}

describe('planFieldPush (T3406)', () => {
  it('writes the priority option, the start day on the team clock, the due day, the rounded score and the type', () => {
    const task = held(5, { priority: 1, startedAt: '2030-01-07T23:30:00.000Z', due: '2030-01-09 21:59' });
    const result = plan({ read: fieldsRead([issue(5)]), tasks: [task], scoreOf: () => 18.27 });
    assert.deepEqual(result.writes.map(fieldWriteLine), [
      `FIELD ${REPO}#5 (T5): Priority P1 - high`,
      `FIELD ${REPO}#5 (T5): Start date 2030-01-08`,
      `FIELD ${REPO}#5 (T5): Target date 2030-01-09`,
      `FIELD ${REPO}#5 (T5): Score 18`,
      `TYPE ${REPO}#5 (T5): Task`,
    ]);
    assert.deepEqual(result.notes, []);
    assert.equal(result.deferred, 0);
  });

  it('writes nothing an issue already holds, so a score that moved less than a whole point is not written again', () => {
    const task = held(5, { priority: 0, due: '2030-01-09' });
    const read = fieldsRead([issue(5, { Priority: 'P0', 'Target date': '2030-01-09', Score: 18 }, 'task')]);
    assert.deepEqual(plan({ read, tasks: [task], scoreOf: () => 18.4 }).writes, []);
    const moved = plan({ read, tasks: [task], scoreOf: () => 18.6 }).writes.map(fieldWriteLine);
    assert.deepEqual(moved, [`FIELD ${REPO}#5 (T5): Score 19, was 18`]);
  });

  it('sets a value back over one set by hand, one way from the register, and clears nothing it has no value for', () => {
    const task = held(5, { priority: 2 });
    const read = fieldsRead([issue(5, { Priority: 'P0', 'Start date': '2030-01-01' }, 'Task')]);
    assert.deepEqual(plan({ read, tasks: [task] }).writes.map(fieldWriteLine), [`FIELD ${REPO}#5 (T5): Priority P2, was P0`]);
  });

  it('types a design issue, a goal and a bug by their kind, the first type of each list the repository has', () => {
    const tasks = [held(1), held(2, { after: ['T9'] }), held(3, { type: 'bug' }), held(4)];
    const read = fieldsRead([issue(1), issue(2), issue(3), issue(4)], { types: ['task', 'Bug', 'Feature', 'Design'] });
    const result = plan({ read, tasks, labelsOf: (number) => (number === 4 ? ['Design'] : []), config: { ...DEFAULT_ISSUE_FIELDS, priority: '' } });
    assert.deepEqual(
      result.writes.filter((write) => write.kind === 'type').map(fieldWriteLine),
      [`TYPE ${REPO}#1 (T1): task`, `TYPE ${REPO}#2 (T2): Feature`, `TYPE ${REPO}#3 (T3): Bug`, `TYPE ${REPO}#4 (T4): Design`],
    );
  });

  it('skips a field the repository lacks, one of another kind and a priority with no option, each noted once', () => {
    const read = fieldsRead([issue(1), issue(2)], { fields: [{ ...PRIORITY, options: ['Normal'] }, { ...SCORE, kind: 'text' }], types: [] });
    const result = plan({ read, tasks: [held(1), held(2)], scoreOf: () => 5 });
    assert.deepEqual(result.writes, []);
    assert.deepEqual(result.notes, [
      `${REPO} has no issue field named "Start date", so none is written there`,
      `${REPO} has no issue field named "Target date", so none is written there`,
      `${REPO}'s issue field "Score" is a text field, not a number one, so none is written there`,
      `${REPO}'s field "Priority" has none of P2, High for P2 (its options: Normal), so tasks of that priority get none; github.fields.priorityOptions names them`,
      `${REPO} has no issue types turned on, so its issues keep their type`,
    ]);
  });

  it('matches a priority option by its whole P number, so P1 never takes P10', () => {
    const read = fieldsRead([issue(1)], { fields: [{ ...PRIORITY, options: ['P10', 'P1'] }] });
    assert.deepEqual(plan({ read, tasks: [held(1, { priority: 1 })], config: { ...DEFAULT_ISSUE_FIELDS, types: { ...DEFAULT_ISSUE_FIELDS.types, task: [] } } }).writes.map(fieldWriteLine), [
      `FIELD ${REPO}#1 (T1): Priority P1`,
    ]);
  });

  it("writes GitHub's own Priority options by default, a team's names over them, none for an empty list, and P<n> for a level not listed", () => {
    const github: HostField = { ...PRIORITY, options: ['Urgent', 'High', 'Medium', 'Low', 'P7'] };
    const levels = [0, 1, 2, 3, 4, 5, 7];
    const read = fieldsRead(levels.map((level) => issue(level + 1)), { fields: [github], types: [] });
    const tasks = levels.map((level) => held(level + 1, { priority: level }));
    const options = (config: FieldPushInput['config']): string[] =>
      plan({ read, tasks, config }).writes.flatMap((write) => (write.kind === 'field' ? [`${write.target.number}:${String(write.value)}`] : []));
    assert.deepEqual(options(DEFAULT_ISSUE_FIELDS), ['1:Urgent', '2:Urgent', '3:High', '4:Medium', '5:Low', '6:Low', '8:P7']);
    const team = { ...DEFAULT_ISSUE_FIELDS, priorityOptions: { ...DEFAULT_ISSUE_FIELDS.priorityOptions, p2: ['Medium'], p5: [] } };
    assert.deepEqual(options(team), ['1:Urgent', '2:Urgent', '3:Medium', '4:Medium', '5:Low', '8:P7']);
    assert.deepEqual(plan({ read, tasks, config: team }).notes.filter((note) => note.includes('"Priority"')), []);
  });

  it('plans only open issues the read found in this repository, and defers what passes the writes left', () => {
    const tasks = [held(1), held(2), testTask({ id: 'T3', ref: 'gh:acme/other#1' }), held(4), testTask({ id: 'T5' })];
    const result = plan({ read: fieldsRead([issue(1), issue(2)]), tasks, writes: 3 });
    assert.deepEqual(result.writes.map(fieldWriteLine), [`FIELD ${REPO}#1 (T1): Priority P2`, `TYPE ${REPO}#1 (T1): Task`, `FIELD ${REPO}#2 (T2): Priority P2`]);
    assert.equal(result.deferred, 1);
    assert.equal(plan({ read: fieldsRead([issue(1)]), tasks, writes: -2 }).deferred, 2);
  });

  it('writes nothing with every field name empty and no type lists', () => {
    const config = { ...DEFAULT_ISSUE_FIELDS, priority: '', startDate: '', targetDate: '', score: '', types: { task: [], bug: [], goal: [], design: [] } };
    assert.deepEqual(plan({ read: fieldsRead([issue(1)]), tasks: [held(1, { due: '2030-01-09' })], config }), { writes: [], deferred: 0, notes: [] });
  });
});

describe('kindOf (T3406)', () => {
  it('reads the design label before the goal and the bug', () => {
    assert.equal(kindOf({ after: ['T2'], type: 'bug' }, ['DESIGN']), 'design');
    assert.equal(kindOf({ after: ['T2'], type: 'bug' }, []), 'goal');
    assert.equal(kindOf({ after: [], type: 'bug' }, []), 'bug');
    assert.equal(kindOf({ after: [], type: null }, ['area:cli']), 'task');
  });
});
