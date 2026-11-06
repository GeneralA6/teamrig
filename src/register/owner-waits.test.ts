import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TimeZone } from '../core/zone.ts';
import { TEST_CARD, TEST_OWNER_CARD } from '../testing/card.ts';
import { testRanking } from '../testing/ranking.ts';
import { testTask } from '../testing/task.ts';
import { JERUSALEM } from '../testing/zone.ts';
import type { Task } from './fold.ts';
import { askableSince, asksOwner, deferredUntil, isUngated, ownerCardsBySession, ownerLater, waitsOnOwner, type OwnerCards } from './owner-waits.ts';
import { TaskTree, type TreeRanking } from './tree.ts';
import { waitContext, type WaitReason } from './waits.ts';

const NOW = Date.parse('2030-01-08T10:00:00Z');
const CONTEXT = waitContext(new Map(), new Date(NOW), TimeZone.UTC);
const ON_OWNER: WaitReason = { kind: 'decision', who: 'owner' };

/** A card on the owner's decision, with its gate, waiting since `statusAt` on the owner and on `times`. */
function decide(times: readonly string[] = [], statusAt = '2030-01-07T09:00:00.000Z') {
  return testTask({ status: 'waiting', waits: [ON_OWNER, ...times.map((at): WaitReason => ({ kind: 'time', at }))], card: TEST_OWNER_CARD, statusAt });
}

describe('the waits on the owner', () => {
  it("knows a task waiting, or a verifying task's proof waiting, on the owner's decision or approval, and no other wait", () => {
    assert.equal(waitsOnOwner(decide(), 'owner'), true);
    assert.equal(waitsOnOwner(testTask({ status: 'waiting', waits: [{ kind: 'approval', who: 'owner' }] }), 'owner'), true);
    assert.equal(waitsOnOwner(testTask({ status: 'waiting', waits: [{ kind: 'decision', who: 'alpha' }] }), 'owner'), false);
    assert.equal(waitsOnOwner(testTask({ status: 'waiting', waits: [{ kind: 'task', id: 'T1' }] }), 'owner'), false);
    assert.equal(waitsOnOwner(testTask({ status: 'verifying', proof: 'the run', waits: [{ kind: 'approval', who: 'owner' }] }), 'owner'), true, "a verifying task's proof");
  });

  it("knows a decision on the owner whose card names no gate, and leaves an approval and a missing card out", () => {
    assert.equal(isUngated(testTask({ status: 'waiting', waits: [ON_OWNER], card: TEST_CARD }), 'owner'), true);
    assert.equal(isUngated(decide(), 'owner'), false, 'a card naming its gate');
    assert.equal(isUngated(testTask({ status: 'waiting', waits: [{ kind: 'approval', who: 'owner' }], card: TEST_CARD }), 'owner'), false, 'an approval');
    assert.equal(isUngated(testTask({ status: 'waiting', waits: [ON_OWNER] }), 'owner'), false, 'no card is NO-CARD');
  });

  it("asks the owner a wait on the owner unless gates are required and its decision's card names none", () => {
    const ungated = testTask({ status: 'waiting', waits: [ON_OWNER], card: TEST_CARD });
    const approval = testTask({ status: 'waiting', waits: [{ kind: 'approval', who: 'owner' }], card: TEST_CARD });
    const uncarded = testTask({ status: 'waiting', waits: [ON_OWNER] });
    assert.deepEqual(
      [decide(), ungated, approval, uncarded].map((task) => asksOwner(task, 'owner', true, CONTEXT)),
      [true, false, true, true],
      'an approval names no gate, and a missing card is NO-CARD',
    );
    assert.equal(asksOwner(ungated, 'owner', false, CONTEXT), true, 'while gates are not required');
    assert.equal(asksOwner(testTask(), 'owner', true, CONTEXT), false);
  });
});

