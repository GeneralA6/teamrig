import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { toJsonlLine } from '../core/jsonl.ts';
import { MemoryFiles } from '../testing/memory-files.ts';
import { rotateRegister } from '../testing/rotation.ts';
import { EVENT_VERSION } from './events.ts';
import {
  assemble,
  historyPlan,
  layoutPaths,
  MissingSegmentError,
  readHistory,
  readSnapshotText,
  readWorkingSet,
  segmentName,
  snapshotHeaderRecord,
  workingSetPlan,
  type SnapshotHeader,
  type SnapshotRead,
} from './layout.ts';
import { LAYOUT_VERSION, markerRecord } from './marker.ts';
import { readEvents, readRegister } from './snapshot.ts';

const LOG = 'team/state/events.jsonl';
const PATHS = layoutPaths(LOG);
const at = (day: number, hour = 9): string => `2030-01-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00.000Z`;

function create(id: string, day: number): string {
  const task = { title: `Task ${id}`, owner: 'alpha', source: 'lead', ref: null, priority: 2, due: null, goals: [], week: null };
  return toJsonlLine({ v: EVENT_VERSION, type: 'create', id, at: at(day), by: 'lead', task });
}

function status(id: string, day: number, value: string): string {
  return toJsonlLine({ v: EVENT_VERSION, type: 'status', id, at: at(day, 10), by: 'alpha', status: value, note: 'n', evidence: 'e', skill: 'none' });
}

const HEADER: SnapshotHeader = {
  covered: 1,
  events: 1,
  nextId: 'T3',
  orphans: 1,
  unreadable: 2,
  newer: 0,
  newestVersion: EVENT_VERSION,
  retired: 1,
  retiredLastWeek: '2030-01-07',
  at: at(20),
};

function snapshotText(header: Readonly<Record<string, unknown>>, ...events: string[]): string {
  return [JSON.stringify({ ...snapshotHeaderRecord(HEADER), ...header }), '\n', ...events].join('');
}

function usable(read: SnapshotRead): Extract<SnapshotRead, { kind: 'usable' }> {
  assert.equal(read.kind, 'usable', read.kind === 'unusable' ? read.reason : read.kind);
  assert.ok(read.kind === 'usable');
  return read;
}

function reason(read: SnapshotRead): string {
  assert.ok(read.kind === 'unusable', read.kind);
  return read.reason;
}

describe('layoutPaths', () => {
  it('puts the snapshot and the archive beside events.jsonl, with its separator', () => {
    assert.deepEqual([PATHS.tail, PATHS.snapshot, PATHS.archive, PATHS.segment(1)], [
      LOG,
      'team/state/snapshot.jsonl',
      'team/state/archive',
      'team/state/archive/events-000001.jsonl',
    ]);
    const windows = layoutPaths('C:\\kit\\state\\events.jsonl');
    assert.deepEqual([windows.snapshot, windows.segment(2)], ['C:\\kit\\state\\snapshot.jsonl', 'C:\\kit\\state\\archive\\events-000002.jsonl']);
    const bare = layoutPaths('events.jsonl');
    assert.deepEqual([bare.snapshot, bare.segment(3)], ['snapshot.jsonl', 'archive/events-000003.jsonl']);
  });

  it('names segments so they sort in write order, and never cuts a big number', () => {
    assert.deepEqual([segmentName(12), segmentName(1234567)], ['events-000012.jsonl', 'events-1234567.jsonl']);
  });
});

