import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { toJsonlLine } from '../core/jsonl.ts';
import { MS_PER_DAY } from '../core/time.ts';
import { TEST_CARD } from '../testing/card.ts';
import { TimeZone } from '../core/zone.ts';
import { testConfig } from '../testing/config.ts';
import { FakeClock } from '../testing/fake-clock.ts';
import { FaultyFiles, systemError, type FileOperation } from '../testing/faulty-files.ts';
import { InlineMutex } from '../testing/inline-mutex.ts';
import { MemoryFiles } from '../testing/memory-files.ts';
import { compactRegister, RETAIN_DAYS } from './compaction.ts';
import { EVENT_VERSION } from './events.ts';
import { layoutPaths, readHistory, readSnapshotText, readWorkingSet, snapshotHeaderRecord } from './layout.ts';
import { markerRecord } from './marker.ts';
import { OWN_NUMBERS } from './numbering.ts';
import { RegisterPolicy } from './policy.ts';
import { NO_GOAL_RECORDS, NOTHING_ELSEWHERE, Register, type SkillCatalog } from './register.ts';
import { applyRotation, AUTO_ROTATE_CHARS, planRotation, readBack, RotationRefusedError, type RotationOptions, type RotationPlan } from './rotate.ts';
import { readEvents, readRegister } from './snapshot.ts';
import { rotateRegister } from '../testing/rotation.ts';
import { JsonlEventLog } from './store.ts';

const LOG = 'state/events.jsonl';
const PATHS = layoutPaths(LOG);
const START = Date.parse('2030-01-07T09:00:00.000Z');

const at = (day: number): string => new Date(START + day * MS_PER_DAY).toISOString();

function create(id: string, day: number): string {
  const task = { title: `Task ${id}`, owner: 'alpha', source: 'lead', ref: null, priority: 2, due: null, goals: [], week: null };
  return toJsonlLine({ v: EVENT_VERSION, type: 'create', id, at: at(day), by: 'lead', task });
}

function status(id: string, day: number, to: string): string {
  return toJsonlLine({ v: EVENT_VERSION, type: 'status', id, at: at(day), by: 'alpha', status: to, note: 'n', evidence: to === 'done' ? 'e' : null, skill: null });
}

/** T1 done on day 1, T2 in progress since day 3. */
const TEXT = create('T1', 0) + status('T1', 1, 'done') + create('T2', 2) + status('T2', 3, 'in-progress');
/** What comes after a rotation on day 4: T2 done and T3 opened on day 5. */
const LATER = status('T2', 5, 'done') + create('T3', 5);

function options(day: number, changes: Partial<RotationOptions> = {}): RotationOptions {
  return { now: new Date(START + day * MS_PER_DAY), zone: TimeZone.UTC, retainDays: RETAIN_DAYS, keep: new Set(), checkHistory: true, fromHistory: false, ...changes };
}

async function rotate(files: MemoryFiles, day: number): Promise<RotationPlan> {
  const plan = await planRotation(files, PATHS, options(day));
  await applyRotation(files, PATHS, plan);
  return plan;
}

/** Every file's text, to show a step wrote nothing. */
function contents(files: MemoryFiles): Record<string, string | undefined> {
  return Object.fromEntries(files.paths().map((path) => [path, files.get(path)]));
}

/** The working set holds the tasks the whole log folds to, but the retired ones; the history folds to all of them. */
async function assertReadsAs(files: MemoryFiles, text: string): Promise<void> {
  const whole = readRegister(text);
  const history = await readHistory(files, PATHS);
  assert.deepEqual(history.state, whole.state, 'history');
  const working = await readWorkingSet(files, PATHS);
  for (const [id, task] of working.state.tasks) {
    assert.deepEqual(task, whole.state.tasks.get(id), `task ${id}`);
  }
  assert.equal(working.state.tasks.size + (working.retired?.count ?? 0), whole.state.tasks.size, 'kept and retired');
}

