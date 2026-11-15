import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ResetStock } from '../../config/types.ts';
import { CliHarness } from '../../testing/cli-harness.ts';
import { openKit } from '../kit.ts';
import { blockStartOf } from './live-tasks.ts';

describe('blockStartOf', () => {
  it("leaves out the lead's resets line when reading the grants throws, and still gives the start (GeneralA6/teamrig#931)", async () => {
    const harness = new CliHarness();
    const runtime = harness.runtime();
    const kit = await openKit(runtime, 'app');
    if (kit.load.status !== 'loaded') {
      throw new Error('the team config did not load');
    }
    const unreadable: ResetStock = {
      kind: 'fable',
      count: 3,
      expiresUtc: '2030-03-01 08:00',
      get usedUtc(): readonly string[] {
        throw new Error('simulated');
      },
    };
    const config = { ...kit.load.config, budget: { ...kit.load.config.budget, resets: [unreadable] } };

    const start = await blockStartOf(runtime, kit, config, 'lead');

    assert.equal(start.resets, undefined);
    assert.equal(start.at, 'Tue 01-08 10:00 UTC');
  });
});
