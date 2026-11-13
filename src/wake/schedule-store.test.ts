import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { NewerDataError } from '../core/jsonl.ts';
import { InlineMutex } from '../testing/inline-mutex.ts';
import { MemoryFiles } from '../testing/memory-files.ts';
import { DayScheduleStore } from './schedule-store.ts';
import type { ScheduledStart } from './schedule.ts';

const PATH = join('/', 'kit', 'teams', 'app', 'state', 'day-schedule.json');
const SIX: ScheduledStart = { kind: 'at', minute: 360 };
const NONE: ScheduledStart = { kind: 'none' };

describe('day schedule store', () => {
  it('reads none with no file, and writes a day under the lock over what it held', async () => {
    const files = new MemoryFiles();
    const lock = new InlineMutex();
    const store = new DayScheduleStore(files, PATH, lock);
    assert.equal(await store.read(), undefined);
    await store.write('2030-01-08', new Map([['app', SIX]]));
    const written = await store.write('2030-01-08', new Map([['app/web', NONE]]));
    assert.deepEqual(written.days.get('2030-01-08'), new Map<string, ScheduledStart>([['app', SIX], ['app/web', NONE]]));
    assert.deepEqual(await store.read(), written);
    assert.equal(lock.runs, 2, 'only a write locks');
  });

  it('reads a newer format as none and refuses to overwrite it', async () => {
    const files = new MemoryFiles();
    const newer = '{"v":2,"days":{}}';
    await files.write(PATH, newer);
    const store = new DayScheduleStore(files, PATH, new InlineMutex());
    assert.equal(await store.read(), undefined);
    await assert.rejects(store.write('2030-01-08', new Map([['app', SIX]])), NewerDataError);
    assert.equal(await files.read(PATH), newer);
  });
});