// T1295: the owner puts a card off (Later) with a time wait beside its wait on the owner.
describe('a card the owner put off', () => {
  it('is put off until the latest of its time waits still to come, by time and not by spelling', () => {
    assert.equal(deferredUntil(decide(), CONTEXT), undefined);
    assert.equal(deferredUntil(decide(['2030-01-08 09:00']), CONTEXT), undefined, 'a passed time');
    assert.equal(deferredUntil(decide(['2030-01-08 09:00', '2030-01-09 12:00']), CONTEXT), '2030-01-09 12:00');
    assert.equal(deferredUntil(decide(['2030-01-10', '2030-01-10 08:00']), CONTEXT), '2030-01-10', "a bare day is that day's end");
    assert.equal(deferredUntil(decide(['2030-01-10 08:00', '2030-01-10']), CONTEXT), '2030-01-10');
  });

  it("reads a bare day in the team's zone", () => {
    // 2030-01-08 ends at midnight in Jerusalem (UTC+2), 22:00 UTC: still to come at 10:00 UTC, passed at 23:00 UTC.
    assert.equal(deferredUntil(decide(['2030-01-08']), waitContext(new Map(), new Date(NOW), JERUSALEM)), '2030-01-08');
    assert.equal(deferredUntil(decide(['2030-01-08']), waitContext(new Map(), new Date('2030-01-08T23:00:00Z'), JERUSALEM)), undefined);
  });

  it('is not asked before its time, and is asked once its time passed', () => {
    const later = decide(['2030-01-09 12:00']);
    assert.equal(asksOwner(later, 'owner', true, CONTEXT), false);
    assert.equal(ownerLater(later, 'owner', true, CONTEXT), '2030-01-09 12:00');
    const back = waitContext(new Map(), new Date('2030-01-09T12:00:00Z'), TimeZone.UTC);
    assert.deepEqual([asksOwner(later, 'owner', true, back), ownerLater(later, 'owner', true, back)], [true, undefined]);
  });

  it('is never a Later card when the owner does not hear it', () => {
    const ungated = testTask({ status: 'waiting', waits: [ON_OWNER, { kind: 'time', at: '2030-01-09 12:00' }], card: TEST_CARD });
    const onLead = testTask({ status: 'waiting', waits: [{ kind: 'decision', who: 'lead' }, { kind: 'time', at: '2030-01-09 12:00' }] });
    assert.deepEqual([ownerLater(ungated, 'owner', true, CONTEXT), ownerLater(onLead, 'owner', true, CONTEXT)], [undefined, undefined]);
    assert.equal(ownerLater(ungated, 'owner', false, CONTEXT), '2030-01-09 12:00', 'while gates are not required');
  });

  it('counts as asked from its status time, or from the newest of its passed times when later', () => {
    assert.equal(askableSince(decide(), CONTEXT), Date.parse('2030-01-07T09:00:00Z'));
    assert.equal(askableSince(decide(['2030-01-07 18:00', '2030-01-08 09:00', '2030-01-09 12:00']), CONTEXT), Date.parse('2030-01-08T09:00:00Z'), 'a time still to come counts not');
    assert.equal(askableSince(decide(['2030-01-06 18:00']), CONTEXT), Date.parse('2030-01-07T09:00:00Z'), 'a time passed before its status');
  });
});

/** A card as {@link decide} makes it, as task `id` of session `owner`. */
function cardOf(id: string, owner: string, times: readonly string[] = []): Task {
  return { ...decide(times), id, owner };
}

/** The tree of one read of `tasks` at NOW, in UTC. */
function treeOf(tasks: readonly Task[], ranking?: TreeRanking): TaskTree {
  return new TaskTree(new Map(tasks.map((task) => [task.id, task])), new Date(NOW), TimeZone.UTC, undefined, undefined, ranking);
}

/** A session's cards by id, each put-off one with its time; undefined when the session has none. */
function idsOf(cards: OwnerCards | undefined) {
  return cards === undefined ? undefined : { due: cards.due.map((task) => task.id), later: cards.later.map((card) => [card.task.id, card.until]) };
}

describe("each session's cards on the owner", () => {
  it('groups them by the task owner, those the lead asks now apart from those put off, each with its time', () => {
    const tasks = [cardOf('T1', 'alpha'), cardOf('T2', 'alpha', ['2030-01-09 12:00']), cardOf('T3', 'beta'), testTask({ id: 'T4', owner: 'gamma' })];
    const cards = ownerCardsBySession(tasks, treeOf(tasks), 'owner', true);
    assert.deepEqual([...cards.keys()].sort(), ['alpha', 'beta'], 'a session with none is absent');
    assert.deepEqual(idsOf(cards.get('alpha')), { due: ['T1'], later: [['T2', '2030-01-09 12:00']] });
    assert.deepEqual(idsOf(cards.get('beta')), { due: ['T3'], later: [] });
  });

  it('keeps each list in plan order', () => {
    const tasks = [cardOf('T1', 'alpha'), cardOf('T5', 'alpha'), cardOf('T2', 'alpha', ['2030-01-10']), cardOf('T6', 'alpha', ['2030-01-09 12:00'])];
    const ranking = testRanking({ classes: { T5: 'Roadmap', T6: 'Roadmap' } });
    assert.deepEqual(idsOf(ownerCardsBySession(tasks, treeOf(tasks, ranking), 'owner', true).get('alpha')), {
      due: ['T5', 'T1'],
      later: [
        ['T6', '2030-01-09 12:00'],
        ['T2', '2030-01-10'],
      ],
    });
  });

  it('leaves out a wait on another session, and an ungated card while gates are required', () => {
    const ungated = testTask({ id: 'T1', status: 'waiting', waits: [ON_OWNER], card: TEST_CARD });
    const onLead = testTask({ id: 'T2', status: 'waiting', waits: [{ kind: 'decision', who: 'lead' }] });
    const tasks = [ungated, onLead];
    assert.equal(ownerCardsBySession(tasks, treeOf(tasks), 'owner', true).size, 0);
    assert.deepEqual(idsOf(ownerCardsBySession(tasks, treeOf(tasks), 'owner', false).get('alpha')), { due: ['T1'], later: [] }, 'while gates are not required');
  });

  it('asks a card put off once its time passed', () => {
    const tasks = [cardOf('T1', 'alpha', ['2030-01-08 09:00'])];
    assert.deepEqual(idsOf(ownerCardsBySession(tasks, treeOf(tasks), 'owner', true).get('alpha')), { due: ['T1'], later: [] });
  });
});
