import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { MemoryFiles } from '../testing/memory-files.ts';
import { RefreshStore } from './store.ts';

const PATHS = { refresh: join('/', 'team', 'state', 'refresh'), handover: join('/', 'team', 'handover') };
const AT = '2030-01-08T10:00:00.000Z';

describe('RefreshStore', () => {
  it("keeps each session's state, and has none before the first write", async () => {
    const files = new MemoryFiles();
    const store = new RefreshStore(files, PATHS);
    assert.equal(await store.state('alpha'), undefined);
    await store.setState('alpha', { phase: 'boundary', task: 'T3', at: AT });
    assert.deepEqual(await store.state('alpha'), { phase: 'boundary', task: 'T3', at: AT });
    assert.equal(await store.state('bravo'), undefined);
    assert.equal(files.paths().length, 1);
    assert.match(files.get(join(PATHS.refresh, 'alpha.json')) ?? '', /"phase":"boundary"/);
  });

  it("keeps the lead's request in a file of its own, so neither write overwrites the other", async () => {
    const files = new MemoryFiles();
    const store = new RefreshStore(files, PATHS);
    await store.setState('alpha', { phase: 'boundary', task: 'T3', at: AT });
    assert.equal(await store.request('alpha'), undefined);
    await store.setRequest('alpha', { by: 'lead', at: AT });
    assert.deepEqual(await store.request('alpha'), { by: 'lead', at: AT });
    assert.deepEqual(await store.state('alpha'), { phase: 'boundary', task: 'T3', at: AT });
    await store.clearRequest('alpha');
    await store.clearRequest('alpha');
    assert.equal(await store.request('alpha'), undefined);
  });

  it('reads the handover from the handover folder', async () => {
    const files = new MemoryFiles();
    const store = new RefreshStore(files, PATHS);
    assert.equal(store.handoverPath('alpha'), join(PATHS.handover, 'alpha.md'));
    assert.equal(await store.handover('alpha'), undefined);
    await files.write(store.handoverPath('alpha'), '# In progress\n');
    assert.equal(await store.handover('alpha'), '# In progress\n');
  });
});
