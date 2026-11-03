import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { Mutex } from '../core/lock.ts';
import { InlineMutex } from '../testing/inline-mutex.ts';
import { MemoryFiles } from '../testing/memory-files.ts';
import { dayProbePath, formatDayProbe, type DayProbe } from './day-probe.ts';
import { DayProbeStore } from './day-probe-store.ts';

const PATH = dayProbePath(join('/', 'kit'));
const TAB_A = '0123abcd-0000-4000-8000-00000000000a';
const TAB_B = '0123abcd-0000-4000-8000-00000000000b';
const MOMENT = Date.parse('2030-01-08T06:00:00Z');
const AT = MOMENT + 2_000;

/** A lock under which another tab's write lands first: the one a tab waits for while a dozen come due at once. */
class RacedMutex implements Mutex {
  private readonly files: MemoryFiles;
  private readonly probe: DayProbe;

  constructor(files: MemoryFiles, probe: DayProbe) {
    this.files = files;
    this.probe = probe;
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.files.write(PATH, formatDayProbe(this.probe));
    return task();
  }
}

describe('day-start probe store', () => {
  it('writes a claim under the lock, and holds the next tab without one', async () => {
    const lock = new InlineMutex();
    const store = new DayProbeStore(new MemoryFiles(), PATH, lock);
    assert.equal((await store.claim(MOMENT, TAB_A, AT)).kind, 'claim');
    assert.deepEqual([await store.read(), lock.runs], [{ moment: MOMENT, tab: TAB_A, at: AT, releasedAt: undefined }, 1]);
    assert.equal((await store.claim(MOMENT, TAB_B, AT + 1_000)).kind, 'hold');
    assert.equal(lock.runs, 1, 'every due tab asks; only a claim locks');
  });

  it('decides again on the locked read, so a claim another tab made meanwhile holds this one', async () => {
    const files = new MemoryFiles();
    const store = new DayProbeStore(files, PATH, new RacedMutex(files, { moment: MOMENT, tab: TAB_B, at: AT - 500, releasedAt: undefined }));
    assert.equal((await store.claim(MOMENT, TAB_A, AT)).kind, 'hold');
    assert.equal((await store.read())?.tab, TAB_B, "the other tab's claim stands");
  });

  it('releases the probe at a reply under the lock, and takes no lock for a reply that changes nothing', async () => {
    const lock = new InlineMutex();
    const store = new DayProbeStore(new MemoryFiles(), PATH, lock);
    assert.equal(await store.release({ kind: 'answered', tab: TAB_B, at: AT }), undefined, 'no probe, nothing to release');
    await store.claim(MOMENT, TAB_A, AT);
    assert.equal(await store.release({ kind: 'tool', tab: TAB_B, at: AT + 1_000 }), undefined);
    assert.equal(lock.runs, 1, 'every tool end of every tab reads the probe; only a release locks');
    const released = await store.release({ kind: 'tool', tab: TAB_A, at: AT + 9_000 });
    assert.deepEqual([released?.releasedAt, (await store.read())?.releasedAt, lock.runs], [AT + 9_000, AT + 9_000, 2]);
    assert.equal((await store.claim(MOMENT, TAB_B, AT + 10_000)).kind, 'free');
  });

  it('reads a damaged file as no probe, and replaces it at the next claim', async () => {
    const files = new MemoryFiles({ [PATH]: '{"moment": "soo' });
    const store = new DayProbeStore(files, PATH, new InlineMutex());
    assert.equal(await store.read(), undefined);
    assert.equal((await store.claim(MOMENT, TAB_A, AT)).kind, 'claim');
    assert.equal((await store.read())?.tab, TAB_A);
  });
});
