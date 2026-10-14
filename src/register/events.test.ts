import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { JsonRecord } from '../core/guards.ts';
import { parseEvent, type EventParse } from './events.ts';

const BASE = { id: 'T3', at: '2030-01-07T09:00:00.000Z', by: 'alpha' };
const TASK = { title: 'A task', owner: 'alpha', source: 'owner', ref: null, tier: 2, due: null, goals: [], week: null };

function parse(record: JsonRecord, version = 0): EventParse {
  return parseEvent({ lineNumber: 1, raw: JSON.stringify(record), record, version });
}

function reason(result: EventParse): string {
  return result.kind === 'unreadable' ? result.reason : `parsed as ${result.kind}`;
}

describe('parseEvent', () => {
  it('accepts any positive tier and any goal text: policy is checked on write, not on read', () => {
    const result = parse({ ...BASE, type: 'create', task: { ...TASK, tier: 42, goals: ['anything at all'] } });
    assert.equal(result.kind, 'event');
  });

  it('fills missing optional task fields with null or an empty list', () => {
    const result = parse({ ...BASE, type: 'create', task: { title: 'A task', owner: 'alpha', source: 'owner', tier: 1 } });
    assert.deepEqual(result.kind === 'event' && result.event.type === 'create' ? result.event.task : undefined, {
      ...TASK,
      tier: 1,
    });
  });

  it('reads only the fields an update names', () => {
    const result = parse({ ...BASE, type: 'update', changes: { tier: 4, unknown: 1 } }, 1);
    assert.deepEqual(result, { kind: 'event', event: { ...BASE, v: 1, type: 'update', changes: { tier: 4 }, note: null } });
  });

  it('flags lines from a newer format before looking at them', () => {
    assert.deepEqual(parse({ nothing: 'here' }, 2), { kind: 'newer' });
  });

  it('rejects malformed lines with a reason', () => {
    const cases: [JsonRecord, RegExp][] = [
      [{ ...BASE, id: 'T0', type: 'create', task: TASK }, /bad task id/],
      [{ ...BASE, at: 'yesterday', type: 'create', task: TASK }, /bad time/],
      [{ ...BASE, by: '', type: 'create', task: TASK }, /missing author/],
      [{ ...BASE, type: 'create', task: 'x' }, /task is not an object/],
      [{ ...BASE, type: 'create', task: { ...TASK, tier: 0 } }, /bad tier 0/],
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
