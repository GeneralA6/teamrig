import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TimeZone } from '../core/zone.ts';
import type { Task } from '../register/fold.ts';
import { TaskTree } from '../register/tree.ts';
import { TEST_CARD, TEST_OWNER_CARD } from '../testing/card.ts';
import { testTask } from '../testing/task.ts';
import { JERUSALEM } from '../testing/zone.ts';
import { taskLabel } from '../register/views.ts';
import { decisionBatch, lastBatchTime, nextBatchText, nextBatchTime, triggerText, type BatchConfig, type BatchInput, type BatchRegister, type OwnerWait } from './batch.ts';

/** A Tuesday, between the 13:03 and 19:03 batch times of the day before and of this day. */
const NOW = Date.parse('2030-01-08T10:00:00Z');
const TIMES = ['13:03', '19:03'];
const CHECKPOINTS: BatchConfig = { batchTimesUtc: TIMES, batchAt: 5 };

/** A task waiting on the owner's decision since `statusAt`, with a card naming its gate. */
function ownerWait(id: string, statusAt: string, overrides: Partial<Task> = {}): Task {
  return testTask({ id, status: 'waiting', waits: [{ kind: 'decision', who: 'owner' }], card: TEST_OWNER_CARD, statusAt, ...overrides });
}

/** A register of `tasks` on the owner marker `owner`, the reader's own unless `team` names another; `requireGate` as `register.requireDecisionCard`. */
function registerOf(tasks: readonly Task[], team?: string, ownerMarker = 'owner', requireGate = true): BatchRegister {
  return { team, tasks, tree: new TaskTree(new Map(tasks.map((task) => [task.id, task])), new Date(NOW), TimeZone.UTC), ownerMarker, requireGate };
}

function inputOf(tasks: readonly Task[], askedAt: string | undefined, config: BatchConfig = CHECKPOINTS, others: readonly BatchRegister[] = []): BatchInput {
  return { registers: [registerOf(tasks), ...others], now: NOW, askedAt: askedAt === undefined ? undefined : Date.parse(askedAt), config };
}

const ids = (waits: readonly OwnerWait[]): string[] => waits.map((wait) => taskLabel(wait.task, wait.team));

describe('the batch times', () => {
  it('finds the last batch time at or before now and the next after it, across midnight', () => {
    assert.equal(lastBatchTime(NOW, TIMES), Date.parse('2030-01-07T19:03:00Z'));
    assert.equal(nextBatchTime(NOW, TIMES), Date.parse('2030-01-08T13:03:00Z'));
    const atBatch = Date.parse('2030-01-08T13:03:00Z');
    assert.deepEqual([lastBatchTime(atBatch, TIMES), nextBatchTime(atBatch, TIMES)], [atBatch, Date.parse('2030-01-08T19:03:00Z')]);
    assert.equal(nextBatchTime(Date.parse('2030-01-08T20:00:00Z'), TIMES), Date.parse('2030-01-09T13:03:00Z'));
  });

  it('finds none with no batch time set', () => {
    assert.deepEqual([lastBatchTime(NOW, []), nextBatchTime(NOW, [])], [undefined, undefined]);
  });
});

