import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { JsonRecord } from '../core/guards.ts';
import { parseEvent, type EventParse } from './events.ts';

const BASE = { id: 'T3', at: '2030-01-07T09:00:00.000Z', by: 'alpha' };
const TASK = { title: 'A task', owner: 'alpha', source: 'owner', ref: null, priority: 2, due: null, goals: [], week: null };

function parse(record: JsonRecord, version = 0): EventParse {
  return parseEvent({ lineNumber: 1, raw: JSON.stringify(record), record, version });
}

function reason(result: EventParse): string {
  return result.kind === 'unreadable' ? result.reason : `parsed as ${result.kind}`;
}

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
      [{ ...BASE, type: 'status', status: 'paused' }, /unknown status/],
      [{ ...BASE, type: 'status', status: 'done', note: 5 }, /note is not text/],
      [{ ...BASE, type: 'update', changes: [] }, /changes is not an object/],
      [{ ...BASE, type: 'update', changes: {}, note: false }, /note is not text/],
      [{ ...BASE, type: 'archive' }, /unknown event type/],
    ];
    for (const [record, expected] of cases) {
      assert.match(reason(parse(record)), expected, JSON.stringify(record));
    }
  });
});
