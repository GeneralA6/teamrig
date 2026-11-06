import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { teamPaths } from '../core/home.ts';
import { FakeProcesses } from '../testing/fake-processes.ts';
import { MemoryFiles } from '../testing/memory-files.ts';
import { startDailyRollup } from './rollup-start.ts';

const KIT = { paths: teamPaths('/kit', 'app', '/claude') };
const TEN_UTC = Date.parse('2030-01-08T10:00:00.000Z');

function worldOf(): { readonly files: MemoryFiles; readonly processes: FakeProcesses; readonly runtime: Parameters<typeof startDailyRollup>[0] } {
  const files = new MemoryFiles();
  const processes = new FakeProcesses();
  return { files, processes, runtime: { files, processes, self: { node: 'node', script: 'main.js' }, cwd: '/work', env: {} } };
}

describe('startDailyRollup', () => {
  it('starts one run when many tabs check at once, as a restore does', async () => {
    const { processes, runtime } = worldOf();
    await Promise.all(['alpha', 'bravo', 'charlie'].map((session) => startDailyRollup(runtime, KIT, session, '06:00', TEN_UTC)));
    assert.equal(processes.hidden.length, 1);
  });

  it('counts a check before the day start as the day before', async () => {
    const { files, runtime } = worldOf();
    await startDailyRollup(runtime, KIT, 'alpha', '12:00', TEN_UTC);
    assert.deepEqual(await files.list(KIT.paths.rollup), ['2030-01-07.started']);
  });

  it('starts none for a malformed day start', async () => {
    const { processes, runtime } = worldOf();
    await startDailyRollup(runtime, KIT, 'alpha', 'dawn', TEN_UTC);
    assert.deepEqual(processes.hidden, []);
  });
});
