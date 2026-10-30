import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { HeadroomConfig } from '../config/types.ts';
import { headroomFor, noRoomText } from './headroom.ts';

const CONFIG: HeadroomConfig = { sessionMb: 1200, commitMaxPct: 92, closeIdleMinutes: 60 };
const FLOOR = 4096;
const ROOMY = { freeMb: 20_000, commit: undefined, runningCommittedMb: [] };
const NONE_RUNNING = { runningMb: [], runningCommittedMb: [] };

describe('headroomFor', () => {
  it('counts a session at the median running tree, else at sessionMb', () => {
    assert.equal(headroomFor({ ...ROOMY, runningMb: [] }, FLOOR, CONFIG).needMb, 1200);
    assert.equal(headroomFor({ ...ROOMY, runningMb: [900, 300, 2000] }, FLOOR, CONFIG).needMb, 900);
    assert.equal(headroomFor({ ...ROOMY, runningMb: [800, 1000, 300, 2000] }, FLOOR, CONFIG).needMb, 900);
  });

  it('counts what a session commits at the median running tree, else at sessionMb, apart from what it holds', () => {
    const room = { ...ROOMY, runningMb: [500, 450, 480], runningCommittedMb: [1100, 1230, 790] };
    assert.deepEqual(headroomFor(room, FLOOR, CONFIG), { needMb: 480, needCommittedMb: 1100, short: [] });
    assert.equal(headroomFor({ ...room, runningCommittedMb: [] }, FLOOR, CONFIG).needCommittedMb, 1200, 'a ps list gives no commit');
  });

  it('checks the commit charge with what a session commits, not what it holds resident', () => {
    const room = { freeMb: 20_000, commit: { usedMb: 91_000, limitMb: 100_000 }, runningMb: [480], runningCommittedMb: [1100] };
    assert.deepEqual(headroomFor(room, FLOOR, CONFIG).short, [
      'with it the commit charge would be 92100 MB, over 92% of its 100000 MB limit (open.headroom.commitMaxPct)',
    ]);
  });

  it('fits with free memory at the floor plus the session and the commit charge at its cap', () => {
    const room = { freeMb: 5296, commit: { usedMb: 91_444, limitMb: 100_700 }, ...NONE_RUNNING };
    assert.deepEqual(headroomFor(room, FLOOR, CONFIG), { needMb: 1200, needCommittedMb: 1200, short: [] });
  });

  it('is short one MB under the floor plus the session', () => {
    assert.deepEqual(headroomFor({ freeMb: 5295, commit: undefined, ...NONE_RUNNING }, FLOOR, CONFIG).short, [
      '5295 MB free, under the 4096 MB queued steps keep free (delivery.queue.memoryFloorMb) plus 1200 MB for it',
    ]);
  });

  it('is short when the commit charge would pass its cap with the session', () => {
    const room = { freeMb: 20_000, commit: { usedMb: 91_445, limitMb: 100_700 }, ...NONE_RUNNING };
    assert.deepEqual(headroomFor(room, FLOOR, CONFIG).short, [
      'with it the commit charge would be 92645 MB, over 92% of its 100700 MB limit (open.headroom.commitMaxPct)',
    ]);
  });

  it('names every reason, and the refusal says how to make room', () => {
    const room = { freeMb: 3000, commit: { usedMb: 99_000, limitMb: 100_700 }, runningMb: [1500], runningCommittedMb: [1700] };
    assert.equal(
      noRoomText('open web', headroomFor(room, FLOOR, CONFIG)),
      'no room on the host to open web, counted at 1500 MB resident and 1700 MB committed: 3000 MB free, under the 4096 MB ' +
        'queued steps keep free (delivery.queue.memoryFloorMb) plus 1500 MB for it; with it the commit charge would be ' +
        '100700 MB, over 92% of its 100700 MB limit (open.headroom.commitMaxPct). Close a session first: teamrig sessions ' +
        'lists what each one holds',
    );
  });
});
