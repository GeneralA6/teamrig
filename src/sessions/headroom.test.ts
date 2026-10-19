import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { headroomFor, noRoomText } from './headroom.ts';

const CONFIG = { sessionMb: 1200, commitMaxPct: 92 };
const FLOOR = 4096;
const ROOMY = { freeMb: 20_000, commit: undefined };

describe('headroomFor', () => {
  it('counts a session at the median running tree, else at sessionMb', () => {
    assert.equal(headroomFor({ ...ROOMY, runningMb: [] }, FLOOR, CONFIG).needMb, 1200);
    assert.equal(headroomFor({ ...ROOMY, runningMb: [900, 300, 2000] }, FLOOR, CONFIG).needMb, 900);
    assert.equal(headroomFor({ ...ROOMY, runningMb: [800, 1000, 300, 2000] }, FLOOR, CONFIG).needMb, 900);
  });

  it('fits with free memory at the floor plus the session and the commit charge at its cap', () => {
    const room = { freeMb: 5296, commit: { usedMb: 91_444, limitMb: 100_700 }, runningMb: [] };
    assert.deepEqual(headroomFor(room, FLOOR, CONFIG), { needMb: 1200, short: [] });
  });

  it('is short one MB under the floor plus the session', () => {
    assert.deepEqual(headroomFor({ freeMb: 5295, commit: undefined, runningMb: [] }, FLOOR, CONFIG).short, [
      '5295 MB free, under the 4096 MB heavy steps keep free (coordinator.heavy.memoryFloorMb) plus 1200 MB for it',
    ]);
  });

  it('is short when the commit charge would pass its cap with the session', () => {
    const room = { freeMb: 20_000, commit: { usedMb: 91_445, limitMb: 100_700 }, runningMb: [] };
    assert.deepEqual(headroomFor(room, FLOOR, CONFIG).short, [
      'with it the commit charge would be 92645 MB, over 92% of its 100700 MB limit (open.headroom.commitMaxPct)',
    ]);
  });

  it('names every reason, and the refusal says how to make room', () => {
    const headroom = headroomFor({ freeMb: 3000, commit: { usedMb: 99_000, limitMb: 100_700 }, runningMb: [1500] }, FLOOR, CONFIG);
    assert.equal(
      noRoomText('open web', headroom),
      'no room on the host to open web, counted at 1500 MB: 3000 MB free, under the 4096 MB heavy steps keep free ' +
        '(coordinator.heavy.memoryFloorMb) plus 1500 MB for it; with it the commit charge would be 100500 MB, over 92% of ' +
        'its 100700 MB limit (open.headroom.commitMaxPct). Close a session first: teamrig sessions lists what each one holds',
    );
  });
});
