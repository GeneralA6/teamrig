import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { EMPTY_USAGE, UsageStore } from '../budget/store.ts';
import type { JsonRecord } from '../core/guards.ts';
import { CliHarness, TEAM, TEAM_HOME } from '../testing/cli-harness.ts';
import { ok } from '../testing/hired-team.ts';

/** The harness clock is 2030-01-08 10:00 UTC; a weekly limit of 1,000M W makes 1% of the week 10M W. */
const LIMITED: JsonRecord = { ...TEAM, budget: { weeklyLimitW: 1_000_000_000 } };
const DAY = '2030-01-08';

/** T1, sized 0.5% of the week, owned by alpha, which the meter stored as spending `w` W on it today. */
async function spentKit(w: number, config: JsonRecord = LIMITED): Promise<CliHarness> {
  const kit = new CliHarness(config);
  ok(await kit.run(['add', '--owner', 'alpha', '--title', 'Ship the CLI', '--description', 'the job', '--priority', 'p2', '--size', '0.5', '--session', 'lead']));
  const store = new UsageStore(kit.files, join(TEAM_HOME, 'state', 'usage'));
  const { rev } = await store.load('alpha');
  assert.equal(await store.save('alpha', { ...EMPTY_USAGE, byTask: { [DAY]: { T1: w } } }, rev), true);
  return kit;
}

async function overSizeLines(kit: CliHarness): Promise<string[]> {
  return ok(await kit.run(['check', '--all', '--session', 'lead'])).stdout.filter((line) => line.startsWith('OVER-SIZE'));
}

describe('check OVER-SIZE', () => {
  it('flags a sized task whose stored cost passed twice its size, and not one within it', async () => {
    const [flag, ...rest] = await overSizeLines(await spentKit(12_000_000));
    assert.match(flag ?? '', /^OVER-SIZE \(spent 1\.2% of the week, 2\.4x its size 0\.5%\) T1 /);
    assert.deepEqual(rest, []);
    assert.deepEqual(await overSizeLines(await spentKit(10_000_000)), [], 'exactly twice its size is not past it');
  });

  it('reads register.check.overSizeMultiple, 0 turning it off', async () => {
    const lower = { ...LIMITED, register: { check: { overSizeMultiple: 1.5 } } };
    assert.equal((await overSizeLines(await spentKit(8_000_000, lower))).length, 1);
    const off = { ...LIMITED, register: { check: { overSizeMultiple: 0 } } };
    assert.deepEqual(await overSizeLines(await spentKit(50_000_000, off)), []);
  });

  it('counts from a re-size, so it clears the flag until the task spends past the multiple again (T649)', async () => {
    const kit = await spentKit(12_000_000);
    assert.equal((await overSizeLines(kit)).length, 1);
    ok(await kit.run(['update', 'T1', '--size', '0.5', '--session', 'alpha']));
    assert.deepEqual(await overSizeLines(kit), [], 'the 12M W spent before the re-size no longer counts');
    const store = new UsageStore(kit.files, join(TEAM_HOME, 'state', 'usage'));
    const { rev } = await store.load('alpha');
    assert.equal(await store.save('alpha', { ...EMPTY_USAGE, byTask: { [DAY]: { T1: 23_000_000 } } }, rev), true);
    const [flag] = await overSizeLines(kit);
    assert.match(flag ?? '', /^OVER-SIZE \(spent 1\.1% since it was sized, 2\.2x its size 0\.5%\) T1 /);
  });

  it('raises nothing while the W of one percent is unknown', async () => {
    assert.deepEqual(await overSizeLines(await spentKit(50_000_000, TEAM)), []);
  });
});
