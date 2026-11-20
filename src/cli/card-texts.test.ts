import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cutTask } from '../register/description-cut.ts';
import type { Task } from '../register/fold.ts';
import { readRegister, type RegisterSnapshot } from '../register/snapshot.ts';
import { testConfig } from '../testing/config.ts';
import { testTask } from '../testing/task.ts';
import { asRead, withCardTexts, withDescriptions } from './card-texts.ts';

const EMPTY = readRegister('');

function snapshotOf(tasks: readonly Task[]): RegisterSnapshot {
  return { ...EMPTY, state: { ...EMPTY.state, tasks: new Map(tasks.map((task) => [task.id, task])) } };
}

/** A history that counts its reads. */
function countedHistory(tasks: readonly Task[]): { readonly history: () => Promise<RegisterSnapshot>; readonly reads: () => number } {
  let reads = 0;
  return {
    history: () => {
      reads += 1;
      return Promise.resolve(snapshotOf(tasks));
    },
    reads: () => reads,
  };
}

const CARD = testTask({ id: 'T1', description: 'which tier ships first', status: 'waiting', waits: [{ kind: 'decision', who: 'owner' }] });
const OTHER = testTask({ id: 'T2', description: 'an imported issue body' });
const PLAIN = testTask({ id: 'T3' });
const WHOLE = [CARD, OTHER, PLAIN];

describe('withDescriptions', () => {
  it('reads no history while no task it shows is cut', async () => {
    const counted = countedHistory(WHOLE);
    const working = snapshotOf([CARD, cutTask(OTHER), PLAIN]);
    assert.equal(await withDescriptions(working, counted.history, (task) => task.id !== 'T2'), working);
    assert.equal(counted.reads(), 0);
  });

  it('gives each cut task it shows its text from one read of the history, and leaves the others cut, in their order', async () => {
    const second = testTask({ id: 'T4', description: 'which day' });
    const counted = countedHistory([...WHOLE, second]);
    const working = snapshotOf([cutTask(CARD), cutTask(OTHER), PLAIN, cutTask(second)]);
    const read = await withDescriptions(working, counted.history, (task) => task.id !== 'T2');
    assert.deepEqual([...read.state.tasks.values()], [CARD, cutTask(OTHER), PLAIN, second]);
    assert.equal(read.state.nextId, working.state.nextId);
    assert.equal(counted.reads(), 1);
  });

  it('leaves a cut task the history lacks as it is', async () => {
    const working = snapshotOf([cutTask(CARD)]);
    const read = await withDescriptions(working, countedHistory([]).history, () => true);
    assert.deepEqual([...read.state.tasks.values()], [cutTask(CARD)]);
  });
});

describe('withCardTexts', () => {
  it("gives the tasks waiting on the team's owner their text, and no other task", async () => {
    const counted = countedHistory(WHOLE);
    const read = { snapshot: snapshotOf([cutTask(CARD), cutTask(OTHER), PLAIN]), history: counted.history, config: testConfig(), team: 'app' };
    const withTexts = await withCardTexts(read);
    assert.deepEqual([...withTexts.snapshot.state.tasks.values()], [CARD, cutTask(OTHER), PLAIN]);
    assert.equal(withTexts.team, 'app');
    assert.equal(counted.reads(), 1);
  });

  it("goes by the read's own owner marker", async () => {
    const counted = countedHistory(WHOLE);
    const read = { snapshot: snapshotOf([cutTask(CARD)]), history: counted.history, config: testConfig({ register: { ownerSource: 'founder' } }) };
    assert.deepEqual([...(await withCardTexts(read)).snapshot.state.tasks.values()], [cutTask(CARD)]);
    assert.equal(counted.reads(), 0);
  });
});

describe('asRead', () => {
  it('returns the register as read, with no read of the history', async () => {
    const counted = countedHistory(WHOLE);
    const read = { snapshot: snapshotOf([cutTask(CARD)]), history: counted.history, config: testConfig() };
    assert.equal(await asRead(read), read);
    assert.equal(counted.reads(), 0);
  });
});
