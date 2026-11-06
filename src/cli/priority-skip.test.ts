import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MS_PER_HOUR } from '../core/time.ts';
import { CliHarness } from '../testing/cli-harness.ts';
import { treeHarness } from '../testing/team-tree.ts';
import { EXIT } from './runtime.ts';

const SKIP = 'PRIORITY-SKIP (T2 (Roadmap, score 10) waits open, skipped since 01-08 10:00 UTC) T1 in-progress, Improvements, score 3.33,';

/** Whether `lines` hold the flag: its reason and the task it falls on, as the rest of a row is the row's own spec. */
function flagged(lines: readonly string[]): boolean {
  return lines.some((line) => line.startsWith(SKIP));
}

/** The harness where alpha works on T1, Improvements work, and T2, Roadmap work, came in after that start. */
async function skipping(): Promise<CliHarness> {
  const kit = new CliHarness();
  await kit.run(['add', '--title', 'Tidy the tooling', '--description', 'what and why', '--priority', 'p2', '--class', 'Improvements', '--session', 'alpha']);
  const started = await kit.run(['set', 'T1', '--status', 'in-progress', '--session', 'alpha']);
  assert.equal(started.code, EXIT.ok, started.stdout.join('\n'));
  await kit.run(['add', '--title', 'Ship the chart', '--description', 'what and why', '--priority', 'p2', '--class', 'Roadmap', '--session', 'alpha']);
  return kit;
}

// The flag reads only a ranked tree, so a command that lost its ranking would go silent, not fail: these run the real
// commands, as the specs of checkTasks hand it a ranking themselves.
describe('runCli: PRIORITY-SKIP reads the team ranking', () => {
  it('raises the flag on a real check once the better task has waited past the limit', async () => {
    const kit = await skipping();
    kit.clock.advance(25 * MS_PER_HOUR);
    const checked = await kit.run(['check', '--all', '--session', 'lead']);
    assert.equal(checked.code, EXIT.ok, checked.stderr.join('\n'));
    assert.ok(flagged(checked.stdout), checked.stdout.join('\n'));
  });

  it('raises nothing inside the limit', async () => {
    const kit = await skipping();
    kit.clock.advance(23 * MS_PER_HOUR);
    const checked = await kit.run(['check', '--all', '--session', 'lead']);
    assert.deepEqual(checked.stdout.filter((line) => line.startsWith('PRIORITY-SKIP')), []);
  });

  it("shows the flag in the owner's own start", async () => {
    const kit = await skipping();
    kit.clock.advance(25 * MS_PER_HOUR);
    const started = await kit.run(['start', '--all', '--session', 'alpha']);
    assert.ok(flagged(started.stdout), started.stdout.join('\n'));
  });

  it("reads a child team's tasks in check --tree by that team's own ranking", async () => {
    const kit = await treeHarness();
    const web = { env: { TEAMRIG_TEAM: 'web' } };
    await kit.run(['add', '--title', 'Tidy the tooling', '--description', 'what and why', '--priority', 'p2', '--class', 'Improvements', '--session', 'front'], web);
    await kit.run(['set', 'T1', '--status', 'in-progress', '--session', 'front'], web);
    await kit.run(['add', '--title', 'Ship the chart', '--description', 'what and why', '--priority', 'p2', '--class', 'Roadmap', '--session', 'front'], web);
    kit.clock.advance(25 * MS_PER_HOUR);
    const checked = await kit.run(['check', '--tree', '--all', '--session', 'lead']);
    assert.equal(checked.code, EXIT.ok, checked.stderr.join('\n'));
    assert.match(checked.stdout.join('\n'), /PRIORITY-SKIP \(T2 \(Roadmap, score 10\) waits open/);
  });
});
