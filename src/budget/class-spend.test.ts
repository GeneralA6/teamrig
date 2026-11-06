import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classRowsOf, classSpendSince, NO_TASK_ROW, spentClassesOf, type ClassRowsInput, type SpentClassesInput } from './class-spend.ts';
import { emptyPatterns } from './patterns.ts';
import { EMPTY_USAGE, newCursor, type DayUsage, type UsageState } from './store.ts';
import type { OpenTurn } from './tasks.ts';
import { wSince } from './week.ts';

const MONDAY = '2030-01-07';
const TUESDAY = '2030-01-08';
const WEDNESDAY = '2030-01-09';
const NOW = Date.parse(`${WEDNESDAY}T10:00:00Z`);
/** The week begins mid-Tuesday: at 12:00 UTC. */
const WEEK_START = Date.parse(`${TUESDAY}T12:00:00Z`);
const TODAY_START = Date.parse(`${WEDNESDAY}T00:00:00Z`);

const FOCUS: ClassRowsInput['focus'] = { classes: ['Roadmap', 'Maintenance', 'Improvements'], defaultClass: 'Improvements', allocation: { Roadmap: 60, Maintenance: 25, Improvements: 15 } };

function day(w: number): DayUsage {
  return { w, calls: 1, patterns: emptyPatterns() };
}

/** A session's usage: W per day, W per hour, W per day per task and its open turns. */
function usage(byDay: Readonly<Record<string, number>>, byTask: UsageState['byTask'], byHour: UsageState['byHour'] = {}, turns: readonly OpenTurn[] = []): UsageState {
  const cursors = Object.fromEntries(turns.map((turn, index) => [`t${index}.jsonl`, { ...newCursor(0, 0, TUESDAY), turn }]));
  return { ...EMPTY_USAGE, byDay: Object.fromEntries(Object.entries(byDay).map(([key, w]) => [key, day(w)])), byHour, byTask, cursors };
}

const CLASSES: ReadonlyMap<string, string> = new Map([
  ['T1', 'Roadmap'],
  ['T2', 'Improvements'],
]);
const classOfTask = (task: string): string | undefined => CLASSES.get(task);

describe('classSpendSince', () => {
  it('sums each class over the sessions, and leaves the rest as no task, so the two add up to the W of the span', () => {
    const states = [usage({ [WEDNESDAY]: 1_000 }, { [WEDNESDAY]: { T1: 600, T2: 100 } }), usage({ [WEDNESDAY]: 500 }, { [WEDNESDAY]: { T1: 200 } })];

    const spend = classSpendSince(states, TODAY_START, NOW, classOfTask);

    assert.deepEqual(Object.fromEntries(spend.byClass), { Roadmap: 800, Improvements: 100 });
    assert.equal(spend.noTaskW, 600);
    assert.equal(spend.noTaskW + 900, wSince(states, TODAY_START, NOW));
  });

  it("takes on the span's first day only the part of its W after the start, by that day's hours", () => {
    const state = usage({ [TUESDAY]: 1_000, [WEDNESDAY]: 100 }, { [TUESDAY]: { T1: 500 }, [WEDNESDAY]: { T1: 100 } }, { [`${TUESDAY}T06`]: 750, [`${TUESDAY}T15`]: 250 });

    const spend = classSpendSince([state], WEEK_START, NOW, classOfTask);

    assert.equal(spend.byClass.get('Roadmap'), 225);
    assert.equal(spend.noTaskW, 125);
  });

  it('counts the whole first day of a span that begins at midnight, and no day before it', () => {
    const state = usage({ [MONDAY]: 9_000, [TUESDAY]: 400 }, { [MONDAY]: { T1: 9_000 }, [TUESDAY]: { T1: 400 } });

    const spend = classSpendSince([state], Date.parse(`${TUESDAY}T00:00:00Z`), NOW, classOfTask);

    assert.equal(spend.byClass.get('Roadmap'), 400);
    assert.equal(spend.noTaskW, 0);
  });

  it("counts an open turn's held W by the tasks it named", () => {
    const state = usage({ [WEDNESDAY]: 1_000 }, {}, {}, [{ tasks: ['T1', 'T2'], held: { [WEDNESDAY]: 800 } }]);

    const spend = classSpendSince([state], TODAY_START, NOW, classOfTask);

    assert.deepEqual(Object.fromEntries(spend.byClass), { Roadmap: 400, Improvements: 400 });
    assert.equal(spend.noTaskW, 200);
  });

  it('counts a task with no class as no task', () => {
    const state = usage({ [WEDNESDAY]: 300 }, { [WEDNESDAY]: { T99: 300 } });

    const spend = classSpendSince([state], TODAY_START, NOW, classOfTask);

    assert.equal(spend.byClass.size, 0);
    assert.equal(spend.noTaskW, 300);
  });

  it('never reads no task below 0', () => {
    const state = usage({ [WEDNESDAY]: 100 }, { [WEDNESDAY]: { T1: 300 } });

    assert.equal(classSpendSince([state], TODAY_START, NOW, classOfTask).noTaskW, 0);
  });
});

