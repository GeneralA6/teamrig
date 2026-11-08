import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { OUTSIDE_ID, outsideUsageDir } from '../budget/measure.ts';
import type { JsonRecord } from '../core/guards.ts';
import { storeTaskSpend } from '../testing/budget-hold.ts';
import { CliHarness, TEAM, TEAM_HOME } from '../testing/cli-harness.ts';
import { FaultyFiles, systemError } from '../testing/faulty-files.ts';
import { readSpentClasses } from './class-share.ts';
import { openTeam } from './commands/register-team.ts';

/** 1% of the week is 10M W, so Improvements' 15% is 150M W. */
const LIMITED: JsonRecord = { ...TEAM, budget: { weeklyLimitW: 1_000_000_000 } };
/** A share that is spent before any W, so a read with no week or no rate shows it held nothing. */
const NO_SHARE: JsonRecord = { focus: { allocation: { Roadmap: 75, Maintenance: 25, Improvements: 0 } } };
const USAGE = join(TEAM_HOME, 'state', 'usage');
const TASKS = [{ id: 'T2', workClass: 'Improvements' }];

interface Read {
  readonly spent: readonly string[];
  readonly warnings: readonly string[];
}

/** What `readSpentClasses` gives in `kit`'s team, through `files` when given, and what it warned. */
async function read(kit: CliHarness, files?: FaultyFiles): Promise<Read> {
  const warnings: string[] = [];
  const runtime = kit.runtime(files === undefined ? {} : { files }, { stdout: () => undefined, stderr: (line) => warnings.push(line) });
  const { paths, config } = await openTeam(runtime, 'read');
  return { spent: [...(await readSpentClasses(runtime, paths, config, TASKS, kit.clock.now()))], warnings };
}

describe('readSpentClasses', () => {
  it("names a class whose stored W has reached its share of the week, at the budget's rate", async () => {
    const kit = new CliHarness(LIMITED);
    await storeTaskSpend(kit, 'alpha', 'T2', 150_000_000);
    assert.deepEqual(await read(kit), { spent: ['Improvements'], warnings: [] });
  });

  it('adds the sessions up, and names no class short of its share', async () => {
    const kit = new CliHarness(LIMITED);
    await storeTaskSpend(kit, 'alpha', 'T2', 100_000_000);
    assert.deepEqual((await read(kit)).spent, []);
    await storeTaskSpend(kit, 'bravo', 'T2', 50_000_000);
    assert.deepEqual((await read(kit)).spent, ['Improvements']);
  });

  it('counts no use outside the team, as the rows of teamrig budget do not', async () => {
    const kit = new CliHarness(LIMITED);
    await storeTaskSpend(kit, OUTSIDE_ID, 'T2', 150_000_000, outsideUsageDir(USAGE));
    assert.deepEqual((await read(kit)).spent, []);
  });

  it('names nothing while the week is unknown', async () => {
    const kit = new CliHarness({ ...LIMITED, ...NO_SHARE });
    assert.deepEqual(await read(kit), { spent: [], warnings: [] });
  });

  it('names nothing while the rate is unknown', async () => {
    const kit = new CliHarness({ ...TEAM, ...NO_SHARE });
    await storeTaskSpend(kit, 'alpha', 'T1', 0);
    assert.deepEqual(await read(kit), { spent: [], warnings: [] });
  });

  it('names nothing and warns when the usage store cannot be read', async () => {
    const kit = new CliHarness(LIMITED);
    await storeTaskSpend(kit, 'alpha', 'T2', 150_000_000);
    const { spent, warnings } = await read(kit, new FaultyFiles(kit.files).fail('read', join(USAGE, 'alpha.json'), systemError('EIO')));
    assert.deepEqual(spent, []);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? '', /^WARN the week's spend by class could not be read, so no class is held for its share \[focus\.allocation\]: .*EIO/);
  });
});
