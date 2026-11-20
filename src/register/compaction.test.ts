import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { toJsonlLine } from '../core/jsonl.ts';
import { MS_PER_DAY } from '../core/time.ts';
import { MemoryFiles } from '../testing/memory-files.ts';
import { rotateRegister } from '../testing/rotation.ts';
import { testTask } from '../testing/task.ts';
import { currentWeekOf } from './week.ts';
import { compactRegister, isRetirable, RETAIN_DAYS } from './compaction.ts';
import { cutOf, cutTask, holdsDescription } from './description-cut.ts';
import { EVENT_VERSION } from './events.ts';
import { assemble, layoutPaths, readHistory, readSnapshotText, readWorkingSet } from './layout.ts';
import { TASK_STATUSES } from './model.ts';
import { readEvents, readRegister, type RegisterSnapshot } from './snapshot.ts';
import { TimeZone } from '../core/zone.ts';

const LOG = 'state/events.jsonl';
const PATHS = layoutPaths(LOG);
const START = Date.parse('2030-01-07T09:00:00.000Z');
const WEEKS = ['2030-01-07', '2030-01-14', '2030-01-21', null] as const;

/** A deterministic pseudo-random sequence, so a failing split point can be replayed. */
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

/**
 * A register's log lines as many sessions write it over three weeks: creates, status changes and
 * updates (week tags, priorities, owners), events for tasks that do not exist, second creates and torn
 * lines. A task is never written to once a compaction may have retired it; `touchedAfter` gives the ids
 * written from a point on, which a compaction there keeps. Which creates give a description, and which updates
 * give or clear one, goes by the line's index and never by a draw, so a seed's sequence stays what it was.
 */
function workload(seed: number, count: number): string[] {
  const next = random(seed);
  const pick = <T>(items: readonly T[]): T => {
    const item = items[Math.floor(next() * items.length)];
    assert.ok(item !== undefined);
    return item;
  };
  const lines: string[] = [];
  let tasks = 0;
  for (let index = 0; index < count; index += 1) {
    const at = new Date(START + index * 4 * 3_600_000).toISOString();
    const roll = next();
    const id = tasks === 0 || roll < 0.3 ? `T${(tasks += 1)}` : `T${1 + Math.floor(next() * tasks)}`;
    const fields = { title: `Task ${id}`, owner: pick(['alpha', 'bravo']), source: 'lead', ref: null, priority: pick([1, 2, 3]), due: null, goals: [], week: pick(WEEKS) };
    const task = index % 3 === 0 ? { ...fields, description: `Why ${id} is here, as line ${index} says` } : fields;
    if (roll < 0.3) {
      lines.push(toJsonlLine({ v: EVENT_VERSION, type: 'create', id, at, by: 'lead', task }));
    } else if (roll < 0.65) {
      lines.push(toJsonlLine({ v: EVENT_VERSION, type: 'status', id, at, by: pick(['alpha', 'bravo']), status: pick(TASK_STATUSES), note: 'n', evidence: pick([null, 'e']), skill: null }));
    } else if (roll < 0.9) {
      const drawn = pick([{ week: pick(WEEKS) }, { priority: pick([1, 2, 3]) }, { owner: pick(['alpha', 'bravo']) }]);
      const changes = index % 4 === 0 ? { ...drawn, description: index % 8 === 0 ? null : `Line ${index} says it otherwise` } : drawn;
      lines.push(toJsonlLine({ v: EVENT_VERSION, type: 'update', id, at, by: 'lead', changes, note: null }));
    } else if (roll < 0.95) {
      lines.push(toJsonlLine({ v: EVENT_VERSION, type: 'status', id: `T${tasks + 50}`, at, by: 'alpha', status: 'open', note: null, evidence: null, skill: null }));
    } else if (roll < 0.98) {
      lines.push(toJsonlLine({ v: EVENT_VERSION, type: 'create', id, at, by: 'lead', task }));
    } else {
      lines.push('{"v":2,"type":"status","id":"T7","at":\n');
    }
  }
  return lines;
}

/** The ids written on or after line `from`: a compaction at that point must keep them, as a revive would. */
function touchedAfter(lines: readonly string[], from: number): Set<string> {
  return new Set(readEvents(lines.slice(from).join('')).events.map((event) => event.id));
}

/** When the line before `at` was written: the time a compaction at that split runs. */
function timeAt(lines: readonly string[], at: number): Date {
  const last = readEvents(lines.slice(0, at).join('')).events.at(-1);
  return new Date(last === undefined ? START : Date.parse(last.at) + MS_PER_DAY);
}

