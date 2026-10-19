import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { RegisterEvent, UpdateEvent } from '../register/events.ts';
import type { Task } from '../register/fold.ts';
import { TimeZone } from '../core/zone.ts';
import { testTask } from '../testing/task.ts';
import { JERUSALEM } from '../testing/zone.ts';
import { NOTE_CHARS } from './agenda.ts';
import { decisionsByOwner, decisionText, endNotice, startNotice, type NoticeFacts } from './notices.ts';

const FACTS: NoticeFacts = { lead: 'lead', leadName: 'team-lead', at: Date.parse('2030-01-08T09:00:00Z'), command: 'teamrig', zone: TimeZone.UTC };
const SINCE = Date.parse('2030-01-08T09:00:00Z');

function update(id: string, at: string, overrides: Partial<UpdateEvent> = {}): UpdateEvent {
  return { v: 1, type: 'update', id, at, by: 'lead', changes: {}, note: 'owner decided: go', ...overrides };
}

describe('the meeting notices', () => {
  it('tells a session the meeting started, to keep working and hold messages to the lead but a CRITICAL one', () => {
    assert.equal(
      startNotice(FACTS),
      "the owner's daily meeting with team-lead started Tue 01-08 09:00 UTC: keep working and send no message to team-lead until it ends; " +
        'leave reports and asks as inbox lines (teamrig inbox add --to lead --text "..."). Only what needs the owner now goes as one message starting CRITICAL:.',
    );
  });

  it('tells a session the meeting ended, with the decisions on its tasks when there are some', () => {
    assert.equal(endNotice(FACTS, []), "the owner's daily meeting with team-lead ended Tue 01-08 09:00 UTC: messages to team-lead may go again.");
    assert.match(endNotice(FACTS, ['T1: go', 'T2: wait']), /may go again\. Decided on your tasks: T1: go; T2: wait\.$/);
  });

  it("gives the meeting's times on the team's clock", () => {
    const local = { ...FACTS, zone: JERUSALEM };
    assert.match(startNotice(local), /^the owner's daily meeting with team-lead started Tue 01-08 11:00 IST: keep working/);
    assert.match(endNotice(local, []), /ended Tue 01-08 11:00 IST: messages to team-lead may go again\.$/);
  });

  it('gives a decision as its task, its note on one line cut short, and the fields changed', () => {
    assert.equal(decisionText(update('T1', '2030-01-08T09:10:00Z')), 'T1: owner decided: go');
    assert.equal(decisionText(update('T1', '2030-01-08T09:10:00Z', { note: null, changes: { priority: 1, due: '2030-01-09' } })), 'T1: (changed priority, due)');
    const long = decisionText(update('T1', '2030-01-08T09:10:00Z', { note: `first\nsecond ${'x'.repeat(NOTE_CHARS)}` }));
    assert.ok(long.startsWith('T1: first second '), long);
    assert.ok(long.length <= 'T1: '.length + NOTE_CHARS, long);
  });

  it("groups the lead's updates during the meeting by each task's owner, leaving out the rest", () => {
    const tasks = new Map<string, Task>([
      ['T1', testTask({ id: 'T1', owner: 'alpha' })],
      ['T2', testTask({ id: 'T2', owner: 'bravo' })],
      ['T3', testTask({ id: 'T3', owner: 'lead' })],
    ]);
    const events: RegisterEvent[] = [
      update('T1', '2030-01-08T08:59:00Z', { note: 'before the meeting' }),
      update('T1', '2030-01-08T09:10:00Z', { note: 'owner: ship it' }),
      update('T2', '2030-01-08T09:12:00Z', { note: 'owner: hold' }),
      update('T2', '2030-01-08T09:13:00Z', { by: 'alpha', note: 'not the lead' }),
      update('T3', '2030-01-08T09:14:00Z', { note: "the lead's own task" }),
      update('T9', '2030-01-08T09:15:00Z', { note: 'retired by a compaction' }),
      { v: 1, type: 'status', id: 'T1', at: '2030-01-08T09:16:00Z', by: 'lead', status: 'done', note: 'a status change', evidence: null, skill: null },
      update('T1', '2030-01-08T09:20:00Z', { note: 'owner: and the docs' }),
    ];
    assert.deepEqual(
      [...decisionsByOwner(events, tasks, 'lead', SINCE)],
      [
        ['alpha', ['T1: owner: ship it', 'T1: owner: and the docs']],
        ['bravo', ['T2: owner: hold']],
      ],
    );
  });
});
