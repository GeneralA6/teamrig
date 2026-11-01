import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { JsonRecord } from '../core/guards.ts';
import { parseJsonl, toJsonlLine } from '../core/jsonl.ts';
import {
  foldGoals,
  GOAL_RECORD_VERSION,
  goalAddRefusal,
  goalRecordJson,
  goalSetRefusal,
  isGoalDay,
  NO_GOALS,
  parseGoalRecord,
  readGoals,
  type GoalAdd,
  type GoalAddInput,
  type GoalRecord,
  type GoalSet,
  type GoalSetInput,
} from './goals.ts';

const add = (over: Partial<GoalAdd> = {}): GoalAdd => ({
  type: 'goal-add',
  at: '2030-01-08T10:00:00.000Z',
  by: 'lead',
  tag: 'A1',
  title: 'Ship the first release',
  start: '2030-01-08',
  target: '2030-01-31',
  parent: null,
  ...over,
});

const set = (over: Partial<GoalSet> = {}): GoalSet => ({
  type: 'goal-set',
  at: '2030-01-10T10:00:00.000Z',
  by: 'lead',
  tag: 'A1',
  target: '2030-02-07',
  title: null,
  note: 'the review took a week',
  ...over,
});

/** One parsed line of a goals file holding `record`. */
function lineOf(record: JsonRecord): ReturnType<typeof parseGoalRecord> {
  const [line] = parseJsonl(toJsonlLine(record)).records;
  assert.ok(line !== undefined);
  return parseGoalRecord(line);
}

function textOf(records: readonly JsonRecord[]): string {
  return records.map((record) => toJsonlLine(record)).join('');
}

describe('isGoalDay', () => {
  it('takes a real calendar day only', () => {
    assert.equal(isGoalDay('2030-02-28'), true);
    assert.equal(isGoalDay('2030-02-30'), false);
    assert.equal(isGoalDay('2030-2-28'), false);
    assert.equal(isGoalDay('2030-02-28T00:00'), false);
  });
});

describe('parseGoalRecord', () => {
  it('reads an add and a set as written, ignoring unknown extra fields', () => {
    assert.deepEqual(lineOf({ ...goalRecordJson(add({ parent: 'A' })), extra: 1 }), { kind: 'record', record: add({ parent: 'A' }) });
    assert.deepEqual(lineOf(goalRecordJson(set())), { kind: 'record', record: set() });
  });

  it('reads an add with no parent field as a top goal, and a set naming only a title', () => {
    const noParent = Object.fromEntries(Object.entries(goalRecordJson(add())).filter(([key]) => key !== 'parent'));
    assert.deepEqual(lineOf(noParent), { kind: 'record', record: add() });
    assert.deepEqual(lineOf(goalRecordJson(set({ target: null, title: 'Ship it' }))), { kind: 'record', record: set({ target: null, title: 'Ship it' }) });
  });

  it('counts a record of a newer format without reading it', () => {
    assert.deepEqual(lineOf({ ...goalRecordJson(add()), v: GOAL_RECORD_VERSION + 1, title: 3 }), { kind: 'newer' });
  });

  it('says why a record cannot be read', () => {
    const cases: readonly (readonly [JsonRecord, string])[] = [
      [{ ...goalRecordJson(add()), at: 'yesterday' }, 'at is not a time'],
      [{ ...goalRecordJson(add()), by: 'no such session!' }, 'by is not a session'],
      [{ ...goalRecordJson(add()), tag: '2A' }, 'tag "2A" is not a goal tag'],
      [{ ...goalRecordJson(add()), tag: 'none' }, 'tag "none" is not a goal tag'],
      [{ ...goalRecordJson(add()), title: ' ' }, 'title is not text'],
      [{ ...goalRecordJson(add()), target: '2030-02-30' }, 'start or target is not a day'],
      [{ ...goalRecordJson(add()), parent: 'a b' }, 'parent "a b" is not a goal tag'],
      [{ ...goalRecordJson(set()), note: '' }, 'note is not text'],
      [{ ...goalRecordJson(set()), target: 'soon' }, 'target is not a day'],
      [{ ...goalRecordJson(set()), title: '' }, 'title is not text'],
      [{ ...goalRecordJson(add()), type: 'goal-drop' }, 'unknown type "goal-drop"'],
    ];
    for (const [record, reason] of cases) {
      assert.deepEqual(lineOf(record), { kind: 'unreadable', reason });
    }
  });
});

describe('goalRecordJson', () => {
  it('writes the version first and leaves out the fields a set keeps', () => {
    assert.deepEqual(Object.keys(goalRecordJson(add())), ['v', 'type', 'at', 'by', 'tag', 'title', 'start', 'target', 'parent']);
    assert.deepEqual(goalRecordJson(set({ title: null })), { v: 1, type: 'goal-set', at: set().at, by: 'lead', tag: 'A1', note: set().note, target: '2030-02-07' });
    assert.equal('target' in goalRecordJson(set({ target: null, title: 'New' })), false);
  });
});

