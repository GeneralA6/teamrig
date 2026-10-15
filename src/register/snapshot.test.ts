import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EVENT_VERSION } from './events.ts';
import { readEvents, readRegister, snapshotOf } from './snapshot.ts';

const CREATE_T1 = `{"v":2,"type":"create","id":"T1","at":"2030-01-07T09:00:00.000Z","by":"lead","task":{"title":"First","owner":"alpha","source":"owner","ref":null,"priority":2,"due":null,"goals":[],"week":null}}`;
const DONE_T1 = `{"v":2,"type":"status","id":"T1","at":"2030-01-07T10:00:00.000Z","by":"alpha","status":"done","note":"shipped","evidence":"commit abc1234","skill":"none"}`;
const ORPHAN = `{"v":2,"type":"status","id":"T9","at":"2030-01-07T11:00:00.000Z","by":"alpha","status":"open"}`;

describe('readRegister', () => {
  it('replays the log into tasks, with the counts teamrig list warns about', () => {
    const snapshot = readRegister([CREATE_T1, DONE_T1, ORPHAN, '{torn', ''].join('\n'));
    assert.deepEqual([...snapshot.state.tasks.keys()], ['T1']);
    assert.equal(snapshot.state.tasks.get('T1')?.status, 'done');
    assert.equal(snapshot.state.tasks.get('T1')?.note, 'shipped');
    assert.equal(snapshot.read.unreadable, 1, 'the torn line');
    assert.equal(snapshot.read.newer, 0);
    assert.equal(snapshot.state.orphans, 1, 'a status for an unknown id');
    assert.equal(snapshot.state.nextId, 'T10', 'the orphan id stays reserved');
  });

  it('skips a line from a newer teamrig, counts it and keeps its id reserved', () => {
    const newer = CREATE_T1.replace('"v":2', `"v":${EVENT_VERSION + 1}`).replace('"T1"', '"T4"');
    const snapshot = readRegister([CREATE_T1, newer].join('\n'));
    assert.deepEqual([...snapshot.state.tasks.keys()], ['T1']);
    assert.equal(snapshot.read.newer, 1);
    assert.equal(snapshot.read.unreadable, 0);
    assert.equal(snapshot.read.newestVersion, EVENT_VERSION + 1);
    assert.equal(snapshot.state.nextId, 'T5');
  });

  it('reads an empty log as an empty register', () => {
    const snapshot = readRegister('');
    assert.equal(snapshot.state.tasks.size, 0);
    assert.equal(snapshot.state.nextId, 'T1');
  });
});

describe('snapshotOf', () => {
  it('folds a read it is handed, keeping the read beside the state', () => {
    const read = readEvents(CREATE_T1);
    const snapshot = snapshotOf(read);
    assert.equal(snapshot.read, read);
    assert.equal(snapshot.state.tasks.get('T1')?.priority, 2);
  });
});

describe('readEvents on a rotated log', () => {
  const marker = (after: unknown, v = 3): string => JSON.stringify({ v, type: 'rotated', after, at: '2030-01-08T00:00:00.000Z' });

  it('reads the marker as the segment the log goes on from: no event, no line counted, no newer version', () => {
    const read = readEvents([marker(2), CREATE_T1].join('\n'));
    assert.equal(read.rotatedAfter, 2);
    assert.equal(read.events.length, 1);
    assert.deepEqual([read.unreadable, read.newer, read.newestVersion], [0, 0, EVENT_VERSION]);
  });

  it('reads a log with no marker as never rotated, and keeps the first marker of two', () => {
    assert.equal(readEvents(CREATE_T1).rotatedAfter, 0);
    assert.equal(readEvents([marker(4), marker(5), CREATE_T1].join('\n')).rotatedAfter, 4);
  });

  it('counts a damaged marker as unreadable without blocking writes', () => {
    const read = readEvents([marker('x'), CREATE_T1].join('\n'));
    assert.deepEqual([read.rotatedAfter, read.unreadable, read.newer], [0, 1, 0]);
    assert.equal(read.newestVersion, EVENT_VERSION);
  });

  it('counts a marker from a newer layout as a newer line, which blocks writes', () => {
    const read = readEvents([marker(1, 4), CREATE_T1].join('\n'));
    assert.deepEqual([read.rotatedAfter, read.newer, read.newestVersion], [0, 1, 4]);
  });
});
