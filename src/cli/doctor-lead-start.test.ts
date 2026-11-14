import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { CliHarness, TEAM_HOME } from '../testing/cli-harness.ts';
import { worstCaseConfig } from '../testing/worst-config.ts';

const RULES = join(TEAM_HOME, 'rules.md');

async function leadStartLines(kit: CliHarness): Promise<string[]> {
  await kit.holdSecretDeny();
  await kit.files.write(RULES, 'x'.repeat(1_500));
  return (await kit.run(['doctor'])).stdout.filter((line) => line.startsWith('WARN lead-start'));
}

describe('teamrig doctor: the lead start (T2231)', () => {
  it("flags a rules.md the team rules share holds that the real lead start shows only as a pointer, every config value at its longest", async () => {
    const found = await leadStartLines(new CliHarness(JSON.stringify(worstCaseConfig())));
    assert.equal(found.length, 1, found.join('\n'));
    assert.match(found[0] ?? '', /^WARN lead-start .*rules\.md reaches the lead l{32} only as a pointer: its start keeps [\d,]+ characters for the team rules files /);
  });

  it('stays quiet for the same rules.md beside a plain lead start, which shows it in full', async () => {
    assert.deepEqual(await leadStartLines(new CliHarness()), []);
  });
});
