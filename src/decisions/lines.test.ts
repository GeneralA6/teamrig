import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_FOCUS } from '../config/defaults.ts';
import { TimeZone } from '../core/zone.ts';
import type { Task } from '../register/fold.ts';
import { TaskTree } from '../register/tree.ts';
import { TEST_OWNER_CARD } from '../testing/card.ts';
import { testTask } from '../testing/task.ts';
import { JERUSALEM } from '../testing/zone.ts';
import { decisionBatch, type BatchConfig } from './batch.ts';
import { batchHead, batchLines, checkDecisionLines, timingText, waitTiming, type BatchView } from './lines.ts';

const NOW = Date.parse('2030-01-08T10:00:00Z');
const CHECKPOINTS: BatchConfig = { batchTimesUtc: ['13:03', '19:03'], batchAt: 5 };
/** After the 19:03 batch time of the day before, so a wait set since is not yet due. */
const ASKED_AT = Date.parse('2030-01-07T20:00:00Z');

function ownerWait(id: string, statusAt: string, overrides: Partial<Task> = {}): Task {
  return testTask({ id, title: `Decide ${id}`, status: 'waiting', waits: [{ kind: 'decision', who: 'owner' }], card: TEST_OWNER_CARD, statusAt, ...overrides });
}

/**
 * The view of a batch of `tasks` whose Improvements day is a Wednesday (NOW is a Tuesday), with the tree it was judged
 * on, which a new wait's timing reads.
 */
function viewOf(tasks: readonly Task[], config: BatchConfig = CHECKPOINTS): BatchView & { readonly tree: TaskTree } {
  const tree = new TaskTree(new Map(tasks.map((task) => [task.id, task])), new Date(NOW), TimeZone.UTC);
  const register = { team: undefined, tasks, tree, ownerMarker: 'owner', requireGate: true, focus: DEFAULT_FOCUS, dedicatedOwners: [] };
  const batch = decisionBatch({ registers: [register], now: NOW, askedAt: ASKED_AT, config, improvementsDay: 'wed' });
  return { batch, tree, ownerMarker: 'owner', command: 'teamrig', lead: 'lead', askedBy: undefined, zone: TimeZone.UTC, runFiles: new Map() };
}

/** A new wait of the batch's own register. */
function ownOf(task: Task): { readonly task: Task; readonly team: undefined } {
  return { task, team: undefined };
}

const IMPROVEMENTS = { workClass: 'Improvements' } as const;
const WEEKLY_LINE = 'IMPROVEMENTS 1 held for the weekly Improvements batch on wed UTC (focus.improvementsDay): T5';

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
    assert.ok(lines.includes(`    decide: ${TEST_OWNER_CARD.question}`), lines.join('\n'));
    const past = lines.indexOf('PAST DUE, asked before: ask again');
    assert.ok(past > 2, lines.join('\n'));
    assert.match(lines[past + 1] ?? '', /^ {2}T2 waiting, p2, owner alpha, due 01-07 \| Decide T2/);
    assert.deepEqual(lines.slice(-3), [
      '  Ask owner these together, each card as it stands, each figure explained; then teamrig decisions asked --session lead records the batch asked.',
      '  Record each answer in the same turn: teamrig update <id> --decided --note "owner decided: <decision>" --session lead; the card leaves the batches.',
      // T1295: a card the owner puts off leaves the batches until its date.
      '  A card owner puts off to a date: teamrig update <id> --later <date> --note "owner put it off: <why>" --session lead; no batch asks it before then.',
    ]);
  });

  it("names in a child team the lead at its tree's root, who asks the waits and records each answer (T1018)", () => {
    const lines = batchLines({ ...viewOf([ownerWait('T1', '2030-01-08T09:00:00.000Z')]), askedBy: 'app/lead' });
    assert.deepEqual(lines.slice(-1), ['  app/lead asks owner these in its batches and records each answer on its task as decided: "owner decided: <decision>".']);
    assert.ok(!lines.some((line) => line.includes('decisions asked')), lines.join('\n'));
  });

  // T2113: the waits held for the weekly Improvements batch, named after the head.
  it('names after the head the waits held for the weekly Improvements batch, alone or before the ones to ask', () => {
    const held = ownerWait('T5', '2030-01-08T09:00:00.000Z', IMPROVEMENTS);
    assert.deepEqual(batchLines(viewOf([held])), ['DECISIONS 0 to ask owner, 0 asked and past due; the next batch Tue 01-08 13:03 UTC', WEEKLY_LINE]);
    const lines = batchLines(viewOf([held, ownerWait('T1', '2030-01-08T09:00:00.000Z')]));
    assert.deepEqual(lines.slice(0, 3), ['DECISIONS 1 to ask owner, 0 asked and past due; the next batch Tue 01-08 13:03 UTC', WEEKLY_LINE, 'NOT YET ASKED']);
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
    const atOnce = waitTiming(view.batch, ownOf(urgent), view.tree, NOW);
    assert.deepEqual(atOnce, { kind: 'at-once', due: Date.parse('2030-01-08T12:00:00Z') });
    assert.equal(timingText(atOnce, TimeZone.UTC), 'AT ONCE, due Tue 01-08 12:00 UTC before the next batch');
    assert.equal(timingText(atOnce, JERUSALEM), 'AT ONCE, due Tue 01-08 14:00 IST before the next batch', "on the team's clock");

    const calm = ownerWait('T2', '2030-01-08T09:50:00.000Z');
    const counted = viewOf([ownerWait('T3', '2030-01-08T09:00:00.000Z'), calm], { batchTimesUtc: CHECKPOINTS.batchTimesUtc, batchAt: 2 });
    assert.equal(timingText(waitTiming(counted.batch, ownOf(calm), counted.tree, NOW), TimeZone.UTC), 'BATCH DUE: 2 not yet asked, decisions.batchAt is 2');

    const next = viewOf([calm]);
    const later = waitTiming(next.batch, ownOf(calm), next.tree, NOW);
    assert.equal(timingText(later, TimeZone.UTC), 'asked in the next batch Tue 01-08 13:03 UTC');
    assert.equal(timingText(later, JERUSALEM), 'asked in the next batch Tue 01-08 15:03 IST');
  });

  it('asks a wait due within a day at once when no batch time is set', () => {
    const today = ownerWait('T1', '2030-01-08T09:50:00.000Z', { due: '2030-01-08' });
    const view = viewOf([today], { batchTimesUtc: [], batchAt: 5 });
    assert.equal(waitTiming(view.batch, ownOf(today), view.tree, NOW).kind, 'at-once');
    assert.equal(batchHead(viewOf([], { batchTimesUtc: [], batchAt: 5 }).batch, 'owner', TimeZone.UTC), 'DECISIONS 0 to ask owner, 0 asked and past due; the next batch at the daily meeting');
  });

  // T2113: the batch asks no held wait, so the lead's line says so even for one due before the next batch.
  it('in the weekly Improvements batch while the batch holds it there, even when due before the next batch', () => {
    const held = ownerWait('T5', '2030-01-08T09:50:00.000Z', { ...IMPROVEMENTS, due: '2030-01-08 12:00' });
    const view = viewOf([held]);
    const weekly = waitTiming(view.batch, ownOf(held), view.tree, NOW);
    assert.deepEqual(weekly, { kind: 'weekly', day: 'wed' });
    assert.equal(timingText(weekly, TimeZone.UTC), 'asked in the weekly Improvements batch on wed UTC (focus.improvementsDay)');
    assert.equal(waitTiming(view.batch, { task: held, team: 'web' }, view.tree, NOW).kind, 'at-once', "web's T5 is another task than the batch's own T5");
  });
});
