import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CliHarness, TEAM } from '../testing/cli-harness.ts';
import { EXIT } from './runtime.ts';

const START = ['set', 'T2', '--status', 'in-progress', '--session', 'alpha'];
const HOLD = 'T2 is Improvements work and alpha holds Roadmap work that can move: T1; work that first [focus.wip], or, for a one-commit fix, start it with --one-commit';

/** The harness holding alpha's open T1, Roadmap work, and T2, Improvements work. */
async function ranked(kit: CliHarness): Promise<CliHarness> {
  await kit.run(['add', '--title', 'Ship the chart', '--description', 'what and why', '--priority', 'p2', '--class', 'Roadmap', '--session', 'alpha']);
  await kit.run(['add', '--title', 'Tidy the tooling', '--description', 'what and why', '--priority', 'p2', '--class', 'Improvements', '--session', 'alpha']);
  return kit;
}

describe('runCli: set and the WIP rule', () => {
  it('refuses a held start and warns of nothing, as the refusal says it all', async () => {
    const kit = await ranked(new CliHarness());
    const start = await kit.run(START);
    assert.deepEqual([start.code, start.stdout, start.stderr], [EXIT.refused, [`REFUSED ${HOLD}`], []]);
  });

  it('starts a held task with --one-commit, with no warning', async () => {
    const kit = await ranked(new CliHarness());
    const start = await kit.run([...START, '--one-commit']);
    assert.equal(start.code, EXIT.ok, start.stdout.join('\n'));
    assert.match(start.stdout[0] ?? '', /^SET T2 in-progress,/);
    assert.deepEqual(start.stderr, []);
  });

  it('refuses --one-commit with any status but in-progress', async () => {
    const kit = await ranked(new CliHarness());
    const dropped = await kit.run(['set', 'T2', '--status', 'dropped', '--note', 'not needed', '--one-commit', '--session', 'alpha']);
    assert.deepEqual([dropped.code, dropped.stdout], [EXIT.refused, ['REFUSED --one-commit goes only with --status in-progress']]);
  });

  it('starts a held task in warn mode, warning that it did', async () => {
    const kit = await ranked(new CliHarness({ ...TEAM, focus: { wip: { mode: 'warn', maxInProgress: 3 } } }));
    const start = await kit.run(START);
    assert.equal(start.code, EXIT.ok, start.stdout.join('\n'));
    assert.deepEqual(start.stderr, [`WARN ${HOLD}; started anyway, as focus.wip.mode is warn`]);
  });

  it('takes --one-commit in warn mode with no warning, as nothing held the start', async () => {
    const kit = await ranked(new CliHarness({ ...TEAM, focus: { wip: { mode: 'warn', maxInProgress: 3 } } }));
    assert.deepEqual((await kit.run([...START, '--one-commit'])).stderr, []);
  });

  it('says nothing with the rule off', async () => {
    const kit = await ranked(new CliHarness({ ...TEAM, focus: { wip: { mode: 'off', maxInProgress: 3 } } }));
    const start = await kit.run(START);
    assert.deepEqual([start.code, start.stderr], [EXIT.ok, []]);
  });
});
