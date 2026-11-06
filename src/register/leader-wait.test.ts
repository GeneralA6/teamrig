import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MS_PER_MINUTE } from '../core/time.ts';
import { testTask } from '../testing/task.ts';
import type { Task } from './fold.ts';
import { heldFirst, leaderHolds, waitedMinutes, type LeaderWaitFocus } from './leader-wait.ts';
import type { WaitingOnYou } from './tree.ts';
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

describe('heldFirst', () => {
  const TREE = { approversOf: (owner: string): string[] => (owner === 'bravo' ? ['sub', 'lead'] : ['lead']) };
  /** An entry for a task of `owner` asking the lead's approval since ASKED. */
  const held = (id: string, owner = 'alpha'): WaitingOnYou => ({ task: waiting([APPROVAL], { id, owner }), needs: [], asks: [APPROVAL] });
  /** An entry for a task that needs one of the reader's tasks and holds on no leader. */
  const needing = (id: string): WaitingOnYou => ({ task: waiting([{ kind: 'task', id: 'T9' }], { id }), needs: [testTask({ id: 'T9', owner: 'lead' })], asks: [] });
  const idsOf = (entries: readonly WaitingOnYou[]): string[] => entries.map(({ task }) => task.id);

  it('puts the tasks held on the session first, the order kept inside each part', () => {
    const entries = [needing('T1'), held('T2'), needing('T3'), held('T4')];
    assert.deepEqual(idsOf(heldFirst(entries, 'lead', TREE, FOCUS, LATE)), ['T2', 'T4', 'T1', 'T3']);
  });

  it('keeps the order when nothing is past the limit', () => {
    const entries = [needing('T1'), held('T2')];
    assert.deepEqual(idsOf(heldFirst(entries, 'lead', TREE, FOCUS, ASKED_AT)), ['T1', 'T2']);
  });

  it("leaves a task held on another leader where it was: it lists here for the reader's task, not its answer", () => {
    const onSub: WaitReason = { kind: 'approval', who: 'sub' };
    const elsewhere: WaitingOnYou = { task: waiting([onSub], { id: 'T2', owner: 'bravo' }), needs: [testTask({ id: 'T9', owner: 'lead' })], asks: [] };
    assert.deepEqual(idsOf(heldFirst([needing('T1'), elsewhere], 'lead', TREE, FOCUS, LATE)), ['T1', 'T2']);
  });

  it("reads each task's leaders from its own owner", () => {
    const onSub: WaitReason = { kind: 'decision', who: 'sub' };
    const own: WaitingOnYou = { task: waiting([onSub], { id: 'T2', owner: 'bravo' }), needs: [], asks: [onSub] };
    const foreign: WaitingOnYou = { task: waiting([onSub], { id: 'T3', owner: 'alpha' }), needs: [], asks: [onSub] };
    assert.deepEqual(idsOf(heldFirst([foreign, own], 'sub', TREE, FOCUS, LATE)), ['T2', 'T3']);
  });
});

describe('waitedMinutes', () => {
  it('counts whole minutes', () => {
    assert.equal(waitedMinutes({ waitsAt: ASKED }, ASKED_AT + 61 * MS_PER_MINUTE + 59_000), 61);
  });
});
