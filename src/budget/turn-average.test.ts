import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { measuredTurns } from './turn-average.ts';
import { emptyPatterns } from './patterns.ts';
import type { UsageState } from './store.ts';

const NOW = Date.UTC(2030, 0, 8, 12);

function stateOf(days: Record<string, { turns: number; w: number }>): UsageState {
  const byDay: UsageState['byDay'] = Object.fromEntries(
    Object.entries(days).map(([day, use]) => [day, { w: use.w, calls: use.turns, patterns: { ...emptyPatterns(), notificationTurns: use.turns, notificationW: use.w } }]),
  );
  return { byDay, byHour: {}, byTask: {}, cursors: {}, recentKeys: [] };
}

describe('measuredTurns', () => {
  it('averages the notification turns of the last 7 UTC days over every state', () => {
    const a = stateOf({ '2030-01-08': { turns: 4, w: 1_000_000 }, '2030-01-02': { turns: 2, w: 500_000 } });
    const b = stateOf({ '2030-01-05': { turns: 2, w: 500_000 } });
    assert.deepEqual(measuredTurns([a, b], NOW), { w: 250_000, turns: 8 });
  });

  it('leaves out days older than 7 and answers undefined below 5 turns', () => {
    assert.equal(measuredTurns([stateOf({ '2030-01-01': { turns: 50, w: 50_000_000 }, '2030-01-08': { turns: 4, w: 1_000_000 } })], NOW), undefined);
    assert.equal(measuredTurns([], NOW), undefined);
  });
});
