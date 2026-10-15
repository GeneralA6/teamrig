import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { JsonRecord } from '../core/guards.ts';
import { eventRecord, parseEvent, type EventParse, type RegisterEvent } from './events.ts';

const BASE = { id: 'T3', at: '2030-01-07T09:00:00.000Z', by: 'alpha' };
const TASK = { title: 'A task', owner: 'alpha', source: 'owner', ref: null, priority: 2, due: null, goals: [], week: null, after: [] };

function parse(record: JsonRecord, version = 0): EventParse {
  return parseEvent({ lineNumber: 1, raw: JSON.stringify(record), record, version });
}

function reason(result: EventParse): string {
  return result.kind === 'unreadable' ? result.reason : `parsed as ${result.kind}`;
}

describe('eventRecord', () => {
  it('leaves an empty after off a create line, and keeps one that names tasks', () => {
    const create: RegisterEvent = { ...BASE, v: 2, type: 'create', task: TASK };
    const { after, ...withoutAfter } = TASK;
    assert.deepEqual(eventRecord(create), { ...create, task: withoutAfter });
    assert.deepEqual(after, []);
    const planned: RegisterEvent = { ...create, task: { ...TASK, after: ['T1'] } };
    assert.deepEqual(eventRecord(planned), planned);
    const cleared: RegisterEvent = { ...BASE, v: 2, type: 'update', changes: { after: [] }, note: null };
    assert.deepEqual(eventRecord(cleared), cleared, 'an update that clears the plan keeps it');
  });

  it('reads back as the event it was written from', () => {
    const create: RegisterEvent = { ...BASE, v: 2, type: 'create', task: TASK };
    assert.deepEqual(parse(eventRecord(create), 2), { kind: 'event', event: create });
  });
});