describe('planRotation and applyRotation', () => {
  it('rotate a log never rotated: the tail becomes segment 1 byte for byte, a marker starts the new tail, the snapshot folds to the same tasks', async () => {
    const files = new MemoryFiles({ [LOG]: TEXT });
    const plan = await planRotation(files, PATHS, options(4));
    assert.deepEqual(contents(files), { [LOG]: TEXT }, 'a plan writes nothing');
    assert.deepEqual(
      [plan.segment, plan.tailEvents, plan.source, plan.skippedSnapshot, plan.sourceEvents, plan.unchanged, plan.leftover, plan.history, plan.idle, plan.problems],
      [1, 4, 'history', null, 4, 2, false, { tasks: 2, events: 4 }, false, []],
    );
    await applyRotation(files, PATHS, plan);
    assert.deepEqual(contents(files), {
      [PATHS.segment(1)]: TEXT,
      [LOG]: toJsonlLine(markerRecord(1, at(4))),
      [PATHS.snapshot]: plan.compaction.text,
    });
    await assertReadsAs(files, TEXT);
  });

  it('go on from the snapshot, retire tasks finished over the retain days, and hold the working set against the history', async () => {
    const files = new MemoryFiles({ [LOG]: TEXT });
    await rotate(files, 4);
    await files.append(LOG, LATER);
    const plan = await rotate(files, 20);
    assert.deepEqual(
      [plan.segment, plan.tailEvents, plan.source, plan.sourceEvents, plan.compaction.retiredNow, plan.unchanged, plan.history, plan.problems],
      [2, 2, 'working set', 6, ['T1', 'T2'], 1, { tasks: 3, events: 6 }, []],
    );
    assert.deepEqual([...(await readWorkingSet(files, PATHS)).state.tasks.keys()], ['T3']);
    await assertReadsAs(files, TEXT + LATER);
    const unchecked = await planRotation(files, PATHS, options(20, { checkHistory: false }));
    assert.deepEqual([unchecked.history, unchecked.source, unchecked.compaction.header.retired], [null, 'working set', 2]);
  });

  it('write the files the readers\' test helper lays out, rotation after rotation', async () => {
    const written = new MemoryFiles({ [LOG]: TEXT });
    const laidOut = new MemoryFiles({ [LOG]: TEXT });
    for (const [day, more] of [[4, LATER], [20, '']] as const) {
      await rotate(written, day);
      await rotateRegister(laidOut, LOG, { now: new Date(START + day * MS_PER_DAY) });
      assert.deepEqual(contents(written), contents(laidOut), `day ${day}`);
      await written.append(LOG, more);
      await laidOut.append(LOG, more);
    }
  });

  it('keep a field this code does not parse in the snapshot, rotation after rotation', async () => {
    const waits = [{ kind: 'approval', who: 'lead' }];
    const verifying = toJsonlLine({ v: EVENT_VERSION, type: 'status', id: 'T2', at: at(3), by: 'alpha', status: 'verifying', note: 'n', evidence: null, skill: null, proof: 'p', waits, kind: 'x' });
    const files = new MemoryFiles({ [LOG]: TEXT + verifying });
    await rotate(files, 4);
    await files.append(LOG, create('T3', 5));
    await rotate(files, 6);
    const snapshot = files.get(PATHS.snapshot) ?? '';
    assert.ok(snapshot.includes(verifying), snapshot);
    const working = await readWorkingSet(files, PATHS);
    assert.deepEqual(working.state.tasks.get('T2')?.waits, waits);
  });

  it('rebuild a snapshot that lost fields from the history when asked, saying what it restores; a plain rotation refuses it', async () => {
    const waits = [{ kind: 'approval', who: 'lead' }];
    const fields = { v: EVENT_VERSION, type: 'status', id: 'T2', at: at(3), by: 'alpha', status: 'verifying', note: 'n', evidence: null, skill: null, proof: 'p' };
    const verifying = toJsonlLine({ ...fields, waits });
    const files = new MemoryFiles({ [LOG]: TEXT + verifying });
    await rotate(files, 4);
    // An older teamrig wrote the snapshot's lines back with only the fields it parsed.
    await files.write(PATHS.snapshot, (files.get(PATHS.snapshot) ?? '').replace(verifying, toJsonlLine(fields)));
    const difference = 'T2 folds otherwise in the working set than in the history';
    const plain = await planRotation(files, PATHS, options(4));
    assert.deepEqual([plain.problems, plain.historyDiffers, plain.rebuild], [[difference], true, null]);
    const plan = await planRotation(files, PATHS, options(4, { fromHistory: true }));
    assert.deepEqual(
      [plan.source, plan.skippedSnapshot, plan.sourceEvents, plan.idle, plan.historyDiffers, plan.rebuild, plan.problems],
      ['history', null, 5, false, false, { differences: [difference], restoredLines: 1 }, []],
    );
    await applyRotation(files, PATHS, plan);
    assert.ok((files.get(PATHS.snapshot) ?? '').includes(verifying));
    assert.deepEqual((await readWorkingSet(files, PATHS)).state.tasks.get('T2')?.waits, waits);
    await assertReadsAs(files, TEXT + verifying);
    const again = await planRotation(files, PATHS, options(4, { fromHistory: true }));
    assert.deepEqual([again.rebuild, again.problems], [{ differences: [], restoredLines: 0 }, []]);
  });

  it('rebuild nothing where no snapshot is there to replace: a log never rotated, or a damaged snapshot', async () => {
    const fresh = await planRotation(new MemoryFiles({ [LOG]: TEXT }), PATHS, options(4, { fromHistory: true }));
    assert.deepEqual([fresh.source, fresh.rebuild, fresh.problems], ['history', null, []]);
    const files = new MemoryFiles({ [LOG]: TEXT });
    await rotate(files, 4);
    await files.write(PATHS.snapshot, '{"v":3,"type":"snap');
    const damaged = await planRotation(files, PATHS, options(4, { fromHistory: true }));
    assert.deepEqual([damaged.source, damaged.skippedSnapshot, damaged.rebuild, damaged.problems], ['history', 'its first line is no snapshot header', null, []]);
  });

  it('skip a damaged snapshot for the whole history, and write a good one in its place', async () => {
    const files = new MemoryFiles({ [LOG]: TEXT });
    await rotate(files, 4);
    await files.write(PATHS.snapshot, '{"v":3,"type":"snap');
    const plan = await rotate(files, 4);
    assert.deepEqual(
      [plan.source, plan.skippedSnapshot, plan.tailEvents, plan.idle, plan.history],
      ['history', 'its first line is no snapshot header', 0, false, { tasks: 2, events: 4 }],
    );
    assert.equal(readSnapshotText(files.get(PATHS.snapshot)).kind, 'usable');
    await assertReadsAs(files, TEXT);
  });

  it('call a rotation idle when nothing came since the last one and nothing retires; an empty log is idle too', async () => {
    const files = new MemoryFiles({ [LOG]: TEXT });
    await rotate(files, 4);
    assert.equal((await planRotation(files, PATHS, options(4))).idle, true);
    assert.equal((await planRotation(files, PATHS, options(20))).idle, false, 'T1 retires');
    const empty = await planRotation(new MemoryFiles(), PATHS, options(0));
    assert.deepEqual([empty.idle, empty.tailEvents, empty.source], [true, 0, 'history']);
  });

  const STEPS: readonly (readonly [FileOperation, string, number, boolean])[] = [
    ['createExclusive', PATHS.segment(1), 1, false],
    ['write', LOG, 1, true],
    ['write', PATHS.snapshot, 2, false],
  ];
  for (const [operation, path, nextSegment, leftover] of STEPS) {
    it(`leave files that read as before when the rotation stops at ${operation} ${path}, and complete on the next run`, async () => {
      const files = new MemoryFiles({ [LOG]: TEXT });
      const faulty = new FaultyFiles(files).fail(operation, path, systemError('EIO'));
      const plan = await planRotation(faulty, PATHS, options(4));
      await assert.rejects(applyRotation(faulty, PATHS, plan), /EIO/);
      await assertReadsAs(files, TEXT);
      await files.append(LOG, LATER);
      await assertReadsAs(files, TEXT + LATER);
      const next = await rotate(files, 5);
      assert.deepEqual([next.segment, next.leftover, next.problems], [nextSegment, leftover, []]);
      await assertReadsAs(files, TEXT + LATER);
    });
  }

  it('refuse with nothing written when the segment it would write holds something else', async () => {
    const files = new MemoryFiles({ [LOG]: TEXT, [PATHS.segment(1)]: create('T9', 0) });
    const before = contents(files);
    const plan = await planRotation(files, PATHS, options(4));
    assert.deepEqual(plan.problems, [`${PATHS.segment(1)} is there and is not the start of the tail: move it aside by hand, then rotate again`]);
    const refusal = await applyRotation(files, PATHS, plan).then(
      () => assert.fail('applied'),
      (error: unknown) => error,
    );
    assert.ok(refusal instanceof RotationRefusedError);
    assert.deepEqual(refusal.problems, plan.problems);
    assert.match(refusal.message, /^the rotation is refused, nothing was written: /);
    assert.deepEqual(contents(files), before);
  });

  it('refuse when the segment appears between the plan and the writes', async () => {
    const files = new MemoryFiles({ [LOG]: TEXT });
    const plan = await planRotation(files, PATHS, options(4));
    await files.write(PATHS.segment(1), TEXT);
    await assert.rejects(applyRotation(files, PATHS, plan), /appeared while the rotation ran: another writer is not taking the register's lock/);
    assert.equal(files.get(LOG), TEXT);
  });

  it('refuse a log with lines from a newer teamrig', async () => {
    const files = new MemoryFiles({ [LOG]: `${TEXT}{"v":9,"type":"status","id":"T1"}\n` });
    const plan = await planRotation(files, PATHS, options(4));
    assert.deepEqual(plan.problems, ['the register has lines from a newer teamrig (v9): update teamrig before rotating it']);
  });

  it('refuse a log with a status from a newer teamrig, which the new snapshot would drop, and write nothing', async () => {
    const files = new MemoryFiles({ [LOG]: TEXT + status('T2', 4, 'paused') });
    const before = contents(files);
    const plan = await planRotation(files, PATHS, options(4));
    assert.deepEqual(plan.problems, ['the register has 1 line(s) from a newer teamrig: update teamrig before rotating it']);
    await assert.rejects(applyRotation(files, PATHS, plan), RotationRefusedError);
    assert.deepEqual(contents(files), before);
  });

  it('name each way a working set differs from the whole history', async () => {
    const header = { covered: 1, events: 1, nextId: 'T2', orphans: 0, unreadable: 0, newer: 0, newestVersion: EVENT_VERSION, retired: 0, retiredLastWeek: null, at: at(4) };
    const files = new MemoryFiles({
      [PATHS.segment(1)]: TEXT,
      [PATHS.snapshot]: toJsonlLine(snapshotHeaderRecord(header)) + create('T1', 0),
      [LOG]: toJsonlLine(markerRecord(1, at(4))),
    });
    const plan = await planRotation(files, PATHS, options(4));
    assert.deepEqual(plan.problems, [
      'the working set has nextId T2 where T3 is expected',
      'T1 folds otherwise in the working set than in the history',
      'T2 is in-progress in the history and missing from the working set',
      'the working set counts 0 retired task(s) where the history has 1 outside it',
    ]);
  });

  it('refuse with nothing written when a line reopens a task that left the working set', async () => {
    const files = new MemoryFiles({ [LOG]: TEXT });
    assert.deepEqual((await rotate(files, 20)).compaction.retiredNow, ['T1']);
    // The register refuses this write ("archived"); only a hand edit or a writer outside the lock can append it.
    await files.append(LOG, status('T1', 21, 'in-progress'));
    const before = contents(files);
    const plan = await planRotation(files, PATHS, options(22));
    assert.deepEqual(plan.problems, [
      'the working set has orphans 1 where 0 is expected',
      'T1 is in-progress in the history and missing from the working set',
    ]);
    await assert.rejects(applyRotation(files, PATHS, plan), RotationRefusedError);
    assert.deepEqual(contents(files), before);
  });
});

describe('readBack', () => {
  const source = readRegister(TEXT);
  const compaction = compactRegister(source, { covered: 1, now: new Date(START + 4 * MS_PER_DAY), zone: TimeZone.UTC, retainDays: RETAIN_DAYS, keep: new Set() });
  const marker = toJsonlLine(markerRecord(1, at(4)));

  it('finds every task unchanged in the files a compaction writes', () => {
    assert.deepEqual(readBack(source, compaction, marker), { unchanged: 2, problems: [] });
  });

  it('names a snapshot that does not read back', () => {
    assert.deepEqual(readBack(source, { ...compaction, text: '{"v":3' }, marker).problems, ['the new snapshot does not read back: its first line is no snapshot header']);
  });

  it('names a task that folds otherwise, a retired task still there and a task that was not there', () => {
    const changed = compaction.text.replace('"in-progress"', '"waiting"');
    assert.deepEqual(readBack(source, { ...compaction, text: changed }, marker).problems, ['T2 folds otherwise from the new files']);
    assert.deepEqual(readBack(source, { ...compaction, retiredNow: ['T1'] }, marker).problems, ['T1 is retired and still in the new working set']);
    const header = toJsonlLine(snapshotHeaderRecord({ ...compaction.header, events: compaction.header.events + 1 }));
    const extra = header + compaction.text.slice(compaction.text.indexOf('\n') + 1) + create('T3', 3);
    assert.deepEqual(readBack(source, { ...compaction, text: extra }, marker).problems, [
      'the new working set has nextId T4 where T3 is expected',
      'T3 is in the new working set and not in the old',
    ]);
  });
});

class NoSkills implements SkillCatalog {
  async exists(): Promise<boolean> {
    return false;
  }
}

/** A tail of `count` status events on T2, enough to pass AUTO_ROTATE_CHARS with 4,000. */
function busyTail(count: number): string {
  return Array.from({ length: count }, (_, index) => status('T2', 5, index % 2 === 0 ? 'in-progress' : 'waiting')).join('');
}

/** A register over `files`; `autoArchive` stands for the team's `register.autoArchive`, on by default as in the config. */
function registerOn(files: MemoryFiles | FaultyFiles, autoArchive = true): Register {
  return new Register({
    log: new JsonlEventLog(files, LOG),
    mutex: new InlineMutex(),
    numbering: OWN_NUMBERS,
    elsewhere: NOTHING_ELSEWHERE,
    goals: NO_GOAL_RECORDS,
    clock: new FakeClock(at(6)),
    zone: TimeZone.UTC,
    policy: new RegisterPolicy(testConfig()),
    skills: new NoSkills(),
    autoArchive,
  });
}

const START_T2 = { status: 'in-progress' } as const;

describe('a write rotates a log rotated before once its tail is long', () => {
  it('leaves a log never rotated alone however long it is', async () => {
    const files = new MemoryFiles({ [LOG]: TEXT + busyTail(4_000) });
    assert.ok((files.get(LOG)?.length ?? 0) >= AUTO_ROTATE_CHARS);
    const result = await registerOn(files).setStatus('alpha', 'T2', START_T2);
    assert.deepEqual(result.ok && result.value.rotation, { kind: 'none' });
    assert.equal(files.get(PATHS.segment(1)), undefined);
  });

  it('leaves a short tail alone, and rotates a long one after the write it carries', async () => {
    const files = new MemoryFiles({ [LOG]: TEXT });
    await rotate(files, 4);
    const short = await registerOn(files).setStatus('alpha', 'T2', { status: 'waiting', waits: [{ kind: 'approval', who: 'owner' }], card: TEST_CARD, note: 'review' });
    assert.deepEqual(short.ok && short.value.rotation, { kind: 'none' });
    await files.append(LOG, busyTail(4_000));
    const long = await registerOn(files).setStatus('alpha', 'T2', START_T2);
    assert.deepEqual(long.ok && long.value.rotation, { kind: 'rotated', segment: 2, retired: 0 });
    assert.equal(readEvents(files.get(PATHS.segment(2)) ?? '').events.at(-1)?.at, at(6), 'the write is in the archived tail');
    assert.equal(files.get(LOG), toJsonlLine(markerRecord(2, at(6))));
  });

  it('keeps the write and reports a rotation that failed', async () => {
    const files = new MemoryFiles({ [LOG]: TEXT });
    await rotate(files, 4);
    await files.append(LOG, busyTail(4_000));
    const faulty = new FaultyFiles(files).fail('createExclusive', PATHS.segment(2), systemError('EACCES'));
    const result = await registerOn(faulty).setStatus('alpha', 'T2', START_T2);
    assert.ok(result.ok);
    assert.deepEqual(result.value.rotation, { kind: 'failed', error: 'EACCES: simulated' });
    assert.deepEqual(readEvents(files.get(LOG) ?? '').events.at(-1), result.value.event);
  });

  it('never rotates when the team turned automatic archiving off, however long the tail', async () => {
    const files = new MemoryFiles({ [LOG]: TEXT });
    await rotate(files, 4);
    await files.append(LOG, busyTail(4_000));
    const result = await registerOn(files, false).setStatus('alpha', 'T2', START_T2);
    assert.ok(result.ok);
    assert.deepEqual(result.value.rotation, { kind: 'none' });
    assert.ok((files.get(LOG)?.length ?? 0) >= AUTO_ROTATE_CHARS);
    assert.deepEqual(readEvents(files.get(LOG) ?? '').events.at(-1), result.value.event);
    assert.equal(files.get(PATHS.segment(2)), undefined);
  });
});