describe('readSnapshotText', () => {
  it('reads no file as no snapshot, and a whole one as usable', () => {
    assert.deepEqual(readSnapshotText(undefined), { kind: 'none' });
    const read = usable(readSnapshotText(snapshotText({}, create('T2', 8))));
    assert.deepEqual(read.header, HEADER);
    assert.deepEqual(read.read.events.map((event) => event.id), ['T2']);
  });

  it('reads a header with no events and no newline', () => {
    const read = usable(readSnapshotText(JSON.stringify(snapshotHeaderRecord({ ...HEADER, events: 0 }))));
    assert.equal(read.read.events.length, 0);
  });

  it('counts events from a newer teamrig among the events the header names', () => {
    const newer = create('T2', 8).replace(`"v":${EVENT_VERSION}`, `"v":${EVENT_VERSION + 1}`);
    const read = usable(readSnapshotText(snapshotText({ events: 2 }, create('T1', 7), newer)));
    assert.deepEqual([read.read.events.length, read.read.newer], [1, 1]);
  });

  it('refuses a file that does not start with a snapshot header', () => {
    assert.match(reason(readSnapshotText('')), /no snapshot header/);
    assert.match(reason(readSnapshotText('{torn\n')), /no snapshot header/);
    assert.match(reason(readSnapshotText(create('T1', 7))), /no snapshot header/);
  });

  it('refuses a header from a newer teamrig, naming its version', () => {
    const read = readSnapshotText(snapshotText({ v: LAYOUT_VERSION + 1 }));
    assert.deepEqual(read, { kind: 'unusable', reason: `a newer teamrig wrote it (layout v${LAYOUT_VERSION + 1})`, newerVersion: LAYOUT_VERSION + 1 });
    assert.match(reason(readSnapshotText(snapshotText({ v: 2 }))), /layout v2 is no snapshot layout/);
  });

  it('refuses a header with a field it cannot trust', () => {
    assert.match(reason(readSnapshotText(snapshotText({ covered: -1 }))), /covered is not a count/);
    assert.match(reason(readSnapshotText(snapshotText({ retired: '1' }))), /retired is not a count/);
    assert.match(reason(readSnapshotText(snapshotText({ nextId: 'X1' }))), /nextId "X1" is not a task id/);
    assert.match(reason(readSnapshotText(snapshotText({ retiredLastWeek: 'last week' }))), /retiredLastWeek "last week" is not a week/);
    assert.match(reason(readSnapshotText(snapshotText({ retiredLastWeek: 7 }))), /retiredLastWeek 7 is not a week/);
    assert.match(reason(readSnapshotText(snapshotText({ at: 'soon' }))), /at "soon" is not a time/);
    assert.match(reason(readSnapshotText(snapshotText({ at: 5 }))), /at 5 is not a time/);
    assert.equal(usable(readSnapshotText(snapshotText({ retiredLastWeek: null }, create('T2', 8)))).header.retiredLastWeek, null);
  });

  it('refuses a damaged event line, and a file cut short or grown past its header', () => {
    assert.match(reason(readSnapshotText(snapshotText({}, '{torn\n'))), /1 damaged line/);
    assert.match(reason(readSnapshotText(snapshotText({ events: 2 }, create('T2', 8)))), /holds 1 event\(s\) where its header says 2/);
    assert.match(reason(readSnapshotText(snapshotText({}, create('T1', 7), create('T2', 8)))), /holds 2 event/);
  });
});

describe('workingSetPlan', () => {
  const tail = (after: number): ReturnType<typeof readEvents> => readEvents(toJsonlLine(markerRecord(after, at(20))));
  const snapshot = usable(readSnapshotText(snapshotText({ covered: 2 }, create('T2', 8))));

  it('folds the whole history when there is no snapshot, or one it cannot use', () => {
    assert.deepEqual(workingSetPlan({ kind: 'none' }, tail(2)), historyPlan(tail(2)));
    assert.deepEqual(historyPlan(tail(2)).segments, [1, 2]);
    const damaged: SnapshotRead = { kind: 'unusable', reason: 'torn', newerVersion: 0 };
    assert.deepEqual(workingSetPlan(damaged, tail(2)), { base: undefined, segments: [1, 2], skipped: damaged });
  });

  it('starts from the snapshot and folds only the segments after it', () => {
    const plan = workingSetPlan(snapshot, tail(4));
    assert.deepEqual([plan.base?.header.covered, plan.segments, plan.skipped], [2, [3, 4], undefined]);
    assert.deepEqual(workingSetPlan(snapshot, tail(2)).segments, []);
  });

  it('skips a snapshot that covers more than the log goes on from, as one restored from a backup would', () => {
    const plan = workingSetPlan(snapshot, tail(1));
    assert.deepEqual([plan.base, plan.segments], [undefined, [1]]);
    assert.match(plan.skipped?.reason ?? '', /covers segment 2, past the segment 1/);
  });
});