describe('the decision batch', () => {
  it('holds the waits on the owner set after the last batch asked, and the asked ones past due', () => {
    const fresh = ownerWait('T1', '2030-01-08T09:00:00.000Z');
    const askedLate = ownerWait('T2', '2030-01-07T11:00:00.000Z', { due: '2030-01-07' });
    const askedOnTime = ownerWait('T3', '2030-01-07T11:30:00.000Z', { due: '2030-01-09' });
    const onLead = testTask({ id: 'T4', status: 'waiting', waits: [{ kind: 'decision', who: 'lead' }], statusAt: '2030-01-08T09:00:00.000Z' });
    const batch = decisionBatch(inputOf([fresh, askedLate, askedOnTime, onLead], '2030-01-07T12:00:00.000Z'));
    assert.deepEqual([ids(batch.pending), ids(batch.overdue)], [['T1'], ['T2']]);
  });

  // T1219: an ungated wait is its session's or its leader's, never asked of the owner.
  it("leaves out a wait on the owner's decision whose card names no gate, unless gates are not required", () => {
    const tasks = [ownerWait('T1', '2030-01-08T09:00:00.000Z'), ownerWait('T2', '2030-01-08T09:00:00.000Z', { card: TEST_CARD })];
    assert.deepEqual(ids(decisionBatch(inputOf(tasks, undefined)).pending), ['T1']);
    assert.deepEqual(ids(decisionBatch({ ...inputOf([], undefined), registers: [registerOf(tasks, undefined, 'owner', false)] }).pending), ['T1', 'T2']);
  });

  it('counts every wait not yet asked when no batch was ever asked', () => {
    const batch = decisionBatch(inputOf([ownerWait('T1', '2030-01-06T09:00:00.000Z'), ownerWait('T2', '2030-01-08T09:00:00.000Z')], undefined));
    assert.deepEqual([ids(batch.pending), ids(batch.overdue)], [['T1', 'T2'], []]);
  });

  it("holds other teams' waits after the reader's own, each on its own register's owner marker, and names their team", () => {
    const own = ownerWait('T2', '2030-01-08T09:00:00.000Z');
    const web = registerOf([ownerWait('T2', '2030-01-08T09:10:00.000Z', { due: '2030-01-08 12:00' }), ownerWait('T1', '2030-01-08T09:20:00.000Z')], 'web');
    const ui = registerOf([ownerWait('T1', '2030-01-08T09:30:00.000Z'), ownerWait('T3', '2030-01-08T09:30:00.000Z', { waits: [{ kind: 'approval', who: 'human' }] })], 'ui', 'human');
    const batch = decisionBatch(inputOf([own], '2030-01-07T20:00:00.000Z', CHECKPOINTS, [web, ui]));
    assert.deepEqual(ids(batch.pending), ['T2', 'web/T2', 'web/T1', 'ui/T3'], "ui's waits are on its own marker");
    assert.equal(batch.pending[1]?.tree, web.tree);
    const trigger = batch.trigger ?? assert.fail('web/T2 is due before the next batch');
    assert.equal(triggerText(trigger, TimeZone.UTC), 'web/T2 is due Tue 01-08 12:00 UTC, before the next batch');
  });

  it('is not due while its waits came after the last batch time, fewer than batchAt, none due before the next', () => {
    const batch = decisionBatch(inputOf([ownerWait('T1', '2030-01-08T09:00:00.000Z', { due: '2030-01-09' })], '2030-01-07T20:00:00.000Z'));
    assert.deepEqual([batch.trigger, batch.nextAt], [undefined, Date.parse('2030-01-08T13:03:00Z')]);
    assert.equal(nextBatchText(batch, TimeZone.UTC), 'the next batch Tue 01-08 13:03 UTC');
    assert.equal(nextBatchText(batch, JERUSALEM), 'the next batch Tue 01-08 15:03 IST', "on the team's clock");
  });

  it('is due at once for a wait due before the next batch time', () => {
    const urgent = ownerWait('T2', '2030-01-08T09:30:00.000Z', { due: '2030-01-08 12:00' });
    const batch = decisionBatch(inputOf([ownerWait('T1', '2030-01-08T09:00:00.000Z'), urgent], '2030-01-07T20:00:00.000Z'));
    assert.deepEqual(batch.trigger, { kind: 'deadline', task: urgent, team: undefined, due: Date.parse('2030-01-08T12:00:00Z') });
    assert.equal(triggerText(batch.trigger, TimeZone.UTC), 'T2 is due Tue 01-08 12:00 UTC, before the next batch');
  });

  it('with no batch time set, asks at once a wait due within a day, the next meeting at most', () => {
    const config: BatchConfig = { batchTimesUtc: [], batchAt: 5 };
    const today = decisionBatch(inputOf([ownerWait('T1', '2030-01-08T09:00:00.000Z', { due: '2030-01-08' })], undefined, config));
    const later = decisionBatch(inputOf([ownerWait('T1', '2030-01-08T09:00:00.000Z', { due: '2030-01-10' })], undefined, config));
    assert.deepEqual([today.trigger?.kind, later.trigger, later.nextAt], ['deadline', undefined, undefined]);
    assert.equal(nextBatchText(later, TimeZone.UTC), 'the next batch at the daily meeting');
  });

  it('is due once batchAt waits are not yet asked, and never by count at batchAt 0', () => {
    const waits = [ownerWait('T1', '2030-01-08T09:00:00.000Z'), ownerWait('T2', '2030-01-08T09:10:00.000Z')];
    const due = decisionBatch(inputOf(waits, '2030-01-07T20:00:00.000Z', { batchTimesUtc: TIMES, batchAt: 2 }));
    assert.deepEqual(due.trigger, { kind: 'count', pending: 2, batchAt: 2 });
    assert.equal(triggerText(due.trigger, TimeZone.UTC), '2 not yet asked, decisions.batchAt is 2');
    assert.equal(decisionBatch(inputOf(waits, '2030-01-07T20:00:00.000Z', { batchTimesUtc: TIMES, batchAt: 0 })).trigger, undefined);
  });

  it('is due once a batch time passed over a wait pending then', () => {
    const batch = decisionBatch(inputOf([ownerWait('T1', '2030-01-07T18:00:00.000Z')], '2030-01-07T12:00:00.000Z'));
    assert.deepEqual(batch.trigger, { kind: 'time', at: Date.parse('2030-01-07T19:03:00Z') });
    assert.equal(triggerText(batch.trigger, TimeZone.UTC), 'the Mon 01-07 19:03 UTC batch time passed');
    assert.equal(triggerText(batch.trigger, JERUSALEM), 'the Mon 01-07 21:03 IST batch time passed');
  });

  it('asks an overdue wait again at the first batch time after it was asked, not before', () => {
    const overdue = ownerWait('T1', '2030-01-07T11:00:00.000Z', { due: '2030-01-07 18:00' });
    assert.deepEqual(decisionBatch(inputOf([overdue], '2030-01-07T12:00:00.000Z')).trigger, { kind: 'time', at: Date.parse('2030-01-07T19:03:00Z') });
    const askedSince = decisionBatch(inputOf([overdue], '2030-01-07T20:00:00.000Z'));
    assert.deepEqual([ids(askedSince.overdue), askedSince.trigger], [['T1'], undefined]);
  });
});
