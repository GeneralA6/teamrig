import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { Mutex } from '../core/lock.ts';
import { FakeClock } from '../testing/fake-clock.ts';
import { MemoryFiles } from '../testing/memory-files.ts';
import { ConfigLock, type ConfigWriter } from './config-lock.ts';
import { formatConfig } from './load.ts';

const CONFIG = join('/teams', 'app', 'config.json');
const BACKUPS = join('/teams', 'app', 'backups');
const OLD = formatConfig({ sessions: ['lead'] });

/** A mutex that runs the task at once and says whether one holds it now. */
class RecordingMutex implements Mutex {
  held = false;

  async run<T>(task: () => Promise<T>): Promise<T> {
    this.held = true;
    try {
      return await task();
    } finally {
      this.held = false;
    }
  }
}

function lockOver(files: MemoryFiles, mutex: Mutex): ConfigLock {
  return new ConfigLock(mutex, files, new FakeClock('2030-01-08T10:00:00Z'), { configPath: CONFIG, backupsDir: BACKUPS });
}

describe('ConfigLock', () => {
  it('writes the config inside its run, holding the lock, and keeps the old file first', async () => {
    const files = new MemoryFiles({ [CONFIG]: OLD });
    const mutex = new RecordingMutex();
    const backup = await lockOver(files, mutex).run(async (writer) => {
      assert.equal(mutex.held, true);
      return writer.write({ sessions: ['lead', 'alpha'] }, 'config.test');
    });
    assert.equal(backup, join(BACKUPS, 'config.test.json'));
    assert.equal(files.get(backup), OLD);
    assert.equal(files.get(CONFIG), formatConfig({ sessions: ['lead', 'alpha'] }));
    assert.equal(mutex.held, false);
  });

  it('refuses a write by a writer kept past its run, leaving the config as it was', async () => {
    const files = new MemoryFiles({ [CONFIG]: OLD });
    let kept: ConfigWriter | undefined;
    await lockOver(files, new RecordingMutex()).run(async (writer) => {
      kept = writer;
    });
    assert.ok(kept !== undefined);
    await assert.rejects(kept.write({ sessions: ['lead', 'alpha'] }, 'config.test'), /was written after its lock was let go/);
    assert.equal(files.get(CONFIG), OLD);
    assert.equal(files.get(join(BACKUPS, 'config.test.json')), undefined);
  });

  it('lets the lock go when its task fails, and passes the failure on', async () => {
    const mutex = new RecordingMutex();
    await assert.rejects(
      lockOver(new MemoryFiles({ [CONFIG]: OLD }), mutex).run(async () => {
        throw new Error('the plan was refused');
      }),
      /the plan was refused/,
    );
    assert.equal(mutex.held, false);
  });
});
