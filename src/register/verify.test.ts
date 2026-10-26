import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { testTask } from '../testing/task.ts';
import { TimeZone } from '../core/zone.ts';
import { JERUSALEM } from '../testing/zone.ts';
import type { Task } from './fold.ts';
import { dueStartHolds, dueVerifies, dueVerifyHold, heldStart, heldStartNotice, metStartNotice, proofOf, proofText, startHolds, verifyByArrived, verifyingNeeds, verifyQueue, type DueVerify } from './verify.ts';
import { waitContext, type WaitReason } from './waits.ts';

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
    assert.equal(
      metStartNotice({ id: 'T4' }, shipped, 'the nightly run is green'),
      'T4 started on your verifying T1, its proof met: the nightly run is green; set T1 done if that holds, else reopen it',
    );
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
    assert.equal(verifyByArrived({ due: '2030-01-09 18:00' }, now, TimeZone.UTC), true);
    assert.equal(verifyByArrived({ due: '2030-01-08' }, now, TimeZone.UTC), true);
    assert.equal(verifyByArrived({ due: '2030-01-10' }, now, TimeZone.UTC), false);
    assert.equal(verifyByArrived({ due: null }, now, TimeZone.UTC), false);
    assert.equal(verifyByArrived({ due: 'soon' }, now, TimeZone.UTC), false, 'a date the register never wrote counts as none');
  });

  it('names a missing proof', () => {
    assert.equal(proofText({ proof: 'the nightly run', note: null }), 'the nightly run');
    assert.equal(proofText({ proof: null, note: null }), 'no proof named');
  });
});

describe("verifyByArrived in the team's zone", () => {
  it('comes due at the start of the verify-by day there', () => {
    const now = new Date('2030-01-08T22:30:00.000Z');
    assert.equal(verifyByArrived({ due: '2030-01-09' }, now, JERUSALEM), true, 'Jerusalem is at 01-09 00:30');
    assert.equal(verifyByArrived({ due: '2030-01-09' }, now, TimeZone.UTC), false, 'UTC is at 01-08 22:30');
  });
});

describe('dueVerifies, dueStartHolds and dueVerifyHold', () => {
  const NOW = new Date('2030-01-09T12:00:00.000Z');
  const ASKED_OWNER: readonly WaitReason[] = [{ kind: 'approval', who: 'owner' }];
  const verifying = (id: string, hour: number, overrides: Partial<Task> = {}): Task =>
    testTask({
      id,
      status: 'verifying',
      proof: 'the nightly run',
      startedAt: '2030-01-07T08:00:00.000Z',
      statusAt: `2030-01-08T${String(hour).padStart(2, '0')}:00:00.000Z`,
      ...overrides,
    });
  const tasksOf = (...tasks: Task[]): ReadonlyMap<string, Task> => new Map(tasks.map((task) => [task.id, task]));
  const dueOf = (tasks: ReadonlyMap<string, Task>, max = 5): string[] =>
    dueVerifies(tasks.values(), 'alpha', waitContext(tasks, NOW, TimeZone.UTC), max).map(({ task, why }) => `${task.id} ${why}`);

  it("is due once its proof's waits cleared or its verify-by day came, never while it waits on another party", () => {
    const tasks = tasksOf(
      verifying('T1', 9, { due: '2030-01-09' }),
      verifying('T2', 10, { waits: [{ kind: 'task', id: 'T8' }] }),
      verifying('T3', 11, { waits: [{ kind: 'task', id: 'T9' }], due: '2030-01-08' }),
      verifying('T4', 12, { waits: ASKED_OWNER }),
      verifying('T5', 13, { due: '2030-01-10' }),
      verifying('T6', 14, { owner: 'bravo', due: '2030-01-08' }),
      testTask({ id: 'T8', status: 'done' }),
      testTask({ id: 'T9', status: 'in-progress' }),
    );
    assert.deepEqual(dueOf(tasks), ['T1 verify by 01-09', "T2 proof's waits cleared"]);
  });

  it('makes the oldest it can act on due while its owner holds more than the limit, and none with the limit off', () => {
    const tasks = tasksOf(verifying('T1', 9, { waits: ASKED_OWNER }), verifying('T2', 10), verifying('T3', 11), verifying('T4', 12));
    assert.deepEqual(dueOf(tasks, 2), ['T2 4 verifying, over 2', 'T3 4 verifying, over 2'], 'the asked T1 counts toward the pile, but is not due');
    assert.deepEqual(dueOf(tasks, 4), []);
    assert.deepEqual(dueOf(tasks, 0), []);
  });

  it("holds only a task's first start, with its owner's due verify steps", () => {
    const fresh = testTask({ id: 'T2' });
    const resumed = testTask({ id: 'T3', status: 'waiting', startedAt: '2030-01-08T08:00:00.000Z' });
    const tasks = tasksOf(verifying('T1', 9, { due: '2030-01-09' }), fresh, resumed);
    const ids = (held: readonly DueVerify[]): string[] => held.map((due) => due.task.id);
    assert.deepEqual(ids(dueStartHolds(fresh, 'in-progress', tasks, NOW, TimeZone.UTC, 5)), ['T1']);
    assert.deepEqual(ids(dueStartHolds(resumed, 'in-progress', tasks, NOW, TimeZone.UTC, 5)), [], 'a task already started goes on');
    assert.deepEqual(ids(dueStartHolds(fresh, 'waiting', tasks, NOW, TimeZone.UTC, 5)), []);
    assert.deepEqual(ids(dueStartHolds({ ...fresh, owner: 'bravo' }, 'in-progress', tasks, NOW, TimeZone.UTC, 5)), [], "only its own owner's verify steps hold it");
  });

  it("reads a proof's wait on another register's task there", () => {
    const fresh = testTask({ id: 'T2' });
    const tasks = tasksOf(verifying('T1', 9, { waits: [{ kind: 'task', id: 'T20' }] }), fresh);
    const away = (status: Task['status']) => new Map([['T20', { team: 'web', task: testTask({ id: 'T20', status }) }]]);
    const ids = (held: readonly DueVerify[]): string[] => held.map((due) => due.task.id);
    assert.deepEqual(ids(dueStartHolds(fresh, 'in-progress', tasks, NOW, TimeZone.UTC, 5, away('in-progress'))), [], 'its proof still waits on web');
    assert.deepEqual(ids(dueStartHolds(fresh, 'in-progress', tasks, NOW, TimeZone.UTC, 5, away('done'))), ['T1']);
  });

  it('names up to three due verify steps, counts the rest, and says how to clear each', () => {
    const due = ['T1', 'T2', 'T3', 'T4', 'T5'].map((id): DueVerify => ({ task: testTask({ id }), why: 'verify by 01-08' }));
    assert.equal(
      dueVerifyHold({ id: 'T9' }, due.slice(0, 1)),
      'T9 is new work; T1 (verify by 01-08) is due to verify first (teamrig verify): set each done with its proof, in-progress if it failed, ' +
        'or verifying with --waits for when its proof runs; a verify-by date moves with --due and a --note saying why',
    );
    assert.match(dueVerifyHold({ id: 'T9' }, due), /^T9 is new work; T1 \(verify by 01-08\), T2 \(verify by 01-08\), T3 \(verify by 01-08\) and 2 more are due to verify first /);
  });
});
