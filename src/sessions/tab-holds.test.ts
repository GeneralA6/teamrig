import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { FakeClock } from '../testing/fake-clock.ts';
import { MemoryFiles } from '../testing/memory-files.ts';
import { TabHolds, tabHoldsDir, type TabHold } from './tab-holds.ts';

const DIR = tabHoldsDir('/kit/host.lock');

function holdOf(fields: Partial<TabHold> = {}): TabHold {
  return {
    id: 'h1',
    team: 'alpha',
    session: 'web',
    needMb: 900,
    needCommittedMb: 1800,
    openedAt: '2030-01-08T09:58:00.000Z',
    expiresAt: '2030-01-08T10:03:00.000Z',
    ...fields,
  };
}

function fileOf(hold: TabHold): [string, string] {
  return [join(DIR, `${hold.id}.json`), JSON.stringify(hold)];
}

/** The holds over `initial`, at 10:00 UTC. */
function world(initial: Readonly<Record<string, string>> = {}): { readonly files: MemoryFiles; readonly holds: TabHolds } {
  const files = new MemoryFiles(initial);
  return { files, holds: new TabHolds(DIR, { files, clock: new FakeClock('2030-01-08T10:00:00Z') }) };
}

describe('TabHolds', () => {
  it('keeps the holds beside the host lock', () => {
    assert.equal(DIR, '/kit/host.lock.tabs');
  });

  it('lists none while no tab was opened', async () => {
    assert.deepEqual(await world().holds.live(), []);
  });

  it('lists the holds added, oldest first', async () => {
    const { holds } = world();
    const later = holdOf({ id: 'h2', session: 'api', openedAt: '2030-01-08T09:59:00.000Z' });
    await holds.add(later);
    await holds.add(holdOf());
    assert.deepEqual(await holds.live(), [holdOf(), later]);
  });

  for (const [label, text] of [
    ['that ran out', JSON.stringify(holdOf({ expiresAt: '2030-01-08T10:00:00.000Z' }))],
    ['that cannot be read', '{"id'],
    ['that is not a hold', JSON.stringify({ ...holdOf(), needMb: -1 })],
  ] as const) {
    it(`removes a hold ${label} and lists the others`, async () => {
      const kept = holdOf({ id: 'h2' });
      const { files, holds } = world({ [join(DIR, 'h1.json')]: text, ...Object.fromEntries([fileOf(kept)]) });
      assert.deepEqual([await holds.live(), files.get(join(DIR, 'h1.json'))], [[kept], undefined]);
    });
  }

  it("passes over a writer's temporary sibling", async () => {
    const [path, text] = fileOf(holdOf());
    const { files, holds } = world({ [`${path}.4242.1.tmp`]: text });
    assert.deepEqual([await holds.live(), files.get(`${path}.4242.1.tmp`)], [[], text]);
  });

  it('removes a hold by its id, and nothing once it is gone', async () => {
    const { files, holds } = world(Object.fromEntries([fileOf(holdOf())]));
    await holds.remove('h1');
    await holds.remove('h1');
    assert.deepEqual([files.get(join(DIR, 'h1.json')), await holds.live()], [undefined, []]);
  });
});
