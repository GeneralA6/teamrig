import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { MemoryFiles } from '../testing/memory-files.ts';
import { emptyWarnState, type WarnState } from './warn.ts';
import { formatWarnState, parseWarnState, WarnStore } from './warn-store.ts';

const FOLDER = join('team', 'state', 'usage', 'warn');
const STATE: WarnState = { day: '2026-10-15', level: 100, modelLevel: 80, ahead: true, leadTold: true, quietFrom: 1_760_565_600_000, liftAt: 1_760_529_600_000 };

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

  it('reads a damaged file as nothing shown', async () => {
    const files = new MemoryFiles();
    await files.write(join(FOLDER, 'alpha.json'), '{"v":1,"day":"2026-10-15"');
    assert.equal(await new WarnStore(files, FOLDER).read('alpha'), undefined);
  });
});

describe('parseWarnState', () => {
  it('round-trips, leaving the optional times out when unset', () => {
    assert.deepEqual(parseWarnState(formatWarnState(STATE)), STATE);
    const empty = emptyWarnState('2026-10-15');
    assert.ok(!formatWarnState(empty).includes('quietFrom'));
    assert.deepEqual(parseWarnState(formatWarnState(empty)), empty);
  });

  it('refuses another format, a wrong field type, a bad time and a missing field', () => {
    const fields = { v: 1, day: '2026-10-15', level: 100, modelLevel: 80, ahead: true, leadTold: true, quietFrom: 1 };
    const { day: _day, ...noDay } = fields;
    const variants: readonly object[] = [{ ...fields, v: 2 }, { ...fields, level: 'high' }, { ...fields, ahead: 1 }, { ...fields, quietFrom: 'tonight' }, noDay];
    assert.ok(parseWarnState(JSON.stringify(fields)) !== undefined);
    for (const variant of variants) {
      assert.equal(parseWarnState(JSON.stringify(variant)), undefined, JSON.stringify(variant));
    }
  });
});
