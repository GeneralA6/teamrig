import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CliHarness, TEAM, type RunOptions } from '../testing/cli-harness.ts';
import { EXIT } from './runtime.ts';

const AS_LEAD: RunOptions = { env: { TEAMRIG_SESSION: 'lead' } };
const SOURCE = 'from the reset expiry check [budget.resets]:';

/** The harness clock is 2030-01-08 10:00 UTC: this grant expires in 2 days, the far one in 52. */
const NEAR = { kind: 'full', count: 1, expiresUtc: '2030-01-10 22:00', usedUtc: [] };
const FAR = { kind: 'fable', count: 3, expiresUtc: '2030-03-01 08:00', usedUtc: [] };

/** The lead's check rows from the reset expiry check. */
async function expiryRows(budget: Record<string, unknown>): Promise<string[]> {
  const result = await new CliHarness({ ...TEAM, budget }).run(['check', '--all'], AS_LEAD);
  assert.equal(result.code, EXIT.ok, result.stderr.join('\n'));
  return result.stdout.filter((line) => line.includes('the reset expiry check'));
}

describe('check RESET-EXPIRING (T2450)', () => {
  it('warns of a grant with uses left that expires within two weeks, and not of one further off', async () => {
    assert.deepEqual(await expiryRows({ enabled: true, resets: [NEAR, FAR] }), [
      `${SOURCE} RESET-EXPIRING full resets: 1 of 1 left, expiring 2030-01-10 22:00 UTC (in 2 days); one not spent by then is lost`,
    ]);
  });

  it('counts only the uses left of a grant', async () => {
    const soon = { ...FAR, expiresUtc: '2030-01-15 08:00', usedUtc: ['2030-01-02 09:00'] };
    assert.deepEqual(await expiryRows({ enabled: true, resets: [soon] }), [
      `${SOURCE} RESET-EXPIRING fable resets: 2 of 3 left, expiring 2030-01-15 08:00 UTC (in 6 days); one not spent by then is lost`,
    ]);
  });

  it('says nothing of a grant used up or already expired', async () => {
    const used = { ...NEAR, usedUtc: ['2030-01-07 09:00'] };
    const expired = { ...NEAR, expiresUtc: '2030-01-07 22:00' };
    assert.deepEqual(await expiryRows({ enabled: true, resets: [used, expired] }), []);
  });

  it('says nothing with the budget off', async () => {
    assert.deepEqual(await expiryRows({ enabled: false, resets: [NEAR] }), []);
  });
});
