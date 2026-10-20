import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { DecisionsConfig } from '../config/types.ts';
import { TimeZone } from '../core/zone.ts';
import type { Task } from '../register/fold.ts';
import { TaskTree } from '../register/tree.ts';
import { TEST_CARD } from '../testing/card.ts';
import { testTask } from '../testing/task.ts';
import { JERUSALEM } from '../testing/zone.ts';
import { decisionBatch } from './batch.ts';
import { batchHead, batchLines, checkDecisionLines, timingText, waitTiming, type BatchView } from './lines.ts';

const NOW = Date.parse('2030-01-08T10:00:00Z');
const CHECKPOINTS: DecisionsConfig = { batchTimesUtc: ['13:03', '19:03'], batchAt: 5 };
/** After the 19:03 batch time of the day before, so a wait set since is not yet due. */
const ASKED_AT = Date.parse('2030-01-07T20:00:00Z');

function ownerWait(id: string, statusAt: string, overrides: Partial<Task> = {}): Task {
  return testTask({ id, title: `Decide ${id}`, status: 'waiting', waits: [{ kind: 'decision', who: 'owner' }], card: TEST_CARD, statusAt, ...overrides });
}

function viewOf(tasks: readonly Task[], config: DecisionsConfig = CHECKPOINTS): BatchView {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const tree = new TaskTree(byId, new Date(NOW), TimeZone.UTC);
  const batch = decisionBatch({ tasks, tree, now: NOW, askedAt: ASKED_AT, ownerMarker: 'owner', config });
  return { batch, tree, byId, ownerMarker: 'owner', command: 'teamrig', lead: 'lead', zone: TimeZone.UTC };
}

describe('the decisions listing', () => {
  it('heads with the counts and when the next batch is, alone when nothing waits on the owner', () => {
    assert.deepEqual(batchLines(viewOf([])), ['DECISIONS 0 to ask owner, 0 asked and past due; the next batch Tue 01-08 13:03 UTC']);
  });

  it('lists the waits not yet asked, then the asked ones past due, each as card facts, then how to ask and record', () => {
    const fresh = ownerWait('T1', '2030-01-08T09:00:00.000Z');
    const late = ownerWait('T2', '2030-01-07T11:00:00.000Z', { due: '2030-01-07' });
    const lines = batchLines(viewOf([fresh, late]));
    assert.equal(lines[0], 'DECISIONS 1 to ask owner, 1 asked and past due; the next batch Tue 01-08 13:03 UTC');
    assert.equal(lines[1], 'NOT YET ASKED');
    assert.match(lines[2] ?? '', /^ {2}T1 waiting, p2, owner alpha \| Decide T1/);
    assert.ok(lines.includes(`    decide: ${TEST_CARD.question}`), lines.join('\n'));
    const past = lines.indexOf('PAST DUE, asked before: ask again');
    assert.ok(past > 2, lines.join('\n'));
    assert.match(lines[past + 1] ?? '', /^ {2}T2 waiting, p2, owner alpha, due 01-07 \| Decide T2/);
    assert.deepEqual(lines.slice(-2), [
      '  Ask owner these together, each card as it stands, each figure explained; then teamrig decisions asked --session lead records the batch asked.',
      '  Record each answer in the same turn: teamrig update <id> --note "owner decided: <decision>" --session lead.',
    ]);
  });
});

describe("the lead's check line", () => {
  it('names the batch due and why, and says nothing while it waits for the next', () => {
    const waits = [ownerWait('T1', '2030-01-08T09:00:00.000Z'), ownerWait('T2', '2030-01-08T09:10:00.000Z')];
    assert.deepEqual(checkDecisionLines(viewOf(waits).batch, 'teamrig', 'lead', TimeZone.UTC), []);
    assert.deepEqual(checkDecisionLines(viewOf(waits, { batchTimesUtc: [], batchAt: 2 }).batch, 'teamrig', 'lead', TimeZone.UTC), [
      'DECISIONS batch due (2 not yet asked, decisions.batchAt is 2): 2 to ask, 0 past due; teamrig decisions --session lead',
    ]);
  });
});

describe('when the owner hears of a new wait', () => {
  it('at once when it is due before the next batch, in the batch due now, else in the next batch', () => {
    const urgent = ownerWait('T1', '2030-01-08T09:50:00.000Z', { due: '2030-01-08 12:00' });
    const view = viewOf([urgent]);
    const atOnce = waitTiming(view.batch, urgent, view.tree, NOW);
    assert.deepEqual(atOnce, { kind: 'at-once', due: Date.parse('2030-01-08T12:00:00Z') });
    assert.equal(timingText(atOnce, TimeZone.UTC), 'AT ONCE, due Tue 01-08 12:00 UTC before the next batch');
    assert.equal(timingText(atOnce, JERUSALEM), 'AT ONCE, due Tue 01-08 14:00 IST before the next batch', "on the team's clock");

    const calm = ownerWait('T2', '2030-01-08T09:50:00.000Z');
    const counted = viewOf([ownerWait('T3', '2030-01-08T09:00:00.000Z'), calm], { batchTimesUtc: CHECKPOINTS.batchTimesUtc, batchAt: 2 });
    assert.equal(timingText(waitTiming(counted.batch, calm, counted.tree, NOW), TimeZone.UTC), 'BATCH DUE: 2 not yet asked, decisions.batchAt is 2');

    const next = viewOf([calm]);
    const later = waitTiming(next.batch, calm, next.tree, NOW);
    assert.equal(timingText(later, TimeZone.UTC), 'asked in the next batch Tue 01-08 13:03 UTC');
    assert.equal(timingText(later, JERUSALEM), 'asked in the next batch Tue 01-08 15:03 IST');
  });

  it('asks a wait due within a day at once when no batch time is set', () => {
    const today = ownerWait('T1', '2030-01-08T09:50:00.000Z', { due: '2030-01-08' });
    const view = viewOf([today], { batchTimesUtc: [], batchAt: 5 });
    assert.equal(waitTiming(view.batch, today, view.tree, NOW).kind, 'at-once');
    assert.equal(batchHead(viewOf([], { batchTimesUtc: [], batchAt: 5 }).batch, 'owner', TimeZone.UTC), 'DECISIONS 0 to ask owner, 0 asked and past due; the next batch at the daily meeting');
  });
});
