import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { emptyPatterns } from '../budget/patterns.ts';
import { EMPTY_USAGE, UsageStore, type UsageState } from '../budget/store.ts';
import { MemoryFiles } from '../testing/memory-files.ts';
import { readMeasuredTurns } from './stored-week.ts';

const NOW = Date.UTC(2030, 0, 8, 12);
const USAGE = '/team/state/usage';

function usageOf(turns: number, w: number): UsageState {
  return { ...EMPTY_USAGE, byDay: { '2030-01-08': { w, calls: turns, patterns: { ...emptyPatterns(), notificationTurns: turns, notificationW: w } } } };
}

async function stored(usage: Record<string, UsageState>): Promise<MemoryFiles> {
  const files = new MemoryFiles();
  const store = new UsageStore(files, USAGE);
  for (const [session, state] of Object.entries(usage)) {
    assert.ok(await store.save(session, state, (await store.load(session)).rev), `${session}'s use saved`);
  }
  return files;
}

describe('readMeasuredTurns', () => {
  it("answers the session's own average once it has enough turns, leaving the team's out", async () => {
    const files = await stored({ alpha: usageOf(5, 1_000_000), bravo: usageOf(5, 9_000_000) });
    assert.deepEqual(await readMeasuredTurns({ files }, { usage: USAGE }, 'alpha', ['alpha', 'bravo'], NOW), { w: 200_000, turns: 5 });
  });

  it("averages the session's turns with the team's when it has too few of its own", async () => {
    const files = await stored({ alpha: usageOf(2, 400_000), bravo: usageOf(4, 2_000_000) });
    assert.deepEqual(await readMeasuredTurns({ files }, { usage: USAGE }, 'alpha', ['alpha', 'bravo'], NOW), { w: 400_000, turns: 6 });
  });

  it('answers undefined while the team has too few turns', async () => {
    const files = await stored({ alpha: usageOf(2, 400_000), bravo: usageOf(2, 400_000) });
    assert.equal(await readMeasuredTurns({ files }, { usage: USAGE }, 'alpha', ['alpha', 'bravo'], NOW), undefined);
  });
});