describe('foldGoals', () => {
  it('moves the target with a slip per move, and a title-only or same-target set slips nothing', () => {
    const records: GoalRecord[] = [
      add(),
      set(),
      set({ at: '2030-01-11T10:00:00.000Z', target: null, title: 'Ship the first public release', note: 'clearer' }),
      set({ at: '2030-01-12T10:00:00.000Z', target: '2030-02-07', note: 'same day again' }),
      set({ at: '2030-01-13T10:00:00.000Z', by: 'ops', target: '2030-02-14', note: 'a holiday' }),
    ];
    const { goals, ignored } = foldGoals(records);
    assert.equal(ignored, 0);
    assert.deepEqual(goals.get('A1'), {
      tag: 'A1',
      title: 'Ship the first public release',
      start: '2030-01-08',
      target: '2030-02-14',
      parent: null,
      addedAt: '2030-01-08T10:00:00.000Z',
      addedBy: 'lead',
      slips: [
        { at: '2030-01-10T10:00:00.000Z', by: 'lead', from: '2030-01-31', to: '2030-02-07', note: 'the review took a week' },
        { at: '2030-01-13T10:00:00.000Z', by: 'ops', from: '2030-02-07', to: '2030-02-14', note: 'a holiday' },
      ],
    });
  });

  it('ignores a set before its goal is added and a second add of a tag, keeping goals in add order', () => {
    const { goals, ignored } = foldGoals([set({ tag: 'B1' }), add({ tag: 'B1' }), add(), add({ title: 'Again' })]);
    assert.equal(ignored, 2);
    assert.deepEqual([...goals.keys()], ['B1', 'A1']);
    assert.equal(goals.get('A1')?.title, 'Ship the first release');
    assert.equal(goals.get('B1')?.target, '2030-01-31');
  });
});

describe('readGoals', () => {
  it('reads no file as no goals', () => {
    assert.equal(readGoals(undefined), NO_GOALS);
  });

  it('folds the readable records and counts damaged, unreadable, newer and ignored lines', () => {
    const text = [
      textOf([goalRecordJson(add()), goalRecordJson(add({ tag: 'A1.1', parent: 'A1' }))]),
      '{"torn": \n',
      textOf([{ ...goalRecordJson(set()), note: '' }, { ...goalRecordJson(set()), v: 9 }, goalRecordJson(set({ tag: 'C1' })), goalRecordJson(set())]),
    ].join('');
    const read = readGoals(text);
    assert.deepEqual([...read.goals.keys()], ['A1', 'A1.1']);
    assert.equal(read.goals.get('A1')?.target, '2030-02-07');
    assert.equal(read.goals.get('A1.1')?.parent, 'A1');
    assert.deepEqual({ unreadable: read.unreadable, newer: read.newer, ignored: read.ignored }, { unreadable: 2, newer: 1, ignored: 1 });
  });
});

describe('goalAddRefusal', () => {
  const goals = foldGoals([add()]).goals;
  const input = (over: Partial<GoalAddInput> = {}): GoalAddInput => ({
    tag: 'B1',
    title: 'Open the beta',
    start: '2030-01-08',
    target: '2030-01-20',
    parent: null,
    ...over,
  });

  it('lets a new goal in, a top one or one under an existing goal', () => {
    assert.equal(goalAddRefusal(input(), goals), undefined);
    assert.equal(goalAddRefusal(input({ tag: 'A1.1', parent: 'A1', start: '2030-01-20', target: '2030-01-20' }), goals), undefined);
  });

  it('says why it refuses each bad add', () => {
    const cases: readonly (readonly [Partial<GoalAddInput>, RegExp])[] = [
      [{ tag: 'none' }, /"none" is what a task names when it serves no goal/],
      [{ tag: 'b 1' }, /"b 1" is not a goal tag/],
      [{ tag: 'A1' }, /goal A1 already exists; move its target with goal set/],
      [{ title: '  ' }, /a goal has a title/],
      [{ start: '2030-01-32' }, /--start and --target are YYYY-MM-DD days/],
      [{ target: '01-20' }, /--start and --target are YYYY-MM-DD days/],
      [{ start: '2030-01-21' }, /--start 2030-01-21 is after --target 2030-01-20/],
      [{ parent: 'Z9' }, /--parent Z9 is not a goal; add it first/],
    ];
    for (const [over, refusal] of cases) {
      assert.match(goalAddRefusal(input(over), goals) ?? '', refusal);
    }
  });
});

describe('goalSetRefusal', () => {
  const goals = foldGoals([add()]).goals;
  const input = (over: Partial<GoalSetInput> = {}): GoalSetInput => ({ tag: 'A1', target: '2030-02-07', title: null, note: 'slipped', ...over });

  it('lets a new target, a new title or both in', () => {
    assert.equal(goalSetRefusal(input(), goals), undefined);
    assert.equal(goalSetRefusal(input({ target: null, title: 'Renamed' }), goals), undefined);
    assert.equal(goalSetRefusal(input({ target: '2030-01-08', title: 'Both' }), goals), undefined);
  });

  it('says why it refuses each bad set', () => {
    const cases: readonly (readonly [Partial<GoalSetInput>, RegExp])[] = [
      [{ tag: 'B1' }, /goal B1 does not exist; add it with goal add/],
      [{ target: null }, /goal set changes --target, --title or both/],
      [{ note: ' ' }, /goal set says why in --note/],
      [{ target: '2030-02-30' }, /--target is a YYYY-MM-DD day/],
      [{ target: '2030-01-07' }, /--target 2030-01-07 is before the goal's start 2030-01-08/],
      [{ target: null, title: ' ' }, /a goal has a title/],
      [{ target: '2030-01-31' }, /goal A1 already reads so; nothing to change/],
      [{ target: null, title: 'Ship the first release' }, /goal A1 already reads so; nothing to change/],
    ];
    for (const [over, refusal] of cases) {
      assert.match(goalSetRefusal(input(over), goals) ?? '', refusal);
    }
  });
});
