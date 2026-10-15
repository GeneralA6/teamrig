import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { testTask } from '../testing/task.ts';
import { heldStart, heldStartNotice, proofOf, proofText, startHolds, verifyByArrived, verifyingNeeds, verifyQueue } from './verify.ts';

describe('proofOf', () => {
  it('reads the proof a task was set verifying with', () => {
    assert.equal(proofOf({ proof: 'the nightly run', note: 'Proof: something else' }), 'the nightly run');
  });

  it('reads an older task, set verifying before --proof, from what its note says after Proof', () => {
    assert.equal(proofOf({ proof: null, note: 'shipped in 1.2.0. Proof: the nightly run is green' }), 'the nightly run is green');
    assert.equal(proofOf({ proof: null, note: 'shipped; proof = a real line in the inbox' }), 'a real line in the inbox');
    assert.equal(proofOf({ proof: null, note: 'shipped, proof:   ' }), 'shipped, proof:   ', 'nothing after it: the whole note');
    assert.equal(proofOf({ proof: null, note: 'the nightly run is green' }), 'the nightly run is green');
    assert.equal(proofOf({ proof: null, note: null }), null);
  });
});

describe('verifyingNeeds and startHolds', () => {
  const shipped = testTask({ id: 'T1', owner: 'bravo', status: 'verifying', proof: 'the nightly run' });
  const tasks = new Map([
    ['T1', shipped],
    ['T2', testTask({ id: 'T2', status: 'done' })],
    ['T3', testTask({ id: 'T3', owner: 'lead', status: 'verifying', note: 'shipped. Proof: a real line' })],
  ]);
  const ids = (found: readonly { readonly id: string }[]) => found.map((task) => task.id);

  it('names the verifying tasks a task is planned after or waits on, each once', () => {
    assert.deepEqual(ids(verifyingNeeds(testTask({ after: ['T1', 'T2', 'T9'] }), tasks)), ['T1'], 'done and unknown tasks hold nothing');
    const waiting = testTask({ status: 'waiting', after: ['T1'], waits: [{ kind: 'task', id: 'T3' }, { kind: 'task', id: 'T1' }, { kind: 'decision', who: 'owner' }] });
    assert.deepEqual(ids(verifyingNeeds(waiting, tasks)), ['T1', 'T3']);
  });

  it('holds only a move into in-progress from another status', () => {
    const planned = testTask({ id: 'T4', after: ['T1'] });
    assert.deepEqual(ids(startHolds(planned, 'in-progress', tasks)), ['T1']);
    assert.deepEqual(ids(startHolds(planned, 'waiting', tasks)), []);
    assert.deepEqual(ids(startHolds({ ...planned, status: 'in-progress' }, 'in-progress', tasks)), [], 'a note on a started task is no start');
  });

  it('names each hold with its proof and owner', () => {
    const third = tasks.get('T3') ?? shipped;
    assert.equal(heldStart({ id: 'T4' }, [shipped]), 'T4 needs T1, still verifying (proof: the nightly run, owner bravo)');
    assert.equal(
      heldStart({ id: 'T4' }, [shipped, third]),
      'T4 needs T1, still verifying (proof: the nightly run, owner bravo), and T3, still verifying (proof: a real line, owner lead)',
    );
    assert.equal(heldStartNotice({ id: 'T4' }, shipped), 'T4 waits on your verifying T1: the nightly run');
    assert.equal(heldStartNotice({ id: 'T4' }, testTask({ status: 'verifying' })), 'T4 waits on your verifying T1: no proof named');
  });
});

describe('verifyQueue, verifyByArrived and proofText', () => {
  it("lists one session's verifying tasks, oldest first, then by id number", () => {
    const tasks = [
      testTask({ id: 'T10', status: 'verifying', statusAt: '2030-01-07T12:00:00.000Z' }),
      testTask({ id: 'T9', status: 'verifying', statusAt: '2030-01-07T12:00:00.000Z' }),
      testTask({ id: 'T3', status: 'verifying', statusAt: '2030-01-07T08:00:00.000Z' }),
      testTask({ id: 'T4', status: 'verifying', owner: 'bravo' }),
      testTask({ id: 'T5', status: 'in-progress' }),
    ];
    assert.deepEqual(
      verifyQueue(tasks, 'alpha').map((task) => task.id),
      ['T3', 'T9', 'T10'],
    );
    assert.deepEqual(verifyQueue(tasks, 'lead'), []);
  });

  it('comes due at the start of the verify-by day, in UTC', () => {
    const now = new Date('2030-01-09T00:00:00.000Z');
    assert.equal(verifyByArrived({ due: '2030-01-09 18:00' }, now), true);
    assert.equal(verifyByArrived({ due: '2030-01-08' }, now), true);
    assert.equal(verifyByArrived({ due: '2030-01-10' }, now), false);
    assert.equal(verifyByArrived({ due: null }, now), false);
    assert.equal(verifyByArrived({ due: 'soon' }, now), false, 'a date the register never wrote counts as none');
  });

  it('names a missing proof', () => {
    assert.equal(proofText({ proof: 'the nightly run', note: null }), 'the nightly run');
    assert.equal(proofText({ proof: null, note: null }), 'no proof named');
  });
});
