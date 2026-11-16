import assert from 'node:assert/strict';
import { basename, dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { teamPaths } from '../core/home.ts';
import { NewerDataError, toJsonlLine } from '../core/jsonl.ts';
import { LockBusyError, type Mutex } from '../core/lock.ts';
import { InlineMutex } from '../testing/inline-mutex.ts';
import { MemoryFiles } from '../testing/memory-files.ts';
import type { GoalSliceInput } from './goal-slices.ts';
import { GoalStore, type GoalWriter } from './goal-store.ts';
import { GOAL_RECORD_VERSION, GOALS_FILE, type GoalAddInput, type KeyResultCap } from './goals.ts';

const PATH = join('/', 'team', 'state', 'goals.jsonl');
const LEAD: GoalWriter = { by: 'lead', at: '2030-01-08T10:00:00.000Z' };
const LATER: GoalWriter = { by: 'lead', at: '2030-01-09T10:00:00.000Z' };
const A1: GoalAddInput = { tag: 'A1', title: 'Ship the pane goals', start: '2030-01-08', target: '2030-01-20', parent: null };
const CAP: KeyResultCap = { max: 5, today: '2030-01-08' };
const NOTHING: GoalSliceInput = { tag: 'A1', slice: 1, title: null, owner: null, ship: null, proof: null, tasks: null, size: null, proven: null, note: 'why' };
const SLICE_1: GoalSliceInput = { ...NOTHING, title: 'Pane reads slices', owner: 'tr-pane', ship: '2030-01-15', proof: 'the pane shows A1:1 live', tasks: ['T10'], size: 6 };

const busy: Mutex = {
  run: () => Promise.reject(new LockBusyError(`${PATH}.lock`, 10)),
};

function store(files: MemoryFiles, mutex: Mutex = new InlineMutex()): GoalStore {
  return new GoalStore(files, PATH, mutex);
}

describe('GoalStore', () => {
  it('lives in the goals file beside the team events, the file the pane reads', () => {
    const paths = teamPaths(join('/', 'kit'), 'app', join('/', 'claude'));

    assert.equal(basename(paths.goals), GOALS_FILE);
    assert.equal(dirname(paths.goals), dirname(paths.events));
  });

  it('reads no goals before the file exists', async () => {
    const read = await store(new MemoryFiles()).read();

    assert.equal(read.goals.size, 0);
  });

  it('appends an added goal as one line of the format an older teamrig reads, under the lock, and reads it back', async () => {
    const files = new MemoryFiles();
    const mutex = new InlineMutex();
    const goals = store(files, mutex);

    const write = await goals.add(A1, LEAD, CAP);

    assert.deepEqual(write, { kind: 'written', record: { type: 'goal-add', ...LEAD, ...A1 } });
    assert.equal(mutex.runs, 1);
    const lines = (files.get(PATH) ?? '').split('\n').filter((line) => line !== '');
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0] ?? '{}').v, 1);
    const goal = (await goals.read()).goals.get('A1');
    assert.equal(goal?.target, '2030-01-20');
    assert.equal(goal?.addedBy, 'lead');
  });

  it('refuses a second add of a tag and writes nothing', async () => {
    const files = new MemoryFiles();
    const goals = store(files);
    await goals.add(A1, LEAD, CAP);
    const before = files.get(PATH);

    const write = await goals.add({ ...A1, title: 'Another' }, LATER, CAP);

    assert.equal(write.kind, 'refused');
    assert.match(write.kind === 'refused' ? write.reason : '', /A1 already exists/);
    assert.equal(files.get(PATH), before);
  });

  it('records a target move as a slip with its note', async () => {
    const goals = store(new MemoryFiles());
    await goals.add(A1, LEAD, CAP);

    const write = await goals.set({ tag: 'A1', target: '2030-01-27', title: null, slice: null, note: 'the pane waits a week on its data' }, LATER);

    assert.equal(write.kind, 'written');
    const goal = (await goals.read()).goals.get('A1');
    assert.equal(goal?.target, '2030-01-27');
    assert.deepEqual(goal?.slips, [{ at: LATER.at, by: 'lead', from: '2030-01-20', to: '2030-01-27', note: 'the pane waits a week on its data' }]);
  });

  it('refuses a change to a goal never added', async () => {
    const files = new MemoryFiles();

    const write = await store(files).set({ tag: 'B1', target: '2030-01-27', title: null, slice: null, note: 'later' }, LATER);

    assert.equal(write.kind, 'refused');
    assert.equal(files.get(PATH), undefined);
  });

  it('writes nothing while another process holds the lock', async () => {
    const files = new MemoryFiles();

    await assert.rejects(store(files, busy).add(A1, LEAD, CAP), LockBusyError);
    assert.equal(files.get(PATH), undefined);
  });

  it('refuses to write beside records of a newer teamrig, and still reads the rest', async () => {
    const newer = toJsonlLine({ v: GOAL_RECORD_VERSION + 1, type: 'goal-add', tag: 'B1' });
    const files = new MemoryFiles({ [PATH]: newer });
    const goals = store(files);

    await assert.rejects(goals.add(A1, LEAD, CAP), NewerDataError);
    assert.equal(files.get(PATH), newer);
    assert.equal((await goals.read()).newer, 1);
  });

  it('refuses a key result past the cap under the lock, and lets a top goal in (T2083)', async () => {
    const files = new MemoryFiles();
    const goals = store(files);
    await goals.add(A1, LEAD, CAP);
    await goals.add({ ...A1, tag: 'A1.1', parent: 'A1' }, LEAD, { ...CAP, max: 1 });
    const before = files.get(PATH);

    const write = await goals.add({ ...A1, tag: 'A1.2', parent: 'A1' }, LATER, { ...CAP, max: 1 });

    assert.match(write.kind === 'refused' ? write.reason : '', /holds 1 key results .* focus\.maxActiveKeyResults/);
    assert.equal(files.get(PATH), before);
    assert.equal((await goals.add({ ...A1, tag: 'B1' }, LATER, { ...CAP, max: 1 })).kind, 'written');
  });

  it('ranks a goal in a line of format 2, which an older teamrig counts as newer, and takes the rank off with null (T2083)', async () => {
    const files = new MemoryFiles();
    const goals = store(files);
    await goals.add(A1, LEAD, CAP);

    const write = await goals.rank({ tag: 'A1', rank: 2 }, LATER);

    assert.deepEqual(write, { kind: 'written', record: { type: 'goal-rank', ...LATER, tag: 'A1', rank: 2 } });
    const lines = (files.get(PATH) ?? '').split('\n').filter((line) => line !== '');
    assert.deepEqual(
      lines.map((line) => JSON.parse(line).v),
      [1, 2],
    );
    assert.equal((await goals.read()).goals.get('A1')?.rank, 2);
    assert.equal((await goals.rank({ tag: 'A1', rank: null }, LATER)).kind, 'written');
    assert.equal((await goals.read()).goals.get('A1')?.rank, null);
  });

  it('refuses to rank a goal never added, or to a rank it holds, and writes nothing (T2083)', async () => {
    const files = new MemoryFiles();
    const goals = store(files);
    await goals.add(A1, LEAD, CAP);
    const before = files.get(PATH);

    const missing = await goals.rank({ tag: 'B1', rank: 1 }, LATER);
    const same = await goals.rank({ tag: 'A1', rank: null }, LATER);

    assert.match(missing.kind === 'refused' ? missing.reason : '', /goal B1 does not exist/);
    assert.match(same.kind === 'refused' ? same.reason : '', /goal A1 is not ranked; nothing to change/);
    assert.equal(files.get(PATH), before);
  });

  it('adds a slice in a line of format 4, under the lock, and its owner records the proof (T2203)', async () => {
    const files = new MemoryFiles();
    const mutex = new InlineMutex();
    const goals = store(files, mutex);
    await goals.add(A1, LEAD, CAP);

    const write = await goals.slice(SLICE_1, LATER, 'lead');
    const proven = await goals.slice({ ...NOTHING, proven: 'the pane shows A1:1 live' }, { by: 'tr-pane', at: '2030-01-10T10:00:00.000Z' }, 'lead');

    assert.deepEqual(write, { kind: 'written', record: { type: 'goal-slice', ...LATER, ...SLICE_1 } });
    assert.equal(proven.kind, 'written');
    assert.equal(mutex.runs, 3);
    const lines = (files.get(PATH) ?? '').split('\n').filter((line) => line !== '');
    assert.deepEqual(
      lines.map((line) => JSON.parse(line).v),
      [1, GOAL_RECORD_VERSION, GOAL_RECORD_VERSION],
    );
    const slice = (await goals.read()).goals.get('A1')?.slices[0];
    assert.equal(slice?.owner, 'tr-pane');
    assert.deepEqual(slice?.proven, { at: '2030-01-10T10:00:00.000Z', by: 'tr-pane', evidence: 'the pane shows A1:1 live' });
  });

  it('refuses a slice change by anyone but the lead, and writes nothing (T2203)', async () => {
    const files = new MemoryFiles();
    const goals = store(files);
    await goals.add(A1, LEAD, CAP);
    await goals.slice(SLICE_1, LATER, 'lead');
    const before = files.get(PATH);

    const write = await goals.slice({ ...NOTHING, ship: '2030-01-30' }, { by: 'tr-pane', at: '2030-01-10T10:00:00.000Z' }, 'lead');

    assert.match(write.kind === 'refused' ? write.reason : '', /only the lead \(lead\) adds and changes a goal's slices/);
    assert.equal(files.get(PATH), before);
  });
});
