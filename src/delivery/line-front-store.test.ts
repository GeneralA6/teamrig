import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryFiles } from '../testing/memory-files.ts';
import { lineFrontPath, LineFrontStore } from './line-front-store.ts';

const STATE = '/kit/teams/alpha/state';
const FRONT = { task: 'T5', at: '2026-11-08T11:50:00.000Z', by: 'lead' };

describe('LineFrontStore (T4082)', () => {
  it('reads no front before one is put, the one put, the last of two, and none once cleared', async () => {
    const store = new LineFrontStore(new MemoryFiles(), lineFrontPath(STATE));
    assert.equal(await store.read(), undefined);
    await store.put(FRONT);
    assert.deepEqual(await store.read(), FRONT);
    await store.put({ ...FRONT, task: 'T6' });
    assert.deepEqual(await store.read(), { ...FRONT, task: 'T6' }, 'one at a time: a new front replaces the last');
    assert.equal(await store.clear(), true);
    assert.equal(await store.read(), undefined);
    assert.equal(await store.clear(), false, 'none to clear');
  });

  it('reads a file that does not parse, or names no task, as no front', async () => {
    const files = new MemoryFiles();
    const store = new LineFrontStore(files, lineFrontPath(STATE));
    await files.write(lineFrontPath(STATE), '{"task":');
    assert.equal(await store.read(), undefined);
    await files.write(lineFrontPath(STATE), JSON.stringify({ ...FRONT, task: 'soon' }));
    assert.equal(await store.read(), undefined);
  });
});
