import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { NewerDataError } from '../core/jsonl.ts';
import { fieldPaths } from '../testing/field-paths.ts';
import { MemoryFiles } from '../testing/memory-files.ts';
import { emptyWarnState, type WarnState } from './warn.ts';
import { formatWarnState, parseWarnState, WARN_FORMAT, WarnStore } from './warn-store.ts';

const FOLDER = join('team', 'state', 'usage', 'warn');
const STATE: WarnState = {
  day: '2026-10-15',
  level: 100,
  modelLevel: 80,
  ahead: true,
  held: true,
  escalated: true,
  leadTold: true,
  quietFrom: 1_760_565_600_000,
  liftAt: 1_760_529_600_000,
  burstAt: 1_760_500_000_000,
  modelBurstAt: 1_760_500_000_000,
  surplusShown: 1_761_008_400_000,
};

describe('WarnStore', () => {
  it('keeps what each session was shown, one file each', async () => {
    const files = new MemoryFiles();
    const store = new WarnStore(files, FOLDER);
    assert.equal(await store.read('alpha'), undefined);
    await store.write('alpha', STATE);
    await store.write('bravo', emptyWarnState('2026-10-15'));
    assert.deepEqual(await store.read('alpha'), STATE);
    assert.deepEqual(await store.read('bravo'), emptyWarnState('2026-10-15'));
    assert.equal(files.paths().length, 2);
    assert.equal(await files.read(join(FOLDER, 'bravo.json')), formatWarnState(emptyWarnState('2026-10-15')));
  });

  it('reads a damaged file as nothing shown, and writes over it', async () => {
    const files = new MemoryFiles();
    await files.write(join(FOLDER, 'alpha.json'), '{"v":1,"day":"2026-10-15"');
    const store = new WarnStore(files, FOLDER);
    assert.equal(await store.read('alpha'), undefined);
    await store.write('alpha', STATE);
    assert.deepEqual(await store.read('alpha'), STATE);
  });

  it('reads a file a newer teamrig wrote as nothing shown, and refuses to write over it', async () => {
    const newer = `{"v":${WARN_FORMAT + 1},"day":"2026-10-15"}`;
    const files = new MemoryFiles({ [join(FOLDER, 'alpha.json')]: newer });
    const store = new WarnStore(files, FOLDER);
    assert.equal(await store.read('alpha'), undefined);
    await assert.rejects(store.write('alpha', STATE), (error: unknown) => error instanceof NewerDataError && error.found === WARN_FORMAT + 1 && error.known === WARN_FORMAT);
    assert.equal(await files.read(join(FOLDER, 'alpha.json')), newer);
  });
});

describe('parseWarnState', () => {
  it('writes the pinned fields of its format: a field added to the file raises WARN_FORMAT', () => {
    // Format 1 gained `held` without a raise, so an older teamrig rewrites a file without it; format 2 added `escalated`.
    const written: Readonly<Record<number, readonly string[]>> = {
      1: ['ahead', 'burstAt', 'day', 'held', 'leadTold', 'level', 'liftAt', 'modelBurstAt', 'modelLevel', 'quietFrom', 'surplusShown', 'v'],
      2: ['ahead', 'burstAt', 'day', 'escalated', 'held', 'leadTold', 'level', 'liftAt', 'modelBurstAt', 'modelLevel', 'quietFrom', 'surplusShown', 'v'],
    };
    assert.deepEqual(fieldPaths(JSON.parse(formatWarnState(STATE))), written[WARN_FORMAT]);
  });

  it('round-trips, leaving the optional times out when unset', () => {
    assert.deepEqual(parseWarnState(formatWarnState(STATE)), STATE);
    const empty = emptyWarnState('2026-10-15');
    for (const key of ['quietFrom', 'liftAt', 'burstAt', 'modelBurstAt', 'surplusShown']) {
      assert.ok(!formatWarnState(empty).includes(key), key);
    }
    assert.deepEqual(parseWarnState(formatWarnState(empty)), empty);
  });

  it('refuses another format, a wrong field type, a bad time and a missing field', () => {
    const fields = { v: WARN_FORMAT, day: '2026-10-15', level: 100, modelLevel: 80, ahead: true, held: false, escalated: true, leadTold: true, quietFrom: 1 };
    const { day: _day, ...noDay } = fields;
    const { escalated: _escalated, ...noEscalated } = fields;
    const variants: readonly object[] = [
      { ...fields, v: WARN_FORMAT + 1 },
      { ...fields, level: 'high' },
      { ...fields, ahead: 1 },
      { ...fields, held: 'yes' },
      { ...fields, escalated: 'yes' },
      noEscalated,
      { ...fields, quietFrom: 'tonight' },
      { ...fields, burstAt: 'then' },
      { ...fields, modelBurstAt: null },
      { ...fields, surplusShown: 'Wed' },
      noDay,
    ];
    assert.equal(parseWarnState(JSON.stringify(fields))?.escalated, true);
    for (const variant of variants) {
      assert.equal(parseWarnState(JSON.stringify(variant)), undefined, JSON.stringify(variant));
    }
  });

  it('reads a format-1 file with the fields added since at their defaults: not held, not escalated', () => {
    // Saved before `held`, then `escalated`, were kept.
    const old = { v: 1, day: '2026-10-15', level: 100, modelLevel: 80, ahead: true, leadTold: true };
    assert.deepEqual(parseWarnState(JSON.stringify(old)), { ...emptyWarnState('2026-10-15'), level: 100, modelLevel: 80, ahead: true, leadTold: true });
  });
});
