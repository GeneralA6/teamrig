import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CliHarness, TEAM } from '../testing/cli-harness.ts';

const QUIET = { startUtc: '20:00', endUtc: '04:00' };

describe('teamrig doctor: quiet hours that ask before a helper launch', () => {
  it("reads the team config's budget, and flags quiet hours whose action is ask with block as the fix", async () => {
    const kit = new CliHarness({ ...TEAM, budget: { enabled: true, quietHours: { ...QUIET, action: 'ask' } } });
    await kit.holdSecretDeny();
    const { stdout } = await kit.run(['doctor']);
    assert.equal(stdout[0], 'DOCTOR 1 finding(s), team app');
    assert.match(stdout[1] ?? '', /^WARN quiet-ask budget\.quietHours\.action is ask, so in the quiet hours \(.+\) a helper launch waits on a permission prompt /);
    assert.match(stdout[1] ?? '', /: set budget\.quietHours\.action to block, /);
  });

  it('stays clean when the quiet hours block', async () => {
    const kit = new CliHarness({ ...TEAM, budget: { enabled: true, quietHours: { ...QUIET, action: 'block' } } });
    await kit.holdSecretDeny();
    assert.deepEqual((await kit.run(['doctor'])).stdout, ['DOCTOR clean, team app']);
  });
});
