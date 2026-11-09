import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { HeadroomConfig } from '../config/types.ts';
import { headroomFor, noRoomText, tabFloorOf, type TabFloor } from './headroom.ts';

const CONFIG: HeadroomConfig = { sessionMb: 1200, commitMaxPct: 92, closeIdleMinutes: 60, loadMinutes: 5 };
const FLOOR: TabFloor = { mb: 4096, key: 'open.headroom.floorMb' };
const ROOMY = { freeMb: 20_000, commit: undefined, runningCommittedMb: [], loading: [] };
const NONE_RUNNING = { runningMb: [], runningCommittedMb: [], loading: [] };

describe('tabFloorOf', () => {
  it('is open.headroom.floorMb when set', () => {
    assert.deepEqual(tabFloorOf({ floorMb: 3000 }, { memoryFloorMb: 4096, heavyReserveMb: 2048 }), { mb: 3000, key: 'open.headroom.floorMb' });
  });

  it("is what queued steps keep free plus one heavy step's reserve while open.headroom.floorMb is unset", () => {
    assert.deepEqual(tabFloorOf({}, { memoryFloorMb: 4096, heavyReserveMb: 2048 }), {
      mb: 6144,
      key: 'delivery.queue.memoryFloorMb + heavyReserveMb, while open.headroom.floorMb is unset',
    });
  });
});

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
    const room = { freeMb: 20_000, commit: { usedMb: 91_000, limitMb: 100_000 }, runningMb: [480], runningCommittedMb: [1100], loading: [] };
    assert.deepEqual(headroomFor(room, FLOOR, CONFIG).short, [
      'with it the commit charge would be 92100 MB, over 92% of its 100000 MB limit (open.headroom.commitMaxPct)',
    ]);
  });

  it('fits with free memory at the floor plus the session and the commit charge at its cap', () => {
    const room = { freeMb: 5296, commit: { usedMb: 91_444, limitMb: 100_700 }, ...NONE_RUNNING };
    assert.deepEqual(headroomFor(room, FLOOR, CONFIG), { needMb: 1200, needCommittedMb: 1200, short: [] });
  });

  it('is short one MB under the floor plus the session, and names the key of the floor', () => {
    assert.deepEqual(headroomFor({ freeMb: 5295, commit: undefined, ...NONE_RUNNING }, FLOOR, CONFIG).short, [
      '5295 MB free, under the 4096 MB a new tab keeps free (open.headroom.floorMb) plus 1200 MB for it',
    ]);
  });

  it('is short when the commit charge would pass its cap with the session', () => {
    const room = { freeMb: 20_000, commit: { usedMb: 91_445, limitMb: 100_700 }, ...NONE_RUNNING };
    assert.deepEqual(headroomFor(room, FLOOR, CONFIG).short, [
      'with it the commit charge would be 92645 MB, over 92% of its 100700 MB limit (open.headroom.commitMaxPct)',
    ]);
  });

  it('takes what the tabs still loading hold off free memory: a room that fits alone is short one MB with them', () => {
    const loading = [
      { needMb: 1000, needCommittedMb: 0 },
      { needMb: 2000, needCommittedMb: 0 },
    ];
    const room = { freeMb: 8295, commit: undefined, runningMb: [], runningCommittedMb: [], loading };
    assert.deepEqual(headroomFor({ ...room, freeMb: 8296 }, FLOOR, CONFIG).short, []);
    assert.deepEqual(headroomFor(room, FLOOR, CONFIG).short, [
      '8295 MB free, 3000 MB of it held for 2 tabs still loading, under the 4096 MB a new tab keeps free (open.headroom.floorMb) plus 1200 MB for it',
    ]);
  });

  it('adds what the tabs still loading commit to the commit charge', () => {
    const room = { freeMb: 20_000, commit: { usedMb: 90_001, limitMb: 100_000 }, runningMb: [], runningCommittedMb: [], loading: [{ needMb: 0, needCommittedMb: 800 }] };
    assert.deepEqual(headroomFor({ ...room, commit: { usedMb: 90_000, limitMb: 100_000 } }, FLOOR, CONFIG).short, []);
    assert.deepEqual(headroomFor(room, FLOOR, CONFIG).short, [
      'with it and the 1 tab still loading the commit charge would be 92001 MB, over 92% of its 100000 MB limit (open.headroom.commitMaxPct)',
    ]);
  });

  it('names every reason, and the refusal says how to make room', () => {
    const room = { freeMb: 3000, commit: { usedMb: 99_000, limitMb: 100_700 }, runningMb: [1500], runningCommittedMb: [1700], loading: [] };
    assert.equal(
      noRoomText('open web', headroomFor(room, FLOOR, CONFIG)),
      'no room on the host to open web, counted at 1500 MB resident and 1700 MB committed: 3000 MB free, under the 4096 MB ' +
        'a new tab keeps free (open.headroom.floorMb) plus 1500 MB for it; with it the commit charge would be ' +
        '100700 MB, over 92% of its 100700 MB limit (open.headroom.commitMaxPct). Close a session first: teamrig sessions ' +
        'lists what each one holds',
    );
  });
});
