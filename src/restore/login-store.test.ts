import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { Mutex } from '../core/lock.ts';
import { InlineMutex } from '../testing/inline-mutex.ts';
import { MemoryFiles } from '../testing/memory-files.ts';
import { formatLoginMarker, loginMarkerPath, type LoginChange, type LoginEvent, type LoginMarker, type LoginNote } from './login.ts';
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

/** A lock under which another tab's write lands first: the one a tab waits for while a dozen fail at once. */
class RacedMutex implements Mutex {
  private readonly files: MemoryFiles;
  private readonly marker: LoginMarker;

  constructor(files: MemoryFiles, marker: LoginMarker) {
    this.files = files;
    this.marker = marker;
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.files.write(PATH, formatLoginMarker(this.marker));
    return task();
  }
}

/** The marker another tab's failure at `at` wrote, with the page it claimed, if any. */
function otherTabFailed(tab: string, at: number, pagedAt: number | undefined = undefined): LoginMarker {
  return { expiredAt: at, lastFailAt: at, recoveredAt: undefined, stranded: new Map([[tab, at]]), pagedAt };
}

describe('login store', () => {
  it('takes no lock and writes nothing at a good turn end while no marker exists', async () => {
    const files = new MemoryFiles();
    const lock = new InlineMutex();
    assert.deepEqual(await new LoginStore(files, PATH, lock).apply(answered(TAB_A, AT)), { change: { kind: 'none' }, pageClaimed: false });
    assert.equal(lock.runs, 0, 'every turn end of every tab reads the marker; only a change locks it');
    assert.equal(await files.read(PATH), undefined);
  });

  it('writes an auth failure under the lock, and reads back what it wrote', async () => {
    const files = new MemoryFiles();
    const lock = new InlineMutex();
    const store = new LoginStore(files, PATH, lock);
    const { change, pageClaimed } = await store.apply(failed(TAB_A));
    assert.deepEqual([noteOf(change), pageClaimed], ['expired', false], 'no page is claimed unless asked');
    assert.equal(lock.runs, 1);
    assert.deepEqual(await store.read(), { expiredAt: AT, lastFailAt: AT, recoveredAt: undefined, stranded: new Map([[TAB_A, AT]]), pagedAt: undefined });
    const recovered = await store.apply(answered(TAB_B, AT + 1_000));
    assert.equal(noteOf(recovered.change), 'recovered');
    assert.equal((await store.read())?.recoveredAt, AT + 1_000);
    assert.equal(lock.runs, 2);
  });

  it('applies the event to the marker the locked read sees, so a failure another tab wrote meanwhile stays', async () => {
    const files = new MemoryFiles();
    const store = new LoginStore(files, PATH, new RacedMutex(files, otherTabFailed(TAB_B, AT - 1_000)));
    const { change } = await store.apply(failed(TAB_A));
    assert.equal(noteOf(change), 'stranded', 'the other tab started the expiry');
    const marker = await store.read();
    assert.deepEqual([marker?.expiredAt, [...(marker?.stranded.keys() ?? [])].sort()], [AT - 1_000, [TAB_A, TAB_B]]);
  });

  it("claims the owner's page in the same locked write, once for failures in a row", async () => {
    const files = new MemoryFiles();
    const store = new LoginStore(files, PATH, new InlineMutex());
    const first = await store.apply(failed(TAB_A), { claimPage: true });
    assert.equal(first.pageClaimed, true);
    assert.equal(first.change.kind === 'write' ? first.change.marker.pagedAt : undefined, AT, 'the change carries the marker as written');
    assert.equal((await store.read())?.pagedAt, AT);
    const second = await store.apply(failed(TAB_B, AT + 1_000), { claimPage: true });
    assert.deepEqual([noteOf(second.change), second.pageClaimed], ['stranded', false]);
    assert.equal((await store.read())?.pagedAt, AT, 'the first claim stands');
  });

  it('claims no page another tab claimed while this one waited for the lock, nor one while the login works', async () => {
    const files = new MemoryFiles();
    const raced = new LoginStore(files, PATH, new RacedMutex(files, otherTabFailed(TAB_B, AT - 1_000, AT - 1_000)));
    assert.equal((await raced.apply(failed(TAB_A), { claimPage: true })).pageClaimed, false);
    const recovered = new LoginStore(new MemoryFiles(), PATH, new InlineMutex());
    await recovered.apply(failed(TAB_A));
    await recovered.apply(answered(TAB_A, AT + 1_000));
    // A failure from before the recovery, reported late, only strands its tab: the login works, so no one is paged.
    assert.equal((await recovered.apply(failed(TAB_B, AT + 500), { claimPage: true })).pageClaimed, false);
  });

  it('gives back only its own claim after a failed page, so the next failure pages', async () => {
    const files = new MemoryFiles();
    const lock = new InlineMutex();
    const store = new LoginStore(files, PATH, lock);
    await store.apply(failed(TAB_A), { claimPage: true });
    assert.equal(await store.releasePage(AT + 1), false, "another claim's time gives back nothing");
    assert.equal((await store.read())?.pagedAt, AT);
    assert.equal(await store.releasePage(AT), true);
    assert.equal((await store.read())?.pagedAt, undefined);
    assert.equal((await store.apply(failed(TAB_B, AT + 1_000), { claimPage: true })).pageClaimed, true);
    assert.equal(await new LoginStore(new MemoryFiles(), PATH, lock).releasePage(AT), false, 'no marker, nothing to give back');
  });

  it('reads a damaged marker as none, and replaces it at the next auth failure', async () => {
    const files = new MemoryFiles({ [PATH]: '{"expiredAt": "soo' });
    const store = new LoginStore(files, PATH, new InlineMutex());
    assert.equal(await store.read(), undefined);
    assert.deepEqual(await store.apply(answered(TAB_A, AT)), { change: { kind: 'none' }, pageClaimed: false });
    await store.apply(failed(TAB_A));
    assert.equal((await store.read())?.expiredAt, AT);
  });
});
