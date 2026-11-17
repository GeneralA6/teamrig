import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CliHarness, TEAM } from '../testing/cli-harness.ts';
import { EXIT } from './runtime.ts';

const AS_LEAD = { env: { TEAMRIG_SESSION: 'lead' } };

function add(title: string, ...more: string[]): string[] {
  return ['add', '--title', title, '--description', `${title}: what and why`, '--priority', 'p2', ...more];
}

async function ok(kit: CliHarness, argv: readonly string[]): Promise<void> {
  const result = await kit.run([...argv], AS_LEAD);
  assert.equal(result.code, EXIT.ok, [...result.stdout, ...result.stderr].join('\n'));
}

describe('teamrig check: a goal tag with no goal record (#846)', () => {
  it('flags UNKNOWN-GOAL on an active task naming an unrecorded tag, once the team records a goal', async () => {
    const kit = new CliHarness(TEAM);
    await ok(kit, ['goal', 'add', 'A1', '--title', 'Ship the beta', '--target', '2030-02-01', '--session', 'lead']);
    await ok(kit, add('On a recorded goal', '--goals', 'A1'));
    await ok(kit, add('On a typo', '--goals', 'A1,B9'));
    await ok(kit, add('Finished on a typo', '--goals', 'B9'));
    await ok(kit, ['set', 'T3', '--status', 'dropped', '--note', 'not needed', '--session', 'lead']);
    const result = await kit.run(['check', '--all'], AS_LEAD);
    const flagged = result.stdout.filter((line) => line.includes('UNKNOWN-GOAL'));
    assert.equal(flagged.length, 1, result.stdout.join('\n'));
    assert.match(flagged[0] ?? '', /^UNKNOWN-GOAL \(goal B9 has no goal record \(recorded: A1\): .*update T2 --goals .*\) T2 open, .*\| On a typo$/u);
  });

  it('flags no tag while the team records no goal, as any tag is taken then', async () => {
    const kit = new CliHarness(TEAM);
    await ok(kit, add('On a free tag', '--goals', 'B9'));
    const result = await kit.run(['check', '--all'], AS_LEAD);
    assert.equal(result.stdout.filter((line) => line.includes('UNKNOWN-GOAL')).length, 0, result.stdout.join('\n'));
  });
});
