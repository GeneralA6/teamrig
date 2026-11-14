import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EVENT_VERSION, type RegisterEvent, type TaskFields } from './events.ts';
import { weekTagAt, weekTagsOf } from './week-tags.ts';

const FIELDS: TaskFields = { title: 'Ship it', description: null, owner: 'alpha', source: 'lead', ref: null, priority: 2, due: null, goals: [], noGoal: false, week: null, after: [], size: null, type: null, critical: false, pin: null, workClass: null, local: null };

const MONDAY = '2030-01-07T10:00:00.000Z';
const TUESDAY = '2030-01-08T10:00:00.000Z';
const WEDNESDAY = '2030-01-09T10:00:00.000Z';

function create(id: string, at: string, week: string | null): RegisterEvent {
  return { v: EVENT_VERSION, type: 'create', id, at, by: 'lead', task: { ...FIELDS, week } };
}

function update(id: string, at: string, changes: Partial<TaskFields>): RegisterEvent {
  return { v: EVENT_VERSION, type: 'update', id, at, by: 'lead', changes, note: 'replanned' };
}

describe('weekTagsOf', () => {
  it('holds each task its tags in order, a create the first and an update naming week the next', () => {
    const tags = weekTagsOf([create('T1', MONDAY, '2030-01-02'), create('T2', MONDAY, null), update('T1', TUESDAY, { week: '2030-01-09' }), update('T2', WEDNESDAY, { week: '2030-01-09' })]);
    assert.deepEqual(tags.get('T1'), [
      { at: Date.parse(MONDAY), week: '2030-01-02' },
      { at: Date.parse(TUESDAY), week: '2030-01-09' },
    ]);
    assert.deepEqual(tags.get('T2'), [
      { at: Date.parse(MONDAY), week: null },
      { at: Date.parse(WEDNESDAY), week: '2030-01-09' },
    ]);
  });

  it('reads a week taken off as null, and passes over what says nothing of the week', () => {
    const status: RegisterEvent = { v: EVENT_VERSION, type: 'status', id: 'T1', at: TUESDAY, by: 'alpha', status: 'done', note: 'n', evidence: null, skill: null };
    const moved: RegisterEvent = { v: EVENT_VERSION, type: 'moved', id: 'T1', at: TUESDAY, by: 'lead', to: 'web' };
    const tags = weekTagsOf([create('T1', MONDAY, '2030-01-02'), update('T1', TUESDAY, { title: 'Renamed' }), status, moved, update('T1', WEDNESDAY, { week: null })]);
    assert.deepEqual(tags.get('T1'), [
      { at: Date.parse(MONDAY), week: '2030-01-02' },
      { at: Date.parse(WEDNESDAY), week: null },
    ]);
  });
});

describe('weekTagAt', () => {
  const tags = [
    { at: Date.parse(MONDAY), week: '2030-01-02' },
    { at: Date.parse(WEDNESDAY), week: '2030-01-09' },
  ];

  it('reads the last tag set by then, a retag changing nothing before it', () => {
    assert.equal(weekTagAt(tags, Date.parse(TUESDAY)), '2030-01-02');
    assert.equal(weekTagAt(tags, Date.parse(WEDNESDAY)), '2030-01-09');
  });

  it('reads no week before the first tag', () => {
    assert.equal(weekTagAt(tags, Date.parse(MONDAY) - 1), null);
    assert.equal(weekTagAt([], Date.parse(MONDAY)), null);
  });
});
