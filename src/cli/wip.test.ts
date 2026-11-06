import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { JsonRecord } from '../core/guards.ts';
import { storeTaskSpend } from '../testing/budget-hold.ts';
import { CliHarness, TEAM, TEAM_HOME } from '../testing/cli-harness.ts';
import { FaultyFiles, systemError } from '../testing/faulty-files.ts';
import { treeHarness } from '../testing/team-tree.ts';
import { EXIT } from './runtime.ts';

const START = ['set', 'T2', '--status', 'in-progress', '--session', 'alpha'];
const HOLD = 'T2 is Improvements work and alpha holds Roadmap work that can move: T1; work that first [focus.wip], or, for a one-commit fix, start it with --one-commit';
const SPENT_HOLD = "T1 is Improvements work and Improvements has spent its share of the week [focus.allocation]: it waits for the week's reset, or, for a one-commit fix, start it with --one-commit";
const START_T1 = ['set', 'T1', '--status', 'in-progress', '--session', 'alpha'];
/** 1% of the week is 10M W, so Improvements' 15% is 150M W. */
const LIMITED: JsonRecord = { ...TEAM, budget: { weeklyLimitW: 1_000_000_000 } };
const WARNED: JsonRecord = { ...LIMITED, focus: { wip: { mode: 'warn', maxInProgress: 3 } } };

/** The harness holding alpha's open T1, Improvements work, with `w` W stored on it this week. */
async function spentOn(kit: CliHarness, w = 150_000_000): Promise<CliHarness> {
  await kit.run(['add', '--title', 'Tidy the tooling', '--description', 'what and why', '--priority', 'p2', '--class', 'Improvements', '--session', 'alpha']);
  await storeTaskSpend(kit, 'alpha', 'T1', w);
  return kit;
}

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

  it('counts Roadmap work planned after a task another team of the tree holds as unable to move', async () => {
    const kit = await treeHarness({ focus: { wip: { mode: 'warn', maxInProgress: 3 } } });
    await kit.run(['add', '--title', 'Build the feed', '--description', 'what and why', '--priority', 'p2', '--owner', 'front', '--session', 'lead'], { env: { TEAMRIG_TEAM: 'web' } });
    await kit.run(['add', '--title', 'Ship the chart', '--description', 'what and why', '--priority', 'p2', '--class', 'Roadmap', '--after', 'T1', '--session', 'alpha']);
    await kit.run(['add', '--title', 'Tidy the tooling', '--description', 'what and why', '--priority', 'p2', '--class', 'Improvements', '--session', 'alpha']);
    const start = await kit.run(['set', 'T3', '--status', 'in-progress', '--session', 'alpha']);
    assert.deepEqual([start.code, start.stderr], [EXIT.ok, []]);
  });
});

describe('runCli: set and a class past its share of the week', () => {
  it('refuses a start of a spent class', async () => {
    const kit = await spentOn(new CliHarness(LIMITED));
    const start = await kit.run(START_T1);
    assert.deepEqual([start.code, start.stdout, start.stderr], [EXIT.refused, [`REFUSED ${SPENT_HOLD}`], []]);
  });

  it('starts a class short of its share', async () => {
    const kit = await spentOn(new CliHarness(LIMITED), 149_000_000);
    const start = await kit.run(START_T1);
    assert.deepEqual([start.code, start.stderr], [EXIT.ok, []]);
  });

  it('starts a spent class with --one-commit', async () => {
    const kit = await spentOn(new CliHarness(LIMITED));
    const start = await kit.run([...START_T1, '--one-commit']);
    assert.deepEqual([start.code, start.stderr], [EXIT.ok, []]);
  });

  it('starts a spent class in warn mode, warning that it did', async () => {
    const kit = await spentOn(new CliHarness(WARNED));
    const start = await kit.run(START_T1);
    assert.equal(start.code, EXIT.ok, start.stdout.join('\n'));
    assert.deepEqual(start.stderr, [`WARN ${SPENT_HOLD}; started anyway, as focus.wip.mode is warn`]);
  });

  it('starts anything once the week has reset', async () => {
    const kit = await spentOn(new CliHarness(LIMITED));
    kit.clock.advance(Date.parse('2030-01-14T02:00:00Z') - kit.clock.now());
    const start = await kit.run(START_T1);
    assert.deepEqual([start.code, start.stderr], [EXIT.ok, []]);
  });

  it('still starts the task when the usage store cannot be read, and says the share went unread', async () => {
    const kit = await spentOn(new CliHarness(LIMITED));
    const files = new FaultyFiles(kit.files).fail('read', join(TEAM_HOME, 'state', 'usage', 'alpha.json'), systemError('EIO'));
    const start = await kit.run(START_T1, { files });
    assert.equal(start.code, EXIT.ok, start.stdout.join('\n'));
    assert.equal(start.stderr.length, 1);
    assert.match(start.stderr[0] ?? '', /^WARN the week's spend by class could not be read/);
  });

  it('reads no usage with the rule off', async () => {
    const kit = await spentOn(new CliHarness({ ...LIMITED, focus: { wip: { mode: 'off', maxInProgress: 3 } } }));
    const files = new FaultyFiles(kit.files).fail('read', join(TEAM_HOME, 'state', 'usage', 'alpha.json'), systemError('EIO'));
    const start = await kit.run(START_T1, { files });
    assert.deepEqual([start.code, start.stderr], [EXIT.ok, []]);
  });

  it('reads no usage for any status but in-progress', async () => {
    const kit = await spentOn(new CliHarness(LIMITED));
    const files = new FaultyFiles(kit.files).fail('read', join(TEAM_HOME, 'state', 'usage', 'alpha.json'), systemError('EIO'));
    const dropped = await kit.run(['set', 'T1', '--status', 'dropped', '--note', 'not needed', '--session', 'alpha'], { files });
    assert.deepEqual(dropped.stderr, []);
  });
});
