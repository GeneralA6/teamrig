import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { MemoryFiles } from '../testing/memory-files.ts';
import type { WakeState } from './decide.ts';
import { formatWakeRecord, formatWakeState, logWake, parseWakeState, WakeStore } from './store.ts';

const FOLDER = join('team', 'state', 'wake');
const FULL: WakeState = { tab: 'tab-1', known: ['T1', 'T2'], pending: { since: 1_900_000_000_000, ids: ['T2'] }, lastWakeAt: 1_899_999_000_000 };
const BARE: WakeState = { tab: 'tab-2', known: [], pending: undefined, lastWakeAt: undefined };

describe('WakeStore', () => {
  it('keeps the state of each session in its own file, with a lock beside it', async () => {
    const files = new MemoryFiles();
    const store = new WakeStore(files, FOLDER);
    assert.equal(await store.read('alpha'), undefined);
    await store.write('alpha', FULL);
    await store.write('bravo', BARE);
    assert.deepEqual(await store.read('alpha'), FULL);
    assert.deepEqual(await store.read('bravo'), BARE);
    assert.equal(await files.read(join(FOLDER, 'bravo.json')), formatWakeState(BARE));
    assert.equal(store.lockOf('alpha'), join(FOLDER, 'alpha.lock'));
  });

  it('reads a damaged file, or one from another format, as no check yet', () => {
    const damaged = [
      '{"v":1,"tab":"t"',
      '{"v":2,"tab":"t","known":[]}',
      '{"v":1,"known":[]}',
      '{"v":1,"tab":"t","known":[1]}',
      '{"v":1,"tab":"t","known":[],"pending":[]}',
      '{"v":1,"tab":"t","known":[],"pending":{"since":"x","ids":[]}}',
      '{"v":1,"tab":"t","known":[],"pending":{"since":1,"ids":"T1"}}',
      '{"v":1,"tab":"t","known":[],"lastWakeAt":"x"}',
    ];
    for (const text of damaged) {
      assert.equal(parseWakeState(text), undefined, text);
    }
    assert.deepEqual(parseWakeState(formatWakeState(FULL)), FULL);
  });
});

describe('wake log', () => {
  it('appends each wake with its cost and each dropped wake with its reason', async () => {
    const files = new MemoryFiles();
    const path = join('team', 'state', 'wakes.jsonl');
    const at = Date.parse('2030-01-08T10:00:00.000Z');
    await logWake(files, path, { kind: 'wake', at, session: 'alpha', tab: 'tab-1', ids: ['T1'], cost: { w: 27_000, cold: false, weekPct: 0.003 } });
    await logWake(files, path, { kind: 'wake', at, session: 'alpha', tab: 'tab-1', ids: ['T2'], cost: { w: 210_000, cold: true, weekPct: undefined } });
    await logWake(files, path, { kind: 'dropped', at, session: 'alpha', tab: 'tab-1', reason: 'blocked by a hook' });
    const lines = (await files.read(path))?.trimEnd().split('\n').map((line): unknown => JSON.parse(line));
    assert.deepEqual(lines, [
      { v: 1, at: '2030-01-08T10:00:00.000Z', kind: 'wake', session: 'alpha', tab: 'tab-1', ids: ['T1'], w: 27_000, cold: false, weekPct: 0.003 },
      { v: 1, at: '2030-01-08T10:00:00.000Z', kind: 'wake', session: 'alpha', tab: 'tab-1', ids: ['T2'], w: 210_000, cold: true },
      { v: 1, at: '2030-01-08T10:00:00.000Z', kind: 'dropped', session: 'alpha', tab: 'tab-1', reason: 'blocked by a hook' },
    ]);
    assert.equal(formatWakeRecord({ kind: 'dropped', at, session: 'a', tab: 't', reason: 'r' }).endsWith('\n'), true);
  });
});
