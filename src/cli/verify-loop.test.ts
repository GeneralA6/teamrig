import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CliHarness } from '../testing/cli-harness.ts';
import { EXIT } from './runtime.ts';

/** A harness holding T1, owned by alpha and in progress. */
async function startedTask(): Promise<CliHarness> {
  const kit = new CliHarness();
  await kit.run(['add', '--title', 'Ship the CLI', '--priority', 'p2', '--session', 'alpha']);
  await kit.run(['set', 'T1', '--status', 'in-progress', '--session', 'alpha']);
  return kit;
}

describe('runCli: set verifying names its proof', () => {
  it('refuses verifying without --proof, then shows the proof it was set with', async () => {
    const kit = await startedTask();
    const bare = await kit.run(['set', 'T1', '--status', 'verifying', '--note', 'shipped', '--session', 'alpha']);
    assert.deepEqual([bare.code, bare.stdout], [EXIT.refused, ['REFUSED verifying needs --proof saying what will prove the shipped change works']]);

    const set = await kit.run(['set', 'T1', '--status', 'verifying', '--note', 'shipped', '--proof', 'the nightly run is green', '--session', 'alpha']);
    assert.equal(set.code, EXIT.ok, set.stdout.join('\n'));
    assert.match(set.stdout[0] ?? '', /^SET T1 verifying, .*\(proof: the nightly run is green\)$/);
    const shown = await kit.run(['show', 'T1', '--session', 'alpha']);
    assert.match(shown.stdout.join('\n'), /\nproof: the nightly run is green\n[\s\S]*status verifying note="shipped" proof="the nightly run is green"/);
  });

  it('takes the date to verify by as --due', async () => {
    const kit = await startedTask();
    const set = await kit.run(['set', 'T1', '--status', 'verifying', '--note', 'shipped', '--proof', 'the nightly run', '--due', '2030-01-09', '--session', 'alpha']);
    assert.equal(set.code, EXIT.ok, set.stdout.join('\n'));
    assert.match(set.stdout[0] ?? '', /^SET T1 verifying, p2, owner alpha, due 01-09,/);
  });
});
