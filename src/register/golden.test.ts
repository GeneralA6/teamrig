import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { foldEvents } from './fold.ts';
import { isWritable, readEvents } from './store.ts';

/** Golden logs, one per format version: every later release must read them to exactly this state. */
async function fixture(name: string): Promise<string> {
  return readFile(new URL(`./testdata/${name}`, import.meta.url), 'utf8');
}

describe('golden register logs', () => {
  it('reads a version 0 log unchanged', async () => {
    const read = readEvents(await fixture('events-v0.jsonl'));
    assert.equal(read.events.length, 8);
    assert.equal(read.unreadable, 2, 'a torn line and an unknown event type');
    assert.equal(read.newer, 0);
    assert.ok(isWritable(read));

    const state = foldEvents(read.events, read.seenIds);
    assert.equal(state.orphans, 2, 'a status for an unknown id and a second create');
    assert.equal(state.nextId, 'T10', 'ids on orphans and unreadable lines stay reserved');
    assert.deepEqual([...state.tasks.keys()], ['T1', 'T2']);
    assert.deepEqual(state.tasks.get('T1'), {
      id: 'T1',
      title: 'Add a health check to the web service',
      owner: 'alpha',
      source: 'owner',
      ref: 'inbox/alpha.md:1',
      tier: 1,
      due: '2030-01-09 12:00',
      goals: ['G1'],
      week: '2030-01-07',
      status: 'done',
      note: 'health check live',
      evidence: 'commit abc1234; 12 tests',
      skill: 'none',
      createdAt: '2030-01-07T09:00:00.000Z',
      createdBy: 'lead',
      updatedAt: '2030-01-08T16:00:00.000Z',
      updatedBy: 'alpha',
      assignedAt: '2030-01-07T09:00:00.000Z',
      ownerSeenAt: '2030-01-08T16:00:00.000Z',
    });
    const t2 = state.tasks.get('T2');
    assert.equal(t2?.status, 'blocked');
    assert.equal(t2?.skill, null, 'a status line without skill reads as null');
    assert.equal(t2?.ownerSeenAt, '2030-01-08T17:00:00.000Z');
  });

  it('reads a version 1 log, skips newer lines and refuses to write beside them', async () => {
    const read = readEvents(await fixture('events-v1.jsonl'));
    assert.equal(read.events.length, 5);
    assert.deepEqual(read.events.map((event) => event.v), [1, 0, 1, 1, 1]);
    assert.equal(read.unreadable, 0);
    assert.equal(read.newer, 1);
    assert.equal(read.newestVersion, 2);
    assert.equal(isWritable(read), false);

    const state = foldEvents(read.events, read.seenIds);
    assert.equal(state.nextId, 'T4');
    const t2 = state.tasks.get('T2');
    assert.equal(t2?.owner, 'alpha');
    assert.equal(t2?.status, 'in-progress');
    assert.equal(t2?.assignedAt, '2030-01-07T11:00:00.000Z', 'an owner change restarts the pick-up clock');
    assert.equal(t2?.ownerSeenAt, '2030-01-07T12:00:00.000Z');
  });
});
