import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { JsonRecord } from '../core/guards.ts';
import { TEST_CARD } from '../testing/card.ts';
import { eventRecord, parseEvent, type EventParse, type RegisterEvent } from './events.ts';

const BASE = { id: 'T3', at: '2030-01-07T09:00:00.000Z', by: 'alpha' };
const TASK = { title: 'A task', description: null, owner: 'alpha', source: 'owner', ref: null, priority: 2, due: null, goals: [], week: null, after: [], size: null, kind: null };

function parse(record: JsonRecord, version = 0): EventParse {
  return parseEvent({ lineNumber: 1, raw: JSON.stringify(record), record, version });
}

function reason(result: EventParse): string {
  return result.kind === 'unreadable' ? result.reason : `parsed as ${result.kind}`;
}

describe('eventRecord', () => {
  it('leaves an empty after and a null description, size or kind off a create line, and keeps ones that hold something', () => {
    const create: RegisterEvent = { ...BASE, v: 2, type: 'create', task: TASK };
    const { after, description, size, kind, ...withoutEither } = TASK;
    assert.deepEqual(eventRecord(create), { ...create, task: withoutEither });
    assert.deepEqual([after, description, size, kind], [[], null, null, null]);
    const marked: RegisterEvent = { ...create, task: { ...TASK, kind: 'critical' } };
    assert.deepEqual(eventRecord(marked), { ...marked, task: { ...withoutEither, kind: 'critical' } });
    const described: RegisterEvent = { ...create, task: { ...TASK, description: 'Why it matters.\nWhat to do.' } };
    assert.deepEqual(eventRecord(described), { ...described, task: { ...withoutEither, description: 'Why it matters.\nWhat to do.' } });
    const planned: RegisterEvent = { ...create, task: { ...TASK, after: ['T1'] } };
    assert.deepEqual(eventRecord(planned), { ...planned, task: { ...withoutEither, after: ['T1'] } });
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

  it('reads the proof of a verifying line, and keeps it off any other status', () => {
    const verifying = parse({ ...BASE, type: 'status', status: 'verifying', note: 'shipped', proof: 'the nightly run' }, 2);
    assert.equal(verifying.kind === 'event' && verifying.event.type === 'status' ? verifying.event.proof : undefined, 'the nightly run');
    const older = parse({ ...BASE, type: 'status', status: 'verifying', note: 'Proof: the nightly run' }, 2);
    assert.equal(older.kind === 'event' && older.event.type === 'status' ? older.event.proof : 'no event', undefined);
    const done = parse({ ...BASE, type: 'status', status: 'done', proof: 'the nightly run' }, 2);
    assert.equal(done.kind === 'event' && done.event.type === 'status' ? done.event.proof : 'no event', undefined);
    assert.match(reason(parse({ ...BASE, type: 'status', status: 'verifying', proof: 3 }, 2)), /proof is not text/);
  });

  it('reads what met a held proof on a start, and keeps it off any other status', () => {
    const start = parse({ ...BASE, type: 'status', status: 'in-progress', met: 'the nightly run is green' }, 2);
    assert.equal(start.kind === 'event' && start.event.type === 'status' ? start.event.met : undefined, 'the nightly run is green');
    const done = parse({ ...BASE, type: 'status', status: 'done', met: 'the nightly run is green' }, 2);
    assert.equal(done.kind === 'event' && done.event.type === 'status' ? done.event.met : 'no event', undefined);
    assert.match(reason(parse({ ...BASE, type: 'status', status: 'in-progress', met: 3 }, 2)), /met is not text/);
  });

  it('reads the follow-ups a status line names, none as an empty list, and refuses anything but task ids', () => {
    const followupsOf = (record: JsonRecord): readonly string[] | undefined | 'no event' => {
      const result = parse({ ...BASE, type: 'status', status: 'done', note: 'ok', ...record }, 2);
      return result.kind === 'event' && result.event.type === 'status' ? result.event.followups : 'no event';
    };
    assert.deepEqual(followupsOf({ followups: ['T4', 'T5'] }), ['T4', 'T5']);
    assert.deepEqual(followupsOf({ followups: [] }), []);
    assert.equal(followupsOf({}), undefined, 'a line from before --followups names none');
    assert.equal(followupsOf({ followups: null }), undefined);
    assert.match(reason(parse({ ...BASE, type: 'status', status: 'done', followups: ['T4', 'next'] }, 2)), /followups is not a list of task ids/);
    assert.match(reason(parse({ ...BASE, type: 'status', status: 'done', followups: 'T4' }, 2)), /followups is not a list of task ids/);
  });

  it("reads the reasons of a waiting line and a verifying line's proof waits, and keeps them off any other status", () => {
    const waits = [
      { kind: 'decision', who: 'owner' },
      { kind: 'task', id: 'T5' },
      { kind: 'time', at: '2030-01-09 12:00' },
    ];
    const waiting = parse({ ...BASE, type: 'status', status: 'waiting', waits }, 2);
    assert.deepEqual(waiting.kind === 'event' && waiting.event.type === 'status' ? waiting.event.waits : undefined, waits);
    const done = parse({ ...BASE, type: 'status', status: 'done', waits }, 2);
    assert.equal(done.kind === 'event' && done.event.type === 'status' ? done.event.waits : 'no event', undefined);
    const verifying = parse({ ...BASE, type: 'status', status: 'verifying', proof: 'the nightly run is green', waits }, 2);
    assert.deepEqual(verifying.kind === 'event' && verifying.event.type === 'status' ? verifying.event.waits : undefined, waits);
    for (const status of ['waiting', 'verifying']) {
      const carded = parse({ ...BASE, type: 'status', status, waits, card: TEST_CARD }, 2);
      assert.deepEqual(carded.kind === 'event' && carded.event.type === 'status' ? carded.event.card : undefined, TEST_CARD, status);
    }
    const closed = parse({ ...BASE, type: 'status', status: 'done', card: TEST_CARD }, 2);
    assert.equal(closed.kind === 'event' && closed.event.type === 'status' ? closed.event.card : 'no event', undefined, 'a card goes only with a wait status');
  });

  it('reads the tasks a task is planned after, on its create line and an update', () => {
    const created = parse({ ...BASE, type: 'create', task: { ...TASK, after: ['T1', 'T2'] } }, 2);
    assert.deepEqual(created.kind === 'event' && created.event.type === 'create' ? created.event.task.after : undefined, ['T1', 'T2']);
    const updated = parse({ ...BASE, type: 'update', changes: { after: [] } }, 2);
    assert.deepEqual(updated, { kind: 'event', event: { ...BASE, v: 2, type: 'update', changes: { after: [] }, note: null } });
  });

  it('reads the description of a create line and of an update, null clearing it, its newlines kept', () => {
    const created = parse({ ...BASE, type: 'create', task: { ...TASK, description: 'Why.\nWhat.' } }, 2);
    assert.equal(created.kind === 'event' && created.event.type === 'create' ? created.event.task.description : undefined, 'Why.\nWhat.');
    const changed = parse({ ...BASE, type: 'update', changes: { description: 'Why now.' } }, 2);
    assert.deepEqual(changed, { kind: 'event', event: { ...BASE, v: 2, type: 'update', changes: { description: 'Why now.' }, note: null } });
    const cleared = parse({ ...BASE, type: 'update', changes: { description: null } }, 2);
    assert.deepEqual(cleared, { kind: 'event', event: { ...BASE, v: 2, type: 'update', changes: { description: null }, note: null } });
    const update: RegisterEvent = { ...BASE, v: 2, type: 'update', changes: { description: 'Why now.' }, note: 'clearer' };
    assert.deepEqual(parse(eventRecord(update), 2), { kind: 'event', event: update });
  });

  it('reads the size of a create line and of an update, null clearing it, and an older line as not sized', () => {
    const created = parse({ ...BASE, type: 'create', task: { ...TASK, size: 2.5 } }, 2);
    assert.equal(created.kind === 'event' && created.event.type === 'create' ? created.event.task.size : undefined, 2.5);
    const { size, ...older } = TASK;
    assert.equal(size, null);
    const old = parse({ ...BASE, type: 'create', task: older }, 2);
    assert.equal(old.kind === 'event' && old.event.type === 'create' ? old.event.task.size : undefined, null);
    assert.deepEqual(parse({ ...BASE, type: 'update', changes: { size: 1 } }, 2), { kind: 'event', event: { ...BASE, v: 2, type: 'update', changes: { size: 1 }, note: null } });
    assert.deepEqual(parse({ ...BASE, type: 'update', changes: { size: null } }, 2), { kind: 'event', event: { ...BASE, v: 2, type: 'update', changes: { size: null }, note: null } });
    const sized: RegisterEvent = { ...BASE, v: 2, type: 'create', task: { ...TASK, size: 0.75 } };
    assert.deepEqual(parse(eventRecord(sized), 2), { kind: 'event', event: sized });
  });

  it('reads the kind of a create line and of an update, and an older line as not marked', () => {
    const marked: RegisterEvent = { ...BASE, v: 2, type: 'create', task: { ...TASK, kind: 'problem' } };
    assert.deepEqual(parse(eventRecord(marked), 2), { kind: 'event', event: marked });
    const { kind, ...older } = TASK;
    assert.equal(kind, null);
    const old = parse({ ...BASE, type: 'create', task: older }, 2);
    assert.equal(old.kind === 'event' && old.event.type === 'create' ? old.event.task.kind : undefined, null);
    assert.deepEqual(parse({ ...BASE, type: 'update', changes: { kind: 'work' } }, 2), { kind: 'event', event: { ...BASE, v: 2, type: 'update', changes: { kind: 'work' }, note: null } });
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
      [{ ...BASE, type: 'create', task: { ...TASK, description: 5 } }, /description is not text/],
      [{ ...BASE, type: 'update', changes: { description: ['why'] } }, /description is not text/],
      [{ ...BASE, type: 'create', task: { ...TASK, size: 0 } }, /bad size 0/],
      [{ ...BASE, type: 'create', task: { ...TASK, size: 101 } }, /bad size 101/],
      [{ ...BASE, type: 'update', changes: { size: '2' } }, /bad size "2"/],
      [{ ...BASE, type: 'create', task: { ...TASK, kind: 'bug' } }, /bad kind "bug"/],
      [{ ...BASE, type: 'update', changes: { kind: 1 } }, /bad kind 1/],
      [{ ...BASE, type: 'status', status: 4 }, /unknown status 4/],
      [{ ...BASE, type: 'status', status: 'Paused!' }, /unknown status "Paused!"/],
      [{ ...BASE, type: 'status', status: 'done', note: 5 }, /note is not text/],
      [{ ...BASE, type: 'update', changes: [] }, /changes is not an object/],
      [{ ...BASE, type: 'update', changes: {}, note: false }, /note is not text/],
      [{ ...BASE, type: 'archive' }, /unknown event type/],
      [{ ...BASE, type: 'status', status: 'waiting', waits: 'owner' }, /waits is not a list/],
      [{ ...BASE, type: 'status', status: 'waiting', waits: ['owner'] }, /a wait is not an object/],
      [{ ...BASE, type: 'status', status: 'waiting', waits: [{ kind: 'review', who: 'owner' }] }, /unknown wait kind "review"/],
      [{ ...BASE, type: 'status', status: 'waiting', waits: [], card: { question: 'which tier' } }, /card needs question, recommend and byDefault as text/],
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

describe('parseEvent: the answer to an approval (T684)', () => {
  it("reads an update's verdict, and an update without one as it was", () => {
    const answered = parse({ ...BASE, type: 'update', changes: {}, note: 'tests green', verdict: 'approved' }, 2);
    assert.deepEqual(answered, { kind: 'event', event: { ...BASE, v: 2, type: 'update', changes: {}, note: 'tests green', verdict: 'approved' } });
    const plain = parse({ ...BASE, type: 'update', changes: {}, note: 'context' }, 2);
    assert.ok(plain.kind === 'event' && !('verdict' in plain.event));
  });

  it('cannot read a verdict it does not know', () => {
    assert.match(reason(parse({ ...BASE, type: 'update', changes: {}, note: 'n', verdict: 'maybe' }, 2)), /unknown approval verdict "maybe"/);
  });

  it('writes the verdict as it is', () => {
    const event: RegisterEvent = { ...BASE, v: 2, type: 'update', changes: {}, note: 'n', verdict: 'declined' };
    assert.deepEqual(eventRecord(event), event);
  });
});
