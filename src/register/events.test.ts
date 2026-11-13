import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { JsonRecord } from '../core/guards.ts';
import { TEST_CARD } from '../testing/card.ts';
import { EVENT_VERSION, eventRecord, parseEvent, TASK_LINE_VERSION, type EventParse, type RegisterEvent } from './events.ts';

const BASE = { id: 'T3', at: '2030-01-07T09:00:00.000Z', by: 'alpha' };
const TASK = { title: 'A task', description: null, owner: 'alpha', source: 'owner', ref: null, priority: 2, due: null, goals: [], noGoal: false, week: null, after: [], size: null, type: null, critical: false, pin: null, workClass: null, prepares: null };

function parse(record: JsonRecord, version = 0): EventParse {
  return parseEvent({ lineNumber: 1, raw: JSON.stringify(record), record, version });
}

function reason(result: EventParse): string {
  return result.kind === 'unreadable' ? result.reason : `parsed as ${result.kind}`;
}

/** The type and critical mark a parsed create line gives its task; undefined for any other parse. */
function createdMark(result: EventParse): [string | null, boolean] | undefined {
  return result.kind === 'event' && result.event.type === 'create' ? [result.event.task.type, result.event.task.critical] : undefined;
}

describe('eventRecord', () => {
  it('leaves an empty after, a null description, size, type, pin or workClass and a false critical or noGoal off a create line, and keeps ones that hold something', () => {
    const create: RegisterEvent = { ...BASE, v: 2, type: 'create', task: TASK };
    const { after, description, size, type, critical, noGoal, pin, workClass, prepares, ...withoutEither } = TASK;
    assert.deepEqual(eventRecord(create), { ...create, task: withoutEither });
    assert.deepEqual([after, description, size, type, critical, noGoal, pin, workClass, prepares], [[], null, null, null, false, false, null, null, null]);
    const marked: RegisterEvent = { ...create, task: { ...TASK, type: 'bug', critical: true } };
    assert.deepEqual(eventRecord(marked), { ...marked, task: { ...withoutEither, type: 'bug', critical: true } });
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
  it('accepts any priority from 0 and any goal text: policy is checked on write, not on read', () => {
    const result = parse({ ...BASE, type: 'create', task: { ...TASK, priority: 42, goals: ['anything at all'] } });
    assert.equal(result.kind, 'event');
    assert.equal(parse({ ...BASE, type: 'create', task: { ...TASK, priority: 0 } }).kind, 'event', "teamrig's p0");
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
    assert.deepEqual(parse({ nothing: 'here' }, EVENT_VERSION + 1), { kind: 'newer' });
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

  it('reads a start\'s one-commit mark, keeps it off any other status, and refuses one that is no boolean (T2110)', () => {
    const start = parse({ ...BASE, type: 'status', status: 'in-progress', oneCommit: true }, 2);
    assert.equal(start.kind === 'event' && start.event.type === 'status' ? start.event.oneCommit : undefined, true);
    const unmarked = parse({ ...BASE, type: 'status', status: 'in-progress', oneCommit: false }, 2);
    assert.equal(unmarked.kind === 'event' && 'oneCommit' in unmarked.event, false);
    const done = parse({ ...BASE, type: 'status', status: 'done', oneCommit: true }, 2);
    assert.equal(done.kind === 'event' && 'oneCommit' in done.event, false);
    assert.match(reason(parse({ ...BASE, type: 'status', status: 'in-progress', oneCommit: 'yes' }, 2)), /bad oneCommit "yes"/);
  });

  it('reads the sighting a done line is watched for, and keeps it off any other status (T1306)', () => {
    const done = parse({ ...BASE, type: 'status', status: 'done', watch: 'the row shows' }, 2);
    assert.equal(done.kind === 'event' && done.event.type === 'status' ? done.event.watch : undefined, 'the row shows');
    const verifying = parse({ ...BASE, type: 'status', status: 'verifying', proof: 'the nightly run', watch: 'the row shows' }, 2);
    assert.equal(verifying.kind === 'event' && verifying.event.type === 'status' ? verifying.event.watch : 'no event', undefined);
    assert.match(reason(parse({ ...BASE, type: 'status', status: 'done', watch: 3 }, 2)), /watch is not text/);
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

  it("reads the review parts a status line gives, none when absent, and refuses one that is not texts", () => {
    const reviewOf = (record: JsonRecord): object | undefined | 'no event' => {
      const result = parse({ ...BASE, type: 'status', status: 'verifying', note: 'ok', ...record }, 2);
      return result.kind === 'event' && result.event.type === 'status' ? result.event.review : 'no event';
    };
    assert.deepEqual(reviewOf({ review: { cause: 'the parser skipped blank rows' } }), { cause: 'the parser skipped blank rows' });
    assert.equal(reviewOf({}), undefined, 'a line from before reviews gives none');
    assert.equal(reviewOf({ review: null }), undefined);
    assert.match(reason(parse({ ...BASE, type: 'status', status: 'done', review: 'a cause' }, 2)), /review is not an object/);
    assert.match(reason(parse({ ...BASE, type: 'status', status: 'done', review: { how: 3 } }, 2)), /review how is not text/);
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
    const handed = { ...TEST_CARD, run: '/w/tasks/T1/grant-read.ps1' };
    const running = parse({ ...BASE, type: 'status', status: 'waiting', waits, card: handed }, 2);
    assert.deepEqual(running.kind === 'event' && running.event.type === 'status' ? running.event.card : undefined, handed, 'a card keeps the hand step file it hands (T2312)');
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

  it("reads an update's size base, round trips it, and refuses a bad one (T649)", () => {
    const resized: RegisterEvent = { ...BASE, v: 2, type: 'update', changes: { size: 0.5 }, note: null, sizeBase: { day: '2030-01-07', w: 12_000_000 } };
    assert.deepEqual(parse(eventRecord(resized), 2), { kind: 'event', event: resized });
    for (const bad of [{ day: '2030-01-07' }, { day: '7 Jan', w: 1 }, { day: '2030-01-07', w: -1 }, { day: '2030-01-07', w: '5' }]) {
      assert.match(reason(parse({ ...BASE, type: 'update', changes: { size: 0.5 }, sizeBase: bad }, 2)), /^bad sizeBase /, JSON.stringify(bad));
    }
    assert.equal(reason(parse({ ...BASE, type: 'update', changes: { size: 0.5 }, sizeBase: 5 }, 2)), 'sizeBase is not an object');
  });

  it("reads an update's hand step audit, round trips it, and refuses a bad one (T2312)", () => {
    const sha256 = 'a'.repeat(64);
    const audited: RegisterEvent = { ...BASE, v: 2, type: 'update', changes: {}, note: 'read every line', audit: { path: '/work/steps/add-key.ps1', sha256 } };
    assert.deepEqual(parse(eventRecord(audited), 2), { kind: 'event', event: audited });
    for (const bad of [{ path: '/work/a.ps1' }, { path: '', sha256 }, { path: '/work/a.ps1\n& evil', sha256 }, { path: '/work/a.ps1', sha256: 'A'.repeat(64) }, { path: '/work/a.ps1', sha256: 'a'.repeat(63) }, { path: 7, sha256 }]) {
      assert.match(reason(parse({ ...BASE, type: 'update', changes: {}, audit: bad }, 2)), /^bad audit /, JSON.stringify(bad));
    }
    assert.equal(reason(parse({ ...BASE, type: 'update', changes: {}, audit: 'a.ps1' }, 2)), 'audit is not an object');
  });

  it('reads the type and critical mark of a create line and of an update, and an older line as neither (T1252)', () => {
    const marked: RegisterEvent = { ...BASE, v: 2, type: 'create', task: { ...TASK, type: 'bug', critical: true } };
    assert.deepEqual(parse(eventRecord(marked), 2), { kind: 'event', event: marked });
    const { type, critical, ...older } = TASK;
    assert.deepEqual([type, critical], [null, false]);
    assert.deepEqual(createdMark(parse({ ...BASE, type: 'create', task: older }, 2)), [null, false]);
    assert.deepEqual(parse({ ...BASE, type: 'update', changes: { type: 'task' } }, 2), { kind: 'event', event: { ...BASE, v: 2, type: 'update', changes: { type: 'task' }, note: null } });
    assert.deepEqual(parse({ ...BASE, type: 'update', changes: { critical: false } }, 2), { kind: 'event', event: { ...BASE, v: 2, type: 'update', changes: { critical: false }, note: null } });
  });

  it("reads an older line's kind as its type and critical mark, and writes it back without the kind", () => {
    const { type, critical, ...older } = TASK;
    assert.deepEqual([type, critical], [null, false]);
    const cases: [unknown, [string | null, boolean]][] = [
      ['work', ['task', false]],
      ['problem', ['bug', false]],
      ['critical', ['bug', true]],
      [null, [null, false]],
    ];
    for (const [kind, mark] of cases) {
      assert.deepEqual(createdMark(parse({ ...BASE, type: 'create', task: { ...older, kind } }, 2)), mark, String(kind));
    }
    assert.deepEqual(parse({ ...BASE, type: 'update', changes: { kind: 'critical' } }, 2), { kind: 'event', event: { ...BASE, v: 2, type: 'update', changes: { type: 'bug', critical: true }, note: null } });
    assert.deepEqual(parse({ ...BASE, type: 'update', changes: { kind: 'work' } }, 2), { kind: 'event', event: { ...BASE, v: 2, type: 'update', changes: { type: 'task', critical: false }, note: null } });
    const legacy = parse({ ...BASE, type: 'create', task: { ...older, kind: 'problem' } }, 2);
    const written = legacy.kind === 'event' ? JSON.stringify(eventRecord(legacy.event)) : '';
    assert.match(written, /"type":"bug"/);
    assert.doesNotMatch(written, /"kind"/);
  });

  it("lets a line's type or critical win over its kind, field by field, and reads a newer teamrig's type as a task", () => {
    const { type, critical, ...older } = TASK;
    assert.deepEqual([type, critical], [null, false]);
    assert.deepEqual(createdMark(parse({ ...BASE, type: 'create', task: { ...older, critical: true, kind: 'problem' } }, 2)), ['bug', true]);
    assert.deepEqual(createdMark(parse({ ...BASE, type: 'create', task: { ...TASK, type: 'task', kind: 'critical' } }, 2)), ['task', false]);
    assert.deepEqual(createdMark(parse({ ...BASE, type: 'create', task: { ...TASK, type: 'incident' } }, 2)), ['task', false]);
    assert.deepEqual(parse({ ...BASE, type: 'update', changes: { type: 'incident' } }, 2), { kind: 'event', event: { ...BASE, v: 2, type: 'update', changes: { type: 'task' }, note: null } });
  });

  it('reads the no-goal mark of a create line and of an update, leaves out a false one, and reads an older line as not said (T1730)', () => {
    const said: RegisterEvent = { ...BASE, v: 2, type: 'create', task: { ...TASK, noGoal: true } };
    assert.match(JSON.stringify(eventRecord(said)), /"noGoal":true/);
    assert.deepEqual(parse(eventRecord(said), 2), { kind: 'event', event: said });
    assert.doesNotMatch(JSON.stringify(eventRecord({ ...BASE, v: 2, type: 'create', task: TASK })), /"noGoal"/);
    const { noGoal, ...older } = TASK;
    assert.equal(noGoal, false);
    const old = parse({ ...BASE, type: 'create', task: older }, 2);
    assert.equal(old.kind === 'event' && old.event.type === 'create' ? old.event.task.noGoal : undefined, false);
    assert.deepEqual(parse({ ...BASE, type: 'update', changes: { goals: [], noGoal: true } }, 2), { kind: 'event', event: { ...BASE, v: 2, type: 'update', changes: { goals: [], noGoal: true }, note: null } });
    assert.equal(reason(parse({ ...BASE, type: 'create', task: { ...TASK, noGoal: 'yes' } }, 2)), 'bad noGoal "yes"');
  });

  it('reads the pin of a create line and of an update, leaves out an unpinned one, and reads an older line as unpinned (T637)', () => {
    const pinned: RegisterEvent = { ...BASE, v: 2, type: 'create', task: { ...TASK, pin: 'lead' } };
    assert.deepEqual(parse(eventRecord(pinned), 2), { kind: 'event', event: pinned });
    assert.doesNotMatch(JSON.stringify(eventRecord({ ...BASE, v: 2, type: 'create', task: TASK })), /"pin"/);
    const { pin, ...older } = TASK;
    assert.equal(pin, null);
    const old = parse({ ...BASE, type: 'create', task: older }, 2);
    assert.equal(old.kind === 'event' && old.event.type === 'create' ? old.event.task.pin : undefined, null);
    for (const value of ['lead', null]) {
      assert.deepEqual(parse({ ...BASE, type: 'update', changes: { pin: value } }, 2), { kind: 'event', event: { ...BASE, v: 2, type: 'update', changes: { pin: value }, note: null } });
    }
  });

  it('reads the work class of a create line and of an update, leaves out an unset one, reads an older line as unset, and refuses a misspelled one (T2076)', () => {
    const classed: RegisterEvent = { ...BASE, v: 2, type: 'create', task: { ...TASK, workClass: 'Roadmap' } };
    assert.deepEqual(parse(eventRecord(classed), 2), { kind: 'event', event: classed });
    assert.doesNotMatch(JSON.stringify(eventRecord({ ...BASE, v: 2, type: 'create', task: TASK })), /"workClass"/);
    const { workClass, ...older } = TASK;
    assert.equal(workClass, null);
    const old = parse({ ...BASE, type: 'create', task: older }, 2);
    assert.equal(old.kind === 'event' && old.event.type === 'create' ? old.event.task.workClass : undefined, null);
    for (const value of ['Tech debt', null]) {
      assert.deepEqual(parse({ ...BASE, type: 'update', changes: { workClass: value } }, 2), { kind: 'event', event: { ...BASE, v: 2, type: 'update', changes: { workClass: value }, note: null } });
    }
    for (const value of ['', '1st', 'Road/map', 'x'.repeat(33), 7]) {
      assert.equal(reason(parse({ ...BASE, type: 'create', task: { ...TASK, workClass: value } }, 2)), `bad workClass ${JSON.stringify(value)}`, String(value));
    }
  });

  it('reads the prep marker of a create line and of an update, leaves out an unset one, reads an older line as unset, and refuses a bad one (T2453)', () => {
    const marked: RegisterEvent = { ...BASE, v: 2, type: 'create', task: { ...TASK, prepares: { goal: 'A1', slice: 2 } } };
    assert.deepEqual(parse(eventRecord(marked), 2), { kind: 'event', event: marked });
    assert.doesNotMatch(JSON.stringify(eventRecord({ ...BASE, v: 2, type: 'create', task: TASK })), /"prepares"/);
    const { prepares, ...older } = TASK;
    assert.equal(prepares, null);
    const old = parse({ ...BASE, type: 'create', task: older }, 2);
    assert.equal(old.kind === 'event' && old.event.type === 'create' ? old.event.task.prepares : undefined, null);
    for (const value of [{ goal: 'B1.2', slice: 1 }, null]) {
      assert.deepEqual(parse({ ...BASE, type: 'update', changes: { prepares: value } }, 2), { kind: 'event', event: { ...BASE, v: 2, type: 'update', changes: { prepares: value }, note: null } });
    }
    for (const value of ['A1:2', { goal: 'A1', slice: 0 }, { goal: 'A1', slice: 1.5 }, { goal: '1A', slice: 1 }, { slice: 1 }, 7]) {
      assert.equal(reason(parse({ ...BASE, type: 'update', changes: { prepares: value } }, 2)), `bad prepares ${JSON.stringify(value)}`, JSON.stringify(value));
    }
  });

  it('rejects malformed lines with a reason', () => {
    const cases: [JsonRecord, RegExp][] = [
      [{ ...BASE, id: 'T0', type: 'create', task: TASK }, /bad task id/],
      [{ ...BASE, at: 'yesterday', type: 'create', task: TASK }, /bad time/],
      [{ ...BASE, by: '', type: 'create', task: TASK }, /missing author/],
      [{ ...BASE, type: 'create', task: 'x' }, /task is not an object/],
      [{ ...BASE, type: 'create', task: { ...TASK, priority: -1 } }, /bad priority -1/],
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
      [{ ...BASE, type: 'create', task: { ...TASK, type: 'Bug' } }, /bad type "Bug"/],
      [{ ...BASE, type: 'update', changes: { type: 7 } }, /bad type 7/],
      [{ ...BASE, type: 'create', task: { ...TASK, critical: 'yes' } }, /bad critical "yes"/],
      [{ ...BASE, type: 'create', task: { ...TASK, pin: '' } }, /pin is not text/],
      [{ ...BASE, type: 'update', changes: { pin: 3 } }, /pin is not text/],
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

describe('parseEvent: the waits a Later gives a task (T1295)', () => {
  const LATER = [
    { kind: 'decision', who: 'owner' },
    { kind: 'time', at: '2030-01-09 12:00' },
  ] as const;

  it("reads an update's waits, and an update without them as it was", () => {
    const later = parse({ ...BASE, type: 'update', changes: {}, note: 'after the demo', waits: LATER }, 2);
    assert.deepEqual(later, { kind: 'event', event: { ...BASE, v: 2, type: 'update', changes: {}, note: 'after the demo', waits: LATER } });
    const plain = parse({ ...BASE, type: 'update', changes: {}, note: 'context' }, 2);
    assert.ok(plain.kind === 'event' && !('waits' in plain.event));
  });

  it('reads an empty list as waits with none, which a Later that brings a card back may write', () => {
    const back = parse({ ...BASE, type: 'update', changes: {}, note: 'now', waits: [] }, 2);
    assert.ok(back.kind === 'event' && back.event.type === 'update' && back.event.waits?.length === 0);
  });

  it("reads a Decided's mark beside its waits (T1366), and writes it as it is", () => {
    const decided = parse({ ...BASE, type: 'update', changes: {}, note: 'owner decided: ship it', waits: [], decided: true }, 2);
    const event: RegisterEvent = { ...BASE, v: 2, type: 'update', changes: {}, note: 'owner decided: ship it', waits: [], decided: true };
    assert.deepEqual(decided, { kind: 'event', event });
    assert.deepEqual(eventRecord(event), event);
    const plain = parse({ ...BASE, type: 'update', changes: {}, note: 'context' }, 2);
    assert.ok(plain.kind === 'event' && !('decided' in plain.event));
  });

  it('cannot read a decided mark other than true', () => {
    const parsed = parse({ ...BASE, type: 'update', changes: {}, note: 'n', waits: [], decided: 'yes' }, 2);
    assert.ok(parsed.kind === 'unreadable' && /decided is "yes", not true/.test(parsed.reason), JSON.stringify(parsed));
  });

  it('cannot read waits that are not a list of known waits', () => {
    const cases: readonly [JsonRecord, RegExp][] = [
      [{ ...BASE, type: 'update', changes: {}, note: 'n', waits: 'decision:owner' }, /waits is not a list/],
      [{ ...BASE, type: 'update', changes: {}, note: 'n', waits: [{ kind: 'soon', at: '2030-01-09' }] }, /unknown wait kind "soon"/],
      [{ ...BASE, type: 'update', changes: {}, note: 'n', waits: [{ kind: 'time', at: 'tomorrow' }] }, /tomorrow is not YYYY-MM-DD/],
    ];
    for (const [record, expected] of cases) {
      assert.match(reason(parse(record, 2)), expected, JSON.stringify(record));
    }
  });

  it('writes the waits as they are, and reads them back', () => {
    const event: RegisterEvent = { ...BASE, v: 2, type: 'update', changes: {}, note: 'n', waits: LATER };
    assert.deepEqual(eventRecord(event), event);
    assert.deepEqual(parse(eventRecord(event), 2), { kind: 'event', event });
  });
});

describe('parseEvent: a task moved to another team (T1144)', () => {
  it('reads a moved line of this version, and writes it back as it is', () => {
    const moved: RegisterEvent = { ...BASE, v: EVENT_VERSION, type: 'moved', to: 'web' };
    assert.deepEqual(parse(eventRecord(moved), EVENT_VERSION), { kind: 'event', event: moved });
  });

  it('cannot read a moved line without a team, or with a team id no team can have', () => {
    assert.match(reason(parse({ ...BASE, type: 'moved' }, EVENT_VERSION)), /bad team undefined/);
    assert.match(reason(parse({ ...BASE, type: 'moved', to: 'Web Team' }, EVENT_VERSION)), /bad team "Web Team"/);
    assert.match(reason(parse({ ...BASE, type: 'moved', to: 3 }, EVENT_VERSION)), /bad team 3/);
  });

  it('reads the lines of every other record at the version they are written with, version 2', () => {
    assert.equal(TASK_LINE_VERSION, 2);
    const create: RegisterEvent = { ...BASE, v: TASK_LINE_VERSION, type: 'create', task: TASK };
    assert.deepEqual(parse(eventRecord(create), TASK_LINE_VERSION), { kind: 'event', event: create });
  });
});
