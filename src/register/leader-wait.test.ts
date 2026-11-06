import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MS_PER_MINUTE } from '../core/time.ts';
import { testTask } from '../testing/task.ts';
import type { Task } from './fold.ts';
import { leaderHolds, waitedMinutes, type LeaderWaitFocus } from './leader-wait.ts';
import type { WaitReason } from './waits.ts';

const FOCUS: LeaderWaitFocus = { roadmapClass: 'Roadmap', defaultClass: 'Improvements', leaderWaitMinutes: 60 };
const ASKED = '2030-01-08T10:00:00.000Z';
const ASKED_AT = Date.parse(ASKED);
const LATE = ASKED_AT + 61 * MS_PER_MINUTE;
const LEADERS = ['lead'];
const APPROVAL: WaitReason = { kind: 'approval', who: 'lead' };

/** A Roadmap task of alpha's, waiting since ASKED on `waits`. */
function waiting(waits: readonly WaitReason[], extra: Partial<Task> = {}): Task {
  return testTask({ status: 'waiting', workClass: 'Roadmap', waits, waitsAt: ASKED, ...extra });
}

describe('leaderHolds', () => {
  it("holds a Roadmap task on a leader's approval or decision past the limit", () => {
    assert.deepEqual(leaderHolds(waiting([APPROVAL]), LEADERS, FOCUS, LATE), [APPROVAL]);
    assert.deepEqual(leaderHolds(waiting([{ kind: 'decision', who: 'lead' }]), LEADERS, FOCUS, LATE), [{ kind: 'decision', who: 'lead' }]);
  });

  it("counts a verifying task's proof wait, as waits hold on both", () => {
    assert.deepEqual(leaderHolds(waiting([APPROVAL], { status: 'verifying', proof: 'the run' }), LEADERS, FOCUS, LATE), [APPROVAL]);
  });

  it('reads strictly past the limit', () => {
    const limit = ASKED_AT + 60 * MS_PER_MINUTE;
    assert.deepEqual(leaderHolds(waiting([APPROVAL]), LEADERS, FOCUS, limit), []);
    assert.deepEqual(leaderHolds(waiting([APPROVAL]), LEADERS, FOCUS, limit + 1), [APPROVAL]);
  });

  it('holds from the first moment after the ask with a limit of 0', () => {
    const now: LeaderWaitFocus = { ...FOCUS, leaderWaitMinutes: 0 };
    assert.deepEqual(leaderHolds(waiting([APPROVAL]), LEADERS, now, ASKED_AT), []);
    assert.deepEqual(leaderHolds(waiting([APPROVAL]), LEADERS, now, ASKED_AT + 1), [APPROVAL]);
  });

  it('reads the class a task counts as, so an unclassed task holds only when the default is the Roadmap class', () => {
    assert.deepEqual(leaderHolds(waiting([APPROVAL], { workClass: 'Maintenance' }), LEADERS, FOCUS, LATE), []);
    assert.deepEqual(leaderHolds(waiting([APPROVAL], { workClass: null }), LEADERS, FOCUS, LATE), []);
    assert.deepEqual(leaderHolds(waiting([APPROVAL], { workClass: null }), LEADERS, { ...FOCUS, defaultClass: 'Roadmap' }, LATE), [APPROVAL]);
  });

  it('holds only on a leader: a wait on anyone else, or on no person, is no hold', () => {
    assert.deepEqual(leaderHolds(waiting([{ kind: 'approval', who: 'owner' }, { kind: 'decision', who: 'bravo' }]), LEADERS, FOCUS, LATE), []);
    assert.deepEqual(leaderHolds(waiting([{ kind: 'task', id: 'T5' }, { kind: 'time', at: ASKED }]), LEADERS, FOCUS, LATE), []);
  });

  it('returns only the waits on a leader, each one named', () => {
    const second: WaitReason = { kind: 'decision', who: 'sub' };
    const waits: readonly WaitReason[] = [{ kind: 'task', id: 'T5' }, APPROVAL, { kind: 'approval', who: 'bravo' }, second];
    assert.deepEqual(leaderHolds(waiting(waits), ['sub', 'lead'], FOCUS, LATE), [APPROVAL, second]);
  });

  it("ends the hold on the leader's answer either way, and only on that leader's", () => {
    const answer = { by: 'lead', at: ASKED, note: null };
    assert.deepEqual(leaderHolds(waiting([APPROVAL], { answer: { ...answer, verdict: 'approved' } }), LEADERS, FOCUS, LATE), []);
    assert.deepEqual(leaderHolds(waiting([APPROVAL], { answer: { ...answer, verdict: 'declined' } }), LEADERS, FOCUS, LATE), []);
    assert.deepEqual(leaderHolds(waiting([APPROVAL], { answer: { ...answer, by: 'security', verdict: 'approved' } }), LEADERS, FOCUS, LATE), [APPROVAL]);
  });

  it('starts the clock at waitsAt, not at statusAt: a task long parked that only now asks its leader gets the whole limit', () => {
    const parked = waiting([APPROVAL], { statusAt: '2030-01-01T10:00:00.000Z', waitsAt: ASKED });
    assert.deepEqual(leaderHolds(parked, LEADERS, FOCUS, ASKED_AT + 5 * MS_PER_MINUTE), []);
  });
});

describe('waitedMinutes', () => {
  it('counts whole minutes', () => {
    assert.equal(waitedMinutes({ waitsAt: ASKED }, ASKED_AT + 61 * MS_PER_MINUTE + 59_000), 61);
  });
});