describe('classRowsOf', () => {
  const STATE = usage({ [TUESDAY]: 1_000, [WEDNESDAY]: 500 }, { [TUESDAY]: { T1: 400 }, [WEDNESDAY]: { T1: 100, T2: 50, T3: 200, T4: 25 } }, { [`${TUESDAY}T12`]: 1_000 });
  const INPUT: ClassRowsInput = {
    states: [STATE],
    tasks: [
      { id: 'T1', workClass: 'Roadmap' },
      { id: 'T2', workClass: null },
      { id: 'T3', workClass: 'Maintenance' },
    ],
    focus: FOCUS,
    todayFrom: TODAY_START,
    weekFrom: WEEK_START,
    now: NOW,
  };

  it('lists the classes in config order with their allocation, an unclassed task under the default class, and no task last', () => {
    assert.deepEqual(classRowsOf(INPUT), [
      { name: 'Roadmap', todayW: 100, weekW: 500, allocationPct: 60 },
      { name: 'Maintenance', todayW: 200, weekW: 200, allocationPct: 25 },
      { name: 'Improvements', todayW: 50, weekW: 50, allocationPct: 15 },
      { name: NO_TASK_ROW, todayW: 150, weekW: 750, allocationPct: undefined },
    ]);
  });

  it('adds up to the W of each span', () => {
    const rows = classRowsOf(INPUT);

    assert.equal(rows.reduce((total, row) => total + row.todayW, 0), wSince([STATE], TODAY_START, NOW));
    assert.equal(rows.reduce((total, row) => total + (row.weekW ?? 0), 0), wSince([STATE], WEEK_START, NOW));
  });

  it('shows a class that spent nothing at 0', () => {
    const rows = classRowsOf({ ...INPUT, states: [] });

    assert.deepEqual(rows.map((row) => [row.name, row.todayW, row.weekW]), [
      ['Roadmap', 0, 0],
      ['Maintenance', 0, 0],
      ['Improvements', 0, 0],
      [NO_TASK_ROW, 0, 0],
    ]);
  });

  it('leaves the week out while its start is unknown', () => {
    assert.deepEqual(classRowsOf({ ...INPUT, weekFrom: undefined }).map((row) => row.weekW), [undefined, undefined, undefined, undefined]);
  });

  it('lists a class a task still holds that the config dropped after the listed ones, with no allocation', () => {
    const tasks = [{ id: 'T1', workClass: 'Research' }];

    const rows = classRowsOf({ ...INPUT, tasks });

    assert.deepEqual(rows.map((row) => row.name), ['Roadmap', 'Maintenance', 'Improvements', 'Research', NO_TASK_ROW]);
    assert.equal(rows[3]?.allocationPct, undefined);
  });
});

describe('spentClassesOf', () => {
  /** 1% of the week is 10 W, so Improvements' 15% is 150 W. */
  const INPUT: SpentClassesInput = { states: [], tasks: [{ id: 'T2', workClass: 'Improvements' }], focus: FOCUS, weekFrom: TODAY_START, wPerPct: 10, now: NOW };

  /** The classes spent when one session put `w` on T2 today. */
  function spentAt(w: number, input: Partial<SpentClassesInput> = {}): string[] {
    return [...spentClassesOf({ ...INPUT, states: [usage({ [WEDNESDAY]: w }, { [WEDNESDAY]: { T2: w } })], ...input })];
  }

  it('names a class once its week spend reaches its share, not before', () => {
    assert.deepEqual(spentAt(149), []);
    assert.deepEqual(spentAt(150), ['Improvements']);
  });

  it('adds the sessions up', () => {
    const states = [usage({ [WEDNESDAY]: 100 }, { [WEDNESDAY]: { T2: 100 } }), usage({ [WEDNESDAY]: 50 }, { [WEDNESDAY]: { T2: 50 } })];
    assert.deepEqual([...spentClassesOf({ ...INPUT, states })], ['Improvements']);
  });

  it("reads a share against the whole week, so a class with all of the week's spend so far keeps what it has left", () => {
    assert.deepEqual(spentAt(100, { wPerPct: 1_000 }), []);
  });

  it("counts no W from before the week's start", () => {
    const state = usage({ [TUESDAY]: 900, [WEDNESDAY]: 10 }, { [TUESDAY]: { T2: 900 }, [WEDNESDAY]: { T2: 10 } });
    assert.deepEqual([...spentClassesOf({ ...INPUT, states: [state] })], []);
  });

  it('counts a task with no class under the default class', () => {
    assert.deepEqual(spentAt(150, { tasks: [{ id: 'T2', workClass: null }] }), ['Improvements']);
  });

  it('never names a class the allocation does not list', () => {
    assert.deepEqual(spentAt(9_000, { tasks: [{ id: 'T2', workClass: 'Research' }] }), []);
  });

  it('names a class with a share of 0 before it spends anything', () => {
    const focus = { ...FOCUS, allocation: { Roadmap: 100, Improvements: 0 } };
    assert.deepEqual([...spentClassesOf({ ...INPUT, focus })], ['Improvements']);
  });
});
