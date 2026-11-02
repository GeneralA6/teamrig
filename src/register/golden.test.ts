import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { EVENT_VERSION } from './events.ts';
import { foldEvents } from './fold.ts';
import { isWritable, readEvents } from './snapshot.ts';

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
      description: null,
      owner: 'alpha',
      source: 'owner',
      ref: 'inbox/alpha.md:1',
      priority: 1,
      due: '2030-01-09 12:00',
      goals: ['G1'],
      noGoal: false,
      week: '2030-01-07',
      after: [],
      size: null,
      type: null,
      critical: false,
      pin: null,
      review: {},
      reparks: 0,
      watch: null,
      status: 'done',
      note: 'health check live',
      evidence: 'commit abc1234; 12 tests',
      skill: 'none',
      waits: [],
      card: null,
      answer: null,
      decided: null,
      proof: null,
      followups: [],
      startedAt: '2030-01-07T10:00:00.000Z',
      createdAt: '2030-01-07T09:00:00.000Z',
      createdBy: 'lead',
      updatedAt: '2030-01-08T16:00:00.000Z',
      updatedBy: 'alpha',
      assignedAt: '2030-01-07T09:00:00.000Z',
      statusAt: '2030-01-08T16:00:00.000Z',
      priorityAt: '2030-01-07T09:00:00.000Z',
      ownerSeenAt: '2030-01-08T16:00:00.000Z',
    });
    const t2 = state.tasks.get('T2');
    assert.equal(t2?.status, 'waiting', 'a blocked line reads as waiting');
    assert.deepEqual(t2?.waits, [], 'with no reasons: blocked had none');
    assert.equal(t2?.skill, null, 'a status line without skill reads as null');
    assert.equal(t2?.ownerSeenAt, '2030-01-08T17:00:00.000Z');
  });

  it('reads a version 1 log; its made-up version 2 line is now current and unreadable', async () => {
    const read = readEvents(await fixture('events-v1.jsonl'));
    assert.equal(read.events.length, 5);
    assert.deepEqual(read.events.map((event) => event.v), [1, 0, 1, 1, 1]);
    // The fixture stays byte-identical. Its last line stood in for a newer release while version 1
    // was current; version 2 is current now, and that line lacks the source and priority a create needs.
    assert.equal(read.unreadable, 1);
    assert.equal(read.newer, 0);
    assert.equal(read.newestVersion, 2);
    assert.equal(isWritable(read), true);

    const state = foldEvents(read.events, read.seenIds);
    assert.equal(state.nextId, 'T4');
    const t2 = state.tasks.get('T2');
    assert.equal(t2?.owner, 'alpha');
    assert.equal(t2?.status, 'in-progress');
    assert.equal(t2?.assignedAt, '2030-01-07T11:00:00.000Z', 'an owner change restarts the pick-up clock');
    assert.equal(t2?.ownerSeenAt, '2030-01-07T12:00:00.000Z');
    assert.equal(t2?.statusAt, '2030-01-07T12:00:00.000Z');
    assert.equal(t2?.priorityAt, '2030-01-07T09:05:00.000Z');
    assert.equal(state.tasks.get('T1')?.priority, 1, 'the tier of a version 1 line reads as its priority');
  });

  it('reads a version 2 log beside older tier lines, skips newer lines and refuses to write beside them', async () => {
    const newer = JSON.stringify({ v: EVENT_VERSION + 1, type: 'create', id: 'T3', at: '2030-01-07T12:00:00.000Z', by: 'lead', task: { title: 'Written by a newer release', owner: 'alpha' }, newField: true });
    const read = readEvents(`${await fixture('events-v2.jsonl')}${newer}\n`);
    assert.deepEqual(read.events.map((event) => event.v), [1, 2, 2, 2]);
    assert.equal(read.unreadable, 0);
    assert.equal(read.newer, 1);
    assert.equal(read.newestVersion, EVENT_VERSION + 1);
    assert.equal(isWritable(read), false);

    const state = foldEvents(read.events, read.seenIds);
    assert.equal(state.nextId, 'T4');
    assert.deepEqual(
      [...state.tasks.values()].map((task) => [task.id, task.priority, task.status]),
      [
        ['T1', 4, 'in-progress'],
        ['T2', 2, 'open'],
      ],
    );
    const t1 = state.tasks.get('T1');
    assert.deepEqual([t1?.priorityAt, t1?.statusAt], ['2030-01-07T10:00:00.000Z', '2030-01-07T11:00:00.000Z']);
  });

  it('reads a version 3 log: a moved task leaves the register, a later line on it is an orphan, writes still allowed', async () => {
    const read = readEvents(await fixture('events-v3.jsonl'));
    assert.deepEqual(
      read.events.map((event) => [event.type, event.v]),
      [
        ['create', 2],
        ['create', 2],
        ['status', 2],
        ['moved', 3],
        ['status', 2],
        ['status', 2],
      ],
    );
    assert.deepEqual([read.unreadable, read.newer, read.newestVersion], [0, 0, 3]);
    assert.ok(isWritable(read));

    const state = foldEvents(read.events, read.seenIds);
    assert.deepEqual([...state.tasks.keys()], ['T1']);
    assert.deepEqual([...state.moved], [['T2', 'web']]);
    assert.equal(state.orphans, 1, 'the status written on T2 after it moved');
    assert.equal(state.nextId, 'T3', 'the moved id stays taken');
    assert.equal(state.tasks.get('T1')?.status, 'in-progress');
  });
});
