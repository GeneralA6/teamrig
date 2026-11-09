import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FakeClock } from '../testing/fake-clock.ts';
import { MemoryFiles } from '../testing/memory-files.ts';
import { ADMIT_TTL_MS, AdmitFile } from './admit-file.ts';

const PATH = '/kit/host.lock.admit';
const ME = 4242;
const OTHER = 5151;
const GONE = 7;

/** An admit file over `initial`, at 10:00 UTC, in which ME and OTHER run and GONE does not. */
function world(initial: Readonly<Record<string, string>> = {}): { readonly files: MemoryFiles; readonly clock: FakeClock; readonly admit: AdmitFile } {
  const files = new MemoryFiles(initial);
  const clock = new FakeClock('2030-01-08T10:00:00Z');
  const admit = new AdmitFile(PATH, { files, clock, pid: ME, alive: (pid) => pid !== GONE });
  return { files, clock, admit };
}

function claimOf(ticket: string, pid: number, expiresAt: string): string {
  return JSON.stringify({ ticket, pid, expiresAt });
}

describe('AdmitFile', () => {
  it('claims a free file for 30 s, naming the admission and its process, and gives back the text it wrote', async () => {
    const { files, admit } = world();
    const claim = await admit.claim('t1');
    assert.equal(ADMIT_TTL_MS, 30_000);
    assert.deepEqual([claim, files.get(PATH)], [claimOf('t1', ME, '2030-01-08T10:00:30.000Z'), claimOf('t1', ME, '2030-01-08T10:00:30.000Z')]);
  });

  it("claims nothing while another live admission's claim holds the file, leaving that claim", async () => {
    const other = claimOf('bravo', OTHER, '2030-01-08T10:00:20.000Z');
    const { files, admit } = world({ [PATH]: other });
    assert.deepEqual([await admit.claim('t1'), files.get(PATH)], [undefined, other]);
  });

  for (const [label, dead] of [
    ['whose process is gone', claimOf('bravo', GONE, '2030-01-08T10:00:20.000Z')],
    ['that ran out', claimOf('bravo', OTHER, '2030-01-08T10:00:00.000Z')],
    ['that cannot be read', '{"tick'],
    ['that is not a claim', JSON.stringify({ ticket: 'bravo', pid: OTHER, expiresAt: 'soon' })],
  ] as const) {
    it(`removes a claim ${label} and claims the file`, async () => {
      const { files, admit } = world({ [PATH]: dead });
      const claim = await admit.claim('t1');
      assert.deepEqual([claim, files.get(PATH)], [claimOf('t1', ME, '2030-01-08T10:00:30.000Z'), claim]);
    });
  }

  it('releases its own claim', async () => {
    const { files, admit } = world();
    const claim = await admit.claim('t1');
    assert.ok(claim !== undefined);
    await admit.release(claim);
    assert.equal(files.get(PATH), undefined);
  });

  it('leaves a claim another admission wrote once its own ran out', async () => {
    const { files, clock, admit } = world();
    const claim = await admit.claim('t1');
    assert.ok(claim !== undefined);
    clock.advance(ADMIT_TTL_MS);
    const later = new AdmitFile(PATH, { files, clock, pid: OTHER, alive: () => true });
    const theirs = await later.claim('bravo');
    await admit.release(claim);
    assert.deepEqual([theirs, files.get(PATH)], [claimOf('bravo', OTHER, '2030-01-08T10:01:00.000Z'), theirs]);
  });
});