/**
 * The working set must read exactly as the whole history does on every task it holds and on every count a
 * reader shows; the tasks it leaves out are the retired ones, all finished. The history read of the
 * rotated files must equal the fold of the one file it replaced. A description is the one field a task line
 * leaves out (T4781): the working set holds it whole or as the mark of the very text the history holds.
 */
function assertParity(working: RegisterSnapshot, history: RegisterSnapshot, whole: RegisterSnapshot, now: Date): void {
  assert.deepEqual(history.state, whole.state, 'history state');
  assert.deepEqual(history.read.events, whole.read.events, 'history events');
  assert.deepEqual([history.read.unreadable, history.read.newer, history.read.newestVersion], [whole.read.unreadable, whole.read.newer, whole.read.newestVersion]);
  const windowFrom = working.window === null ? null : Date.parse(working.window.from);
  for (const [id, task] of working.state.tasks) {
    const told = whole.state.tasks.get(id);
    assert.ok(told !== undefined, `task ${id} is in the history`);
    assert.deepEqual(cutTask(task), cutTask(told), `task ${id}`);
    assert.ok(holdsDescription(task, told.description), `description of ${id}`);
    const all = whole.read.events.filter((event) => event.id === id);
    const mine = working.read.events.filter((event) => event.id === id);
    // A snapshot of task lines keeps only a task's latest events: the tail of its whole history, holding at
    // least every event from its window on.
    assert.deepEqual(mine, all.slice(all.length - mine.length), `events of ${id} are the tail of its history`);
    const from = windowFrom === null ? 0 : all.findIndex((event) => Date.parse(event.at) >= windowFrom);
    assert.ok(mine.length >= (from < 0 ? 0 : all.length - from), `events of ${id} from the window on`);
  }
  const retired = [...whole.state.tasks.values()].filter((task) => !working.state.tasks.has(task.id));
  const movedAway = [...whole.state.moved.keys()].filter((id) => !working.state.moved.has(id));
  assert.equal(retired.length + movedAway.length, working.retired?.count ?? 0, 'retired count: finished tasks and those that moved to another team');
  assert.ok(retired.every((task) => task.status === 'done' || task.status === 'dropped'), 'only finished tasks retire');
  assert.deepEqual([working.state.nextId, working.state.orphans], [whole.state.nextId, whole.state.orphans]);
  assert.deepEqual([working.read.unreadable, working.read.newer, working.read.newestVersion], [whole.read.unreadable, whole.read.newer, whole.read.newestVersion]);
  assert.equal(currentWeekOf(working, now, TimeZone.UTC), currentWeekOf(whole, now, TimeZone.UTC), 'current week');
}

/** Rotates `lines` at each split point in turn, appending the lines between, and checks parity after each. */
async function rotateAt(lines: readonly string[], splits: readonly number[], retainDays: number): Promise<RegisterSnapshot> {
  const files = new MemoryFiles({ [LOG]: lines.slice(0, splits[0] ?? lines.length).join('') });
  for (const [index, split] of splits.entries()) {
    const now = timeAt(lines, split);
    await rotateRegister(files, LOG, { now, retainDays, keep: touchedAfter(lines, split) });
    await files.append(LOG, lines.slice(split, splits[index + 1] ?? lines.length).join(''));
    const upTo = splits[index + 1] ?? lines.length;
    assertParity(await readWorkingSet(files, PATHS), await readHistory(files, PATHS), readRegister(lines.slice(0, upTo).join('')), now);
  }
  return readWorkingSet(files, PATHS);
}

async function golden(name: string): Promise<string[]> {
  const text = await readFile(new URL(`./testdata/${name}`, import.meta.url), 'utf8');
  return text.split(/(?<=\n)/);
}

describe('compaction parity: the working set reads as the whole history', () => {
  for (const name of ['events-v0.jsonl', 'events-v1.jsonl', 'events-v2.jsonl', 'events-v3.jsonl']) {
    it(`on the golden log ${name}, at every split point`, async () => {
      const lines = await golden(name);
      for (let split = 0; split <= lines.length; split += 1) {
        await rotateAt(lines, [split], 0);
      }
    });
  }

  it('on a generated log, at every split point, keeping and retiring', async () => {
    const lines = workload(7, 120);
    for (let split = 0; split <= lines.length; split += 1) {
      for (const retainDays of [0, 2, RETAIN_DAYS]) {
        await rotateAt(lines, [split], retainDays);
      }
    }
  });

  it('through repeated compactions, each going on from the last snapshot', async () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const lines = workload(seed, 150);
      const last = await rotateAt(lines, [20, 45, 46, 90, 130, 150], 1);
      assert.ok((last.retired?.count ?? 0) > 0, `seed ${seed} retires some tasks`);
    }
  });
});

