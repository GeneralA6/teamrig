import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { Mutex } from '../core/lock.ts';
import { InlineMutex } from '../testing/inline-mutex.ts';
import { MemoryFiles } from '../testing/memory-files.ts';
import { formatLoginMarker, loginMarkerPath, type LoginChange, type LoginEvent, type LoginNote } from './login.ts';
import { LoginStore } from './login-store.ts';

const PATH = loginMarkerPath(join('/', 'kit'));
const TAB_A = '0123abcd-0000-4000-8000-00000000000a';
const TAB_B = '0123abcd-0000-4000-8000-00000000000b';
const AT = Date.parse('2030-01-08T00:02:00Z');

function failed(claudeSession: string, at: number = AT): LoginEvent {
  return { kind: 'auth-failed', claudeSession, at };
}

function answered(claudeSession: string, at: number): LoginEvent {
  return { kind: 'answered', claudeSession, at };
}

/** What a change says for the log; `none` for no change. */
function noteOf(change: LoginChange): LoginNote | 'none' | undefined {
  return change.kind === 'write' ? change.note : change.kind;
}

/** A lock under which another tab's failure lands first: the one a tab waits for while a dozen fail at once. */
class RacedMutex implements Mutex {
  private readonly files: MemoryFiles;
  private readonly tab: string;

  constructor(files: MemoryFiles, tab: string) {
    this.files = files;
    this.tab = tab;
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    const marker = { expiredAt: AT - 1_000, lastFailAt: AT - 1_000, recoveredAt: undefined, stranded: new Map([[this.tab, AT - 1_000]]) };
    await this.files.write(PATH, formatLoginMarker(marker));
    return task();
  }
}

describe('login store', () => {
  it('takes no lock and writes nothing at a good turn end while no marker exists', async () => {
    const files = new MemoryFiles();
    const lock = new InlineMutex();
    assert.deepEqual(await new LoginStore(files, PATH, lock).apply(answered(TAB_A, AT)), { kind: 'none' });
    assert.equal(lock.runs, 0, 'every turn end of every tab reads the marker; only a change locks it');
    assert.equal(await files.read(PATH), undefined);
  });

  it('writes an auth failure under the lock, and reads back what it wrote', async () => {
    const files = new MemoryFiles();
    const lock = new InlineMutex();
    const store = new LoginStore(files, PATH, lock);
    const change = await store.apply(failed(TAB_A));
    assert.equal(noteOf(change), 'expired');
    assert.equal(lock.runs, 1);
    assert.deepEqual(await store.read(), { expiredAt: AT, lastFailAt: AT, recoveredAt: undefined, stranded: new Map([[TAB_A, AT]]) });
    const recovered = await store.apply(answered(TAB_B, AT + 1_000));
    assert.equal(noteOf(recovered), 'recovered');
    assert.equal((await store.read())?.recoveredAt, AT + 1_000);
    assert.equal(lock.runs, 2);
  });

  it('applies the event to the marker the locked read sees, so a failure another tab wrote meanwhile stays', async () => {
    const files = new MemoryFiles();
    const store = new LoginStore(files, PATH, new RacedMutex(files, TAB_B));
    const change = await store.apply(failed(TAB_A));
    assert.equal(noteOf(change), 'stranded', 'the other tab started the expiry');
    const marker = await store.read();
    assert.deepEqual([marker?.expiredAt, [...(marker?.stranded.keys() ?? [])].sort()], [AT - 1_000, [TAB_A, TAB_B]]);
  });

  it('reads a damaged marker as none, and replaces it at the next auth failure', async () => {
    const files = new MemoryFiles({ [PATH]: '{"expiredAt": "soo' });
    const store = new LoginStore(files, PATH, new InlineMutex());
    assert.equal(await store.read(), undefined);
    assert.deepEqual(await store.apply(answered(TAB_A, AT)), { kind: 'none' });
    await store.apply(failed(TAB_A));
    assert.equal((await store.read())?.expiredAt, AT);
  });
});
