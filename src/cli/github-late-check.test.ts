import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { formatClocks, type Clock } from '../github/clock.ts';
import { MS_PER_HOUR } from '../core/time.ts';
import { CliHarness, TEAM, TEAM_HOME, type RunOptions } from '../testing/cli-harness.ts';
import { EXIT } from './runtime.ts';

const AS_ALPHA: RunOptions = { env: { TEAMRIG_SESSION: 'alpha' } };
const AS_LEAD: RunOptions = { env: { TEAMRIG_SESSION: 'lead' } };
const CLOCKS = join(TEAM_HOME, 'state', 'github-clocks.json');

function clocks(...list: readonly Clock[]): string {
  return formatClocks(new Map(list.map((clock) => [clock.ref, clock])));
}

async function lateRows(kit: CliHarness): Promise<string[]> {
  const result = await kit.run(['check', '--all'], AS_LEAD);
  assert.equal(result.code, EXIT.ok, result.stderr.join('\n'));
  return result.stdout.filter((line) => line.includes('the response clock'));
}

describe('check GH-LATE (T3028)', () => {
  const bug = (since: number): Clock => ({ repo: 'acme/web', ref: 'gh:acme/web#9', kind: 'bug', owner: 'alpha', since, remindedAt: undefined });

  it('flags a thread past its target for the lead, not one inside it, nor with no clocks file', async () => {
    const kit = new CliHarness(TEAM);
    assert.deepEqual(await lateRows(kit), []);
    const now = kit.clock.now();
    await kit.files.write(CLOCKS, clocks(bug(now - 24 * MS_PER_HOUR + 1), { ...bug(now - 4 * MS_PER_HOUR), ref: 'gh:acme/web#2', kind: 'security', owner: 'bravo' }));
    const rows = await lateRows(kit);
    assert.equal(rows.length, 1, rows.join('\n'));
    assert.match(rows[0] ?? '', /GH-LATE gh:acme\/web#2 \(security, bravo\) has waited 4 h for an answer of ours since .+, past its 4 h target: have bravo answer it on GitHub/);
  });

  it('tells the lead once a wait, and again for a fresh wait', async () => {
    const kit = new CliHarness(TEAM);
    const now = kit.clock.now();
    const told = async (): Promise<number> => {
      assert.equal((await kit.run(['start'], AS_ALPHA)).code, EXIT.ok);
      const inbox = (await kit.files.read(join(TEAM_HOME, 'state', 'inbox', 'lead.md'))) ?? '';
      return inbox.split('\n').filter((line) => line.includes('GH-LATE gh:acme/web#9')).length;
    };
    await kit.files.write(CLOCKS, clocks(bug(now - 25 * MS_PER_HOUR)));
    assert.equal(await told(), 1);
    assert.equal(await told(), 1);
    await kit.files.write(CLOCKS, clocks(bug(now - 24 * MS_PER_HOUR)));
    assert.equal(await told(), 2);
  });
});