describe('isRetirable', () => {
  const now = Date.parse('2030-02-01T00:00:00.000Z');
  const old = '2030-01-20T00:00:00.000Z';

  it('retires a task finished at least the retention ago and planned before the current week', () => {
    assert.ok(isRetirable(testTask({ status: 'done', updatedAt: old, week: null }), now, 8 * MS_PER_DAY, '2030-01-27'));
    assert.ok(isRetirable(testTask({ status: 'dropped', updatedAt: old, week: '2030-01-20' }), now, 8 * MS_PER_DAY, '2030-01-27'));
    assert.ok(isRetirable(testTask({ status: 'done', updatedAt: '2030-01-24T00:00:00.000Z' }), now, 8 * MS_PER_DAY, null), 'exactly the retention');
  });

  it('keeps an active task, a recent one, and one in the current week plan or a later one', () => {
    for (const status of ['open', 'in-progress', 'verifying', 'waiting'] as const) {
      assert.equal(isRetirable(testTask({ status, updatedAt: old }), now, 8 * MS_PER_DAY, null), false, status);
    }
    assert.equal(isRetirable(testTask({ status: 'done', updatedAt: '2030-01-30T00:00:00.000Z' }), now, 8 * MS_PER_DAY, null), false);
    assert.equal(isRetirable(testTask({ status: 'done', updatedAt: old, week: '2030-01-27' }), now, 8 * MS_PER_DAY, '2030-01-27'), false);
    assert.equal(isRetirable(testTask({ status: 'done', updatedAt: old, week: '2030-02-03' }), now, 8 * MS_PER_DAY, '2030-01-27'), false);
    assert.equal(isRetirable(testTask({ status: 'done', updatedAt: old, week: '2030-01-20' }), now, 8 * MS_PER_DAY, null), false, 'no week in force');
    assert.equal(isRetirable(testTask({ status: 'done', updatedAt: old, watch: 'the row shows' }), now, 8 * MS_PER_DAY, null), false, 'still watched (T1306)');
  });
});