describe('assemble', () => {
  it('refuses segments that do not match the plan', () => {
    assert.throws(() => assemble(historyPlan(readEvents(toJsonlLine(markerRecord(1, at(20))))), [], readEvents('')), /names 1 segment\(s\) and 0 were read/);
  });

  it('counts a skipped snapshot with the damaged lines, or with the newer ones when a newer teamrig wrote it', () => {
    const tail = readEvents(create('T1', 7));
    const damaged = assemble({ base: undefined, segments: [], skipped: { kind: 'unusable', reason: 'torn', newerVersion: 0 } }, [], tail);
    assert.deepEqual([damaged.read.unreadable, damaged.read.newer, damaged.read.newestVersion], [1, 0, EVENT_VERSION]);
    const newer = assemble({ base: undefined, segments: [], skipped: { kind: 'unusable', reason: 'newer', newerVersion: 9 } }, [], tail);
    assert.deepEqual([newer.read.unreadable, newer.read.newer, newer.read.newestVersion], [0, 1, 9]);
  });

  it("goes on from the header's counts and next id, and names the retired tasks", () => {
    const base = usable(readSnapshotText(snapshotText({}, create('T2', 8))));
    const snapshot = assemble({ base, segments: [], skipped: undefined }, [], readEvents(status('T2', 9, 'done')));
    assert.deepEqual([...snapshot.state.tasks.keys()], ['T2']);
    assert.deepEqual([snapshot.state.nextId, snapshot.state.orphans, snapshot.read.unreadable], ['T3', 1, 2]);
    assert.deepEqual(snapshot.retired, { count: 1, lastWeek: '2030-01-07' });
    const none = usable(readSnapshotText(snapshotText({ retired: 0, retiredLastWeek: null }, create('T2', 8))));
    assert.equal(assemble({ base: none, segments: [], skipped: undefined }, [], readEvents('')).retired, null);
  });
});

describe('readWorkingSet and readHistory', () => {
  const lines = [create('T1', 1), status('T1', 1, 'done'), create('T2', 2), create('T3', 3), status('T3', 3, 'dropped'), create('T4', 4)];

  async function rotated(): Promise<MemoryFiles> {
    const files = new MemoryFiles({ [LOG]: lines.slice(0, 3).join('') });
    await rotateRegister(files, LOG, { now: new Date(at(20)) });
    await files.append(LOG, lines.slice(3, 5).join(''));
    await rotateRegister(files, LOG, { now: new Date(at(25)) });
    await files.append(LOG, lines.slice(5).join(''));
    return files;
  }

  it('reads a register that was never rotated from its one file, both ways', async () => {
    const files = new MemoryFiles({ [LOG]: lines.join('') });
    const whole = readRegister(lines.join(''));
    for (const read of [await readWorkingSet(files, PATHS), await readHistory(files, PATHS)]) {
      assert.deepEqual([read.state, read.read.events, read.retired], [whole.state, whole.read.events, null]);
    }
    assert.equal((await readWorkingSet(new MemoryFiles(), PATHS)).state.nextId, 'T1');
  });

  it('reads the working set without the retired tasks, and the history with all of them', async () => {
    const files = await rotated();
    const whole = readRegister(lines.join(''));
    const working = await readWorkingSet(files, PATHS);
    assert.deepEqual([...working.state.tasks.keys()], ['T2', 'T4']);
    assert.deepEqual(working.retired, { count: 2, lastWeek: null });
    assert.equal(working.state.nextId, 'T5');
    const history = await readHistory(files, PATHS);
    assert.deepEqual([history.state, history.read.events, history.retired], [whole.state, whole.read.events, null]);
  });

  it('reads the same register at every step a rotation can stop at', async () => {
    const files = new MemoryFiles({ [LOG]: lines.slice(0, 4).join('') });
    const whole = readRegister(lines.slice(0, 4).join(''));
    const tail = files.get(LOG) ?? '';
    // Stopped after linking the tail into the archive: the tail still names no segment.
    await files.write(PATHS.segment(1), tail);
    assert.deepEqual((await readWorkingSet(files, PATHS)).state, whole.state);
    // Stopped after starting the new tail, before the snapshot: the segment is folded whole.
    await files.write(LOG, toJsonlLine(markerRecord(1, at(20))));
    assert.deepEqual((await readWorkingSet(files, PATHS)).state, whole.state);
    // Stopped halfway through a snapshot written in place: it is skipped and counted.
    await files.write(PATHS.snapshot, snapshotText({ covered: 1, events: 5 }, create('T2', 2)));
    const torn = await readWorkingSet(files, PATHS);
    assert.deepEqual([torn.state, torn.read.unreadable], [whole.state, 1]);
  });

  it('reads the working set without the segments its snapshot covers, and refuses a history with one missing', async () => {
    const files = await rotated();
    await files.remove(PATHS.segment(1));
    assert.deepEqual([...(await readWorkingSet(files, PATHS)).state.tasks.keys()], ['T2', 'T4']);
    await assert.rejects(readHistory(files, PATHS), (error) => error instanceof MissingSegmentError && error.path === PATHS.segment(1));
    await files.remove(PATHS.snapshot);
    await assert.rejects(readWorkingSet(files, PATHS), /events-000001\.jsonl is missing: the register's archive is incomplete/);
  });
});