describe('parseEvent', () => {
  it('accepts any positive priority and any goal text: policy is checked on write, not on read', () => {
    const result = parse({ ...BASE, type: 'create', task: { ...TASK, priority: 42, goals: ['anything at all'] } });
    assert.equal(result.kind, 'event');
  });

  it('fills missing optional task fields with null or an empty list', () => {
    const result = parse({ ...BASE, type: 'create', task: { title: 'A task', owner: 'alpha', source: 'owner', priority: 1 } });
    assert.deepEqual(result.kind === 'event' && result.event.type === 'create' ? result.event.task : undefined, {
      ...TASK,
      priority: 1,
    });
  });

  it('reads the tier of a line written before version 2 as its priority', () => {
    const { priority, ...withoutPriority } = TASK;
    const created = parse({ ...BASE, type: 'create', task: { ...withoutPriority, tier: priority } }, 1);
    assert.deepEqual(created, { kind: 'event', event: { ...BASE, v: 1, type: 'create', task: TASK } });
    const updated = parse({ ...BASE, type: 'update', changes: { tier: 4 } });
    assert.deepEqual(updated, { kind: 'event', event: { ...BASE, v: 0, type: 'update', changes: { priority: 4 }, note: null } });
  });

  it('takes priority over tier when a line has both, and judges a tier like a priority', () => {
    const both = parse({ ...BASE, type: 'update', changes: { tier: 4, priority: 1 } }, 2);
    assert.deepEqual(both, { kind: 'event', event: { ...BASE, v: 2, type: 'update', changes: { priority: 1 }, note: null } });
    assert.match(reason(parse({ ...BASE, type: 'update', changes: { tier: 'high' } })), /bad priority "high"/);
  });

  it('reads only the fields an update names', () => {
    const result = parse({ ...BASE, type: 'update', changes: { priority: 4, unknown: 1 } }, 2);
    assert.deepEqual(result, { kind: 'event', event: { ...BASE, v: 2, type: 'update', changes: { priority: 4 }, note: null } });
  });

  it('flags lines from a newer format before looking at them', () => {
    assert.deepEqual(parse({ nothing: 'here' }, 3), { kind: 'newer' });
  });

  it('reads a well-spelled status it does not know as from a newer teamrig, so its task keeps its last status', () => {
    assert.deepEqual(parse({ ...BASE, type: 'status', status: 'paused' }, 2), { kind: 'newer' });
    assert.deepEqual(parse({ ...BASE, type: 'status', status: 'on-hold-later' }, 2), { kind: 'newer' });
  });

  it('reads a blocked line, from before waiting replaced it, as waiting with no reasons', () => {
    assert.deepEqual(parse({ ...BASE, type: 'status', status: 'blocked', note: 'disk' }, 2), {
      kind: 'event',
      event: { ...BASE, v: 2, type: 'status', status: 'waiting', note: 'disk', evidence: null, skill: null },
    });
  });

  it('reads the reasons of a waiting line, and keeps them off any other status', () => {
    const waits = [
      { kind: 'decision', who: 'owner' },
      { kind: 'task', id: 'T5' },
      { kind: 'time', at: '2030-01-09 12:00' },
    ];
    const waiting = parse({ ...BASE, type: 'status', status: 'waiting', waits }, 2);
    assert.deepEqual(waiting.kind === 'event' && waiting.event.type === 'status' ? waiting.event.waits : undefined, waits);
    const done = parse({ ...BASE, type: 'status', status: 'done', waits }, 2);
    assert.equal(done.kind === 'event' && done.event.type === 'status' ? done.event.waits : 'no event', undefined);
  });

  it('reads the tasks a task is planned after, on its create line and an update', () => {
    const created = parse({ ...BASE, type: 'create', task: { ...TASK, after: ['T1', 'T2'] } }, 2);
    assert.deepEqual(created.kind === 'event' && created.event.type === 'create' ? created.event.task.after : undefined, ['T1', 'T2']);
    const updated = parse({ ...BASE, type: 'update', changes: { after: [] } }, 2);
    assert.deepEqual(updated, { kind: 'event', event: { ...BASE, v: 2, type: 'update', changes: { after: [] }, note: null } });
  });

  it('rejects malformed lines with a reason', () => {
    const cases: [JsonRecord, RegExp][] = [
      [{ ...BASE, id: 'T0', type: 'create', task: TASK }, /bad task id/],
      [{ ...BASE, at: 'yesterday', type: 'create', task: TASK }, /bad time/],
      [{ ...BASE, by: '', type: 'create', task: TASK }, /missing author/],
      [{ ...BASE, type: 'create', task: 'x' }, /task is not an object/],
      [{ ...BASE, type: 'create', task: { ...TASK, priority: 0 } }, /bad priority 0/],
      [{ ...BASE, type: 'create', task: { ...TASK, due: '2030-02-30' } }, /bad due/],
      [{ ...BASE, type: 'create', task: { ...TASK, week: 'next' } }, /bad week/],
      [{ ...BASE, type: 'create', task: { ...TASK, goals: [1] } }, /goals is not a list of text/],
      [{ ...BASE, type: 'create', task: { ...TASK, title: '' } }, /title is not text/],
      [{ ...BASE, type: 'status', status: 4 }, /unknown status 4/],
      [{ ...BASE, type: 'status', status: 'Paused!' }, /unknown status "Paused!"/],
      [{ ...BASE, type: 'status', status: 'done', note: 5 }, /note is not text/],
      [{ ...BASE, type: 'update', changes: [] }, /changes is not an object/],
      [{ ...BASE, type: 'update', changes: {}, note: false }, /note is not text/],
      [{ ...BASE, type: 'archive' }, /unknown event type/],
      [{ ...BASE, type: 'status', status: 'waiting', waits: 'owner' }, /waits is not a list/],
      [{ ...BASE, type: 'status', status: 'waiting', waits: ['owner'] }, /a wait is not an object/],
      [{ ...BASE, type: 'status', status: 'waiting', waits: [{ kind: 'review', who: 'owner' }] }, /unknown wait kind "review"/],
      [{ ...BASE, type: 'status', status: 'waiting', waits: [{ kind: 'task', who: 'T5' }] }, /a task wait has no id/],
      [{ ...BASE, type: 'status', status: 'waiting', waits: [{ kind: 'time', at: 'soon' }] }, /soon is not YYYY-MM-DD/],
      [{ ...BASE, type: 'create', task: { ...TASK, after: ['T0'] } }, /after is not a list of task ids/],
      [{ ...BASE, type: 'update', changes: { after: 'T5' } }, /after is not a list of task ids/],
    ];
    for (const [record, expected] of cases) {
      assert.match(reason(parse(record)), expected, JSON.stringify(record));
    }
  });
});
