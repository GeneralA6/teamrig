import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_LOCK } from '../config/defaults.ts';
import { FakeClock } from '../testing/fake-clock.ts';
import { FakeSessionProcesses } from '../testing/fake-session-processes.ts';
import { MemoryFiles } from '../testing/memory-files.ts';
import { fileLockOf, type FileLockRuntime } from './file-locks.ts';

const PATH = '/state/events.lock';
const MINUTE = 60_000;

/** A runtime where process 7 runs and 9 is gone. */
function runtimeOf(files: MemoryFiles, clock: FakeClock): FileLockRuntime {
  const sessionProcesses = new FakeSessionProcesses().add({ pid: 7, parentPid: 1, name: 'node', commandLine: 'node teamrig' });
  return { files, clock, sleep: clock.sleep, pid: 4242, sessionProcesses, newId: () => 'take-1' };
}

describe('fileLockOf', () => {
  it('takes over at once a lock whose process the runtime sees gone (T1584)', async () => {
    const clock = new FakeClock(10 * MINUTE);
    const files = new MemoryFiles({ [PATH]: JSON.stringify({ pid: 9, at: 10 * MINUTE, id: 'take-9' }) });
    assert.equal(await fileLockOf(runtimeOf(files, clock), PATH, DEFAULT_LOCK).run(async () => 'ran'), 'ran');
    assert.deepEqual(clock.sleeps, []);
  });

  it('stores the runtime pid and a new id in the lock it takes', async () => {
    const clock = new FakeClock(10 * MINUTE);
    const files = new MemoryFiles();
    await fileLockOf(runtimeOf(files, clock), PATH, DEFAULT_LOCK).run(async () => {
      assert.deepEqual(JSON.parse(files.get(PATH) ?? ''), { pid: 4242, at: 10 * MINUTE, id: 'take-1' });
    });
  });
});