describe('compactRegister', () => {
  const day = (n: number): string => `2030-01-${String(n).padStart(2, '0')}T09:00:00.000Z`;
  const create = (id: string, n: number, week: string | null): string =>
    toJsonlLine({ v: EVENT_VERSION, type: 'create', id, at: day(n), by: 'lead', task: { title: id, owner: 'alpha', source: 'lead', ref: null, priority: 2, due: null, goals: [], week } });
  const done = (id: string, n: number): string =>
    toJsonlLine({ v: EVENT_VERSION, type: 'status', id, at: day(n), by: 'alpha', status: 'done', note: 'n', evidence: 'e', skill: 'none' });
  const orphan = toJsonlLine({ v: EVENT_VERSION, type: 'status', id: 'T40', at: day(3), by: 'alpha', status: 'open', note: null, evidence: null, skill: null });
  const log = [create('T1', 1, '2030-01-07'), done('T1', 2), create('T2', 2, null), done('T2', 3), create('T2', 3, null), orphan, '{torn\n', create('T3', 14, '2030-01-14'), create('T4', 15, null), done('T4', 15)];
  const source = readRegister(log.join(''));
  const now = new Date(day(28));

  it('keeps the active, the recent and the current week, and carries the counts in its header', () => {
    // T1, T2 and T4 are finished and older than the retention; T3 is in the current week's plan. No event is
    // within the window's two days, so T3 is kept as its task line alone, and the orphan T40 is counted with
    // the second create of the retired T2.
    const compaction = compactRegister(source, { covered: 4, now, zone: TimeZone.UTC, retainDays: 8, keep: new Set() });
    assert.deepEqual(compaction.retiredNow, ['T1', 'T2', 'T4']);
    assert.equal(compaction.kept, 1);
    assert.deepEqual(compaction.header, {
      covered: 4,
      events: 0,
      tasks: 1,
      windowFrom: day(26),
      nextId: 'T41',
      orphans: 2,
      unreadable: 1,
      newer: 0,
      newestVersion: EVENT_VERSION,
      retired: 3,
      retiredLastWeek: '2030-01-07',
      at: now.toISOString(),
    });
    const read = readSnapshotText(compaction.text);
    assert.ok(read.kind === 'usable');
    assert.deepEqual(read.header, compaction.header);
    assert.deepEqual(read.read.events.map((event) => event.id), []);
    assert.deepEqual([...read.tasks.keys()], ['T3']);
    assert.deepEqual(read.tasks.get('T3'), source.state.tasks.get('T3'));
  });

  it('keeps the ids it is asked to keep, and adds to the tasks retired before', () => {
    const compaction = compactRegister(source, { covered: 1, now, zone: TimeZone.UTC, retainDays: 8, keep: new Set(['T2']) });
    assert.deepEqual(compaction.retiredNow, ['T1', 'T4']);
    const previous: RegisterSnapshot = { ...source, retired: { count: 5, lastWeek: '2029-12-31' } };
    const again = compactRegister(previous, { covered: 2, now, zone: TimeZone.UTC, retainDays: 8, keep: new Set() });
    assert.deepEqual([again.header.retired, again.header.retiredLastWeek], [8, '2030-01-07']);
    const none = compactRegister(readRegister(''), { covered: 1, now, zone: TimeZone.UTC, retainDays: 8, keep: new Set() });
    assert.deepEqual([none.header.retired, none.header.retiredLastWeek, none.kept], [0, null, 0]);
  });

  it('copies each kept line as written, so a field this code does not parse is kept', () => {
    const task = { title: 'T5', owner: 'alpha', source: 'lead', ref: null, priority: 2, due: null, goals: [], week: null, colour: 'blue' };
    const created = toJsonlLine({ v: EVENT_VERSION, type: 'create', id: 'T5', at: day(26), by: 'lead', kind: 'x', task });
    const waits = [{ kind: 'task', id: 'T3' }, { kind: 'approval', who: 'lead', since: day(27) }];
    const verifying = toJsonlLine({ v: EVENT_VERSION, type: 'status', id: 'T5', at: day(27), by: 'alpha', status: 'verifying', note: 'n', evidence: null, skill: null, proof: 'p', waits, later: { any: [1] } });
    const plain = create('T6', 27, null);
    const crlf = `${plain.slice(0, -1)}\r\n`;
    const compaction = compactRegister(readRegister(log.join('') + created + verifying + crlf), { covered: 4, now, zone: TimeZone.UTC, retainDays: 8, keep: new Set() });
    assert.ok(compaction.text.endsWith(created + verifying + plain), compaction.text);
    const read = readSnapshotText(compaction.text);
    assert.ok(read.kind === 'usable');
    assert.deepEqual(read.read.lines.slice(-3), [created, verifying, plain].map((line) => line.slice(0, -1)));
  });

  it('refuses a read that holds no line for an event it keeps', () => {
    // On day 16 the window starts on day 14, so the first kept event is T3's create, the seventh of the nine
    // events (the torn line is none).
    const lineless: RegisterSnapshot = { ...source, read: { ...source.read, lines: source.read.lines.slice(0, 1) } };
    const early = new Date(day(16));
    assert.throws(() => compactRegister(lineless, { covered: 4, now: early, zone: TimeZone.UTC, retainDays: 8, keep: new Set() }), /^Error: event 7 of 9 has no line: the read holds 1$/);
  });

  it('retires a task that moved to another team at once, with its moved line and any later line on it (T1144)', () => {
    // T5 moved a day ago, so no retention keeps it; the status line after its move is an orphan left out with it.
    const movedLine = toJsonlLine({ v: EVENT_VERSION, type: 'moved', id: 'T5', at: day(27), by: 'lead', to: 'web' });
    const later = toJsonlLine({ v: EVENT_VERSION, type: 'status', id: 'T5', at: day(27), by: 'alpha', status: 'done', note: 'n', evidence: 'e', skill: 'none' });
    const compaction = compactRegister(readRegister(log.join('') + create('T5', 26, null) + movedLine + later), { covered: 4, now, zone: TimeZone.UTC, retainDays: 8, keep: new Set() });
    assert.deepEqual(compaction.retiredNow, ['T1', 'T2', 'T4', 'T5']);
    assert.deepEqual([compaction.kept, compaction.header.retired, compaction.header.events, compaction.header.orphans], [1, 4, 0, 3]);
    const read = readSnapshotText(compaction.text);
    assert.ok(read.kind === 'usable');
    assert.deepEqual(read.read.events.map((event) => event.id), []);
  });

  it('writes each task line as the task stood when the window starts, and keeps the events after (T4076)', () => {
    const update = (n: number, priority: number): string => toJsonlLine({ v: EVENT_VERSION, type: 'update', id: 'T3', at: day(n), by: 'lead', changes: { priority }, note: null });
    const recent = readRegister(create('T3', 14, null) + update(20, 1) + update(27, 3));
    const compaction = compactRegister(recent, { covered: 1, now, zone: TimeZone.UTC, retainDays: 8, keep: new Set() });
    assert.deepEqual([compaction.header.tasks, compaction.header.events, compaction.header.windowFrom], [1, 1, day(26)]);
    const read = readSnapshotText(compaction.text);
    assert.ok(read.kind === 'usable');
    assert.equal(read.tasks.get('T3')?.priority, 1, 'the task line stands before the day-27 update');
    assert.deepEqual(read.read.lines, [update(27, 3).slice(0, -1)]);
    const assembled = assemble({ base: read, segments: [], skipped: undefined }, [], readEvents(''));
    assert.deepEqual(assembled.state.tasks, recent.state.tasks, 'read back, it folds as the whole log does');
    assert.deepEqual(assembled.window, { from: day(26), tasks: read.tasks });
  });

  const described = (id: string, n: number, description: string): string =>
    toJsonlLine({ v: EVENT_VERSION, type: 'create', id, at: day(n), by: 'lead', task: { title: id, description, owner: 'alpha', source: 'lead', ref: null, priority: 2, due: null, goals: [], week: null } });

  it('leaves a description out of its task line, which holds its mark, and keeps an event of the window as written (T4781)', () => {
    const edit = toJsonlLine({ v: EVENT_VERSION, type: 'update', id: 'T4', at: day(27), by: 'lead', changes: { description: 'said again' }, note: null });
    const whole = readRegister(described('T3', 14, 'what and why') + described('T4', 14, 'said at first') + create('T5', 14, null) + edit);
    const compaction = compactRegister(whole, { covered: 1, now, zone: TimeZone.UTC, retainDays: 8, keep: new Set() });
    assert.deepEqual([compaction.header.tasks, compaction.header.events], [3, 1]);
    assert.deepEqual([compaction.text.includes('what and why'), compaction.text.includes('said at first'), compaction.text.endsWith(edit)], [false, false, true]);
    const read = readSnapshotText(compaction.text);
    assert.ok(read.kind === 'usable');
    const marks = ['T3', 'T4', 'T5'].map((id) => [read.tasks.get(id)?.description, read.tasks.get(id)?.descriptionCut]);
    assert.deepEqual(marks, [[null, cutOf('what and why')], [null, cutOf('said at first')], [null, null]]);
    const { tasks } = assemble({ base: read, segments: [], skipped: undefined }, [], readEvents('')).state;
    const source = whole.state.tasks.get('T3');
    assert.ok(source !== undefined);
    assert.deepEqual(tasks.get('T3'), cutTask(source), 'a task no event of the window describes stays cut');
    assert.deepEqual(tasks.get('T4'), whole.state.tasks.get('T4'), 'the update in the window gives its text whole');
    assert.deepEqual(tasks.get('T5'), whole.state.tasks.get('T5'), 'a task with no description is as it was');
  });

  it('writes a snapshot whose size follows the tasks it keeps, not their descriptions (T4781)', () => {
    // The register this is for holds imported issue bodies of thousands of characters on most tasks; 200 such
    // tasks are 400,000 characters of description here, and 1,800,000 in the second register.
    const sized = (chars: number): number => {
      const lines = Array.from({ length: 200 }, (_, index) => described(`T${index + 1}`, 14, String(index % 10).repeat(chars)));
      return Buffer.byteLength(compactRegister(readRegister(lines.join('')), { covered: 1, now, zone: TimeZone.UTC, retainDays: 8, keep: new Set() }).text);
    };
    assert.equal(sized(2_000), sized(9_000), 'longer descriptions add no byte');
    assert.ok(sized(2_000) < 200 * 1_024, `${sized(2_000)} bytes for 200 task lines`);
  });

  it('never moves the window back past where the source read starts', () => {
    // A working set whose window starts on day 27 holds no event from before it, so a compaction a day later
    // keeps that start rather than reaching back two days.
    const update = toJsonlLine({ v: EVENT_VERSION, type: 'update', id: 'T3', at: day(27), by: 'lead', changes: { priority: 1 }, note: null });
    const window = { from: day(27), tasks: readRegister(create('T3', 14, null)).state.tasks };
    const working: RegisterSnapshot = { ...readRegister(update), state: readRegister(create('T3', 14, null) + update).state, window };
    const compaction = compactRegister(working, { covered: 2, now, zone: TimeZone.UTC, retainDays: 8, keep: new Set() });
    assert.deepEqual([compaction.header.windowFrom, compaction.header.tasks, compaction.header.events], [day(27), 1, 1]);
    const read = readSnapshotText(compaction.text);
    assert.ok(read.kind === 'usable');
    assert.equal(read.tasks.get('T3')?.priority, 2, 'the task line stands at day 27, before the update');
  });
});
