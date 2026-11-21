import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EVENT_VERSION, TASK_LINE_VERSION } from './events.ts';
import { FIRST_LAYOUT_VERSION, NEWEST_LAYOUT_VERSION } from './marker.ts';
import { isWritable, lacksEventsOf, readEvents, readRegister, snapshotOf } from './snapshot.ts';

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

  it("keeps a verifying task's proof waits through a re-read of the log, as the line was written", () => {
    const waits = [
      { kind: 'time', at: '2030-01-08 22:10' },
      { kind: 'task', id: 'T9' },
    ];
    const verifying = `{"v":2,"type":"status","id":"T1","at":"2030-01-07T10:00:00.000Z","by":"alpha","status":"verifying","note":"shipped","evidence":null,"skill":null,"proof":"the nightly run is green","waits":${JSON.stringify(waits)}}`;
    const task = readRegister([CREATE_T1, verifying].join('\n')).state.tasks.get('T1');
    assert.deepEqual([task?.status, task?.waits], ['verifying', waits]);
  });

  it('survives a status a newer teamrig added: skipped and counted, its task kept at its last status, writes still allowed', () => {
    const future = DONE_T1.replace('"done"', '"paused"').replace('"T1"', '"T2"').replace('10:00', '12:00');
    const createT2 = CREATE_T1.replace('"T1"', '"T2"').replace('09:00', '11:00');
    const snapshot = readRegister([CREATE_T1, DONE_T1, createT2, future].join('\n'));
    assert.deepEqual([...snapshot.state.tasks.keys()], ['T1', 'T2']);
    assert.equal(snapshot.state.tasks.get('T1')?.status, 'done');
    assert.equal(snapshot.state.tasks.get('T2')?.status, 'open');
    assert.equal(snapshot.state.tasks.get('T2')?.updatedAt, '2030-01-07T11:00:00.000Z');
    assert.deepEqual([snapshot.read.newer, snapshot.read.unreadable, snapshot.read.newestVersion], [1, 0, TASK_LINE_VERSION]);
    assert.equal(isWritable(snapshot.read), true);
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

describe('lacksEventsOf', () => {
  const whole = snapshotOf(readEvents([CREATE_T1, DONE_T1].join('\n')));

  it('finds every event of a task in a whole log, and none to look for of an id it never held', () => {
    assert.equal(lacksEventsOf(whole, 'T1'), false);
    assert.equal(lacksEventsOf(whole, 'T7'), false, 'no archive holds what the log lacks');
  });

  it('sends a task the working set lacks to the history once tasks were left to the archive', () => {
    const working = { ...whole, retired: { count: 3, lastWeek: null } };
    assert.equal(lacksEventsOf(working, 'T7'), true);
    assert.equal(lacksEventsOf(working, 'T1'), false, 'a held task with no event window has its events here');
  });

  it('sends a held task to the history only when it was created before the event window opened', () => {
    const windowFrom = (from: string) => ({ ...whole, window: { from, tasks: whole.state.tasks } });
    assert.equal(lacksEventsOf(windowFrom('2030-01-07T09:30:00.000Z'), 'T1'), true, 'created 09:00, the window opens 09:30');
    assert.equal(lacksEventsOf(windowFrom('2030-01-07T09:00:00.000Z'), 'T1'), false, 'the create event is the first of the window');
    assert.equal(lacksEventsOf(windowFrom('2030-01-07T09:30:00.000Z'), 'T7'), false, 'an unknown id, with nothing retired');
  });
});

describe('readEvents on a rotated log', () => {
  const marker = (after: unknown, v = 3): string => JSON.stringify({ v, type: 'rotated', after, at: '2030-01-08T00:00:00.000Z' });

  it('reads the marker as the segment the log goes on from: no event, no line counted, no newer version', () => {
    const read = readEvents([marker(2), CREATE_T1].join('\n'));
    assert.equal(read.rotatedAfter, 2);
    assert.equal(read.events.length, 1);
    assert.deepEqual([read.unreadable, read.newer, read.newestVersion], [0, 0, TASK_LINE_VERSION]);
  });

  it('reads a log with no marker as never rotated, and keeps the first marker of two', () => {
    assert.equal(readEvents(CREATE_T1).rotatedAfter, 0);
    assert.equal(readEvents([marker(4), marker(5), CREATE_T1].join('\n')).rotatedAfter, 4);
  });

  it('counts a damaged marker as unreadable without blocking writes', () => {
    const read = readEvents([marker('x'), CREATE_T1].join('\n'));
    assert.deepEqual([read.rotatedAfter, read.unreadable, read.newer], [0, 1, 0]);
    assert.equal(read.newestVersion, TASK_LINE_VERSION);
  });

  it('reads a marker of every layout it knows as the segment the log goes on from, and still writes after it', () => {
    for (let v = FIRST_LAYOUT_VERSION; v <= NEWEST_LAYOUT_VERSION; v += 1) {
      const read = readEvents([marker(2, v), CREATE_T1].join('\n'));
      assert.deepEqual([read.rotatedAfter, read.newer, read.newestVersion, isWritable(read)], [2, 0, TASK_LINE_VERSION, true], `v${v}`);
    }
  });

  it('counts a marker from a newer layout as a newer line, which blocks writes', () => {
    const newer = NEWEST_LAYOUT_VERSION + 1;
    const read = readEvents([marker(1, newer), CREATE_T1].join('\n'));
    assert.deepEqual([read.rotatedAfter, read.newer, read.newestVersion, isWritable(read)], [0, 1, newer, false]);
  });
});
