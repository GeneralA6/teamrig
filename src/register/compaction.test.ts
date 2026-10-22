import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { toJsonlLine } from '../core/jsonl.ts';
import { MS_PER_DAY } from '../core/time.ts';
import { MemoryFiles } from '../testing/memory-files.ts';
import { rotateRegister } from '../testing/rotation.ts';
import { testTask } from '../testing/task.ts';
import { currentWeekOf } from './check.ts';
import { compactRegister, isRetirable, RETAIN_DAYS } from './compaction.ts';
import { EVENT_VERSION } from './events.ts';
import { layoutPaths, readHistory, readSnapshotText, readWorkingSet } from './layout.ts';
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
 * written from a point on, which a compaction there keeps.
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
    const task = { title: `Task ${id}`, owner: pick(['alpha', 'bravo']), source: 'lead', ref: null, priority: pick([1, 2, 3]), due: null, goals: [], week: pick(WEEKS) };
    if (roll < 0.3) {
      lines.push(toJsonlLine({ v: EVENT_VERSION, type: 'create', id, at, by: 'lead', task }));
    } else if (roll < 0.65) {
      lines.push(toJsonlLine({ v: EVENT_VERSION, type: 'status', id, at, by: pick(['alpha', 'bravo']), status: pick(TASK_STATUSES), note: 'n', evidence: pick([null, 'e']), skill: null }));
    } else if (roll < 0.9) {
      const changes = pick([{ week: pick(WEEKS) }, { priority: pick([1, 2, 3]) }, { owner: pick(['alpha', 'bravo']) }]);
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
 * rotated files must equal the fold of the one file it replaced.
 */
function assertParity(working: RegisterSnapshot, history: RegisterSnapshot, whole: RegisterSnapshot, now: Date): void {
  assert.deepEqual(history.state, whole.state, 'history state');
  assert.deepEqual(history.read.events, whole.read.events, 'history events');
  assert.deepEqual([history.read.unreadable, history.read.newer, history.read.newestVersion], [whole.read.unreadable, whole.read.newer, whole.read.newestVersion]);
  for (const [id, task] of working.state.tasks) {
    assert.deepEqual(task, whole.state.tasks.get(id), `task ${id}`);
    const events = (snapshot: RegisterSnapshot) => snapshot.read.events.filter((event) => event.id === id);
    assert.deepEqual(events(working), events(whole), `events of ${id}`);
  }
  const retired = [...whole.state.tasks.values()].filter((task) => !working.state.tasks.has(task.id));
  assert.equal(retired.length, working.retired?.count ?? 0, 'retired count');
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
  for (const name of ['events-v0.jsonl', 'events-v1.jsonl', 'events-v2.jsonl']) {
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
    // T1, T2 and T4 are finished and older than the retention; T3 is in the current week's plan. The
    // orphan T40 stays with the kept events, so only the second create of the retired T2 is counted.
    const compaction = compactRegister(source, { covered: 4, now, zone: TimeZone.UTC, retainDays: 8, keep: new Set() });
    assert.deepEqual(compaction.retiredNow, ['T1', 'T2', 'T4']);
    assert.equal(compaction.kept, 1);
    assert.deepEqual(compaction.header, {
      covered: 4,
      events: 2,
      nextId: 'T41',
      orphans: 1,
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
    assert.deepEqual(read.read.events.map((event) => event.id), ['T40', 'T3']);
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
    const created = toJsonlLine({ v: EVENT_VERSION, type: 'create', id: 'T5', at: day(20), by: 'lead', kind: 'x', task });
    const waits = [{ kind: 'task', id: 'T3' }, { kind: 'approval', who: 'lead', since: day(21) }];
    const verifying = toJsonlLine({ v: EVENT_VERSION, type: 'status', id: 'T5', at: day(21), by: 'alpha', status: 'verifying', note: 'n', evidence: null, skill: null, proof: 'p', waits, later: { any: [1] } });
    const plain = create('T6', 22, null);
    const crlf = `${plain.slice(0, -1)}\r\n`;
    const compaction = compactRegister(readRegister(log.join('') + created + verifying + crlf), { covered: 4, now, zone: TimeZone.UTC, retainDays: 8, keep: new Set() });
    assert.ok(compaction.text.endsWith(created + verifying + plain), compaction.text);
    const read = readSnapshotText(compaction.text);
    assert.ok(read.kind === 'usable');
    assert.deepEqual(read.read.lines.slice(-3), [created, verifying, plain].map((line) => line.slice(0, -1)));
  });

  it('refuses a read that holds no line for an event it keeps', () => {
    // The first kept event is the orphan T40, the sixth of the nine events (the torn line is none).
    const lineless: RegisterSnapshot = { ...source, read: { ...source.read, lines: source.read.lines.slice(0, 1) } };
    assert.throws(() => compactRegister(lineless, { covered: 4, now, zone: TimeZone.UTC, retainDays: 8, keep: new Set() }), /^Error: event 6 of 9 has no line: the read holds 1$/);
  });
});
