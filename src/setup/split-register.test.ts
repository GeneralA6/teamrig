import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { JsonRecord } from '../core/guards.ts';
import { parseObject } from '../core/jsonl.ts';
import { EVENT_VERSION, TASK_LINE_VERSION } from '../register/events.ts';
import type { RegisterState, Task } from '../register/fold.ts';
import { readEvents, readRegister } from '../register/snapshot.ts';
import { testTask } from '../testing/task.ts';
import { childLineOf, childRegisterOf, parentEventsOf, splitProblems } from './split-register.ts';
import { SplitBorder, type SplitTasks } from './team-split.ts';

/** Team `app` splits `alpha` and `bravo` into `web`; `lead` and `carol` stay. */
const BORDER = new SplitBorder('app', 'web', ['alpha', 'bravo'], 'owner');
const AT = '2030-01-08T10:00:00.000Z';

function line(record: JsonRecord): string {
  return JSON.stringify(record);
}

function created(id: string, owner: string, extra: JsonRecord = {}): JsonRecord {
  return { v: TASK_LINE_VERSION, type: 'create', id, at: AT, by: 'lead', task: { title: `Task ${id}`, owner, source: 'lead', ref: null, priority: 1, due: null, goals: [], week: null, ...extra } };
}

function stateOf(tasks: readonly Task[], moved: Readonly<Record<string, string>> = {}): RegisterState {
  return { tasks: new Map(tasks.map((task) => [task.id, task])), orphans: 0, nextId: 'T9', moved: new Map(Object.entries(moved)) };
}

describe('childLineOf', () => {
  it('leaves a line that names no session across the border byte for byte, spacing and all', () => {
    const raw = '{"v":2, "type":"status","id":"T1","at":"2030-01-08T10:00:00.000Z","by":"alpha","status":"in-progress","note":null}';
    assert.equal(childLineOf(raw, BORDER), raw);
    assert.equal(childLineOf('{"v":2,"type":"cr', BORDER), '{"v":2,"type":"cr');
  });

  it('names a staying session as <parent>/<id>: who wrote it, the owner, who asked and who pinned it', () => {
    const raw = line(created('T1', 'lead', { pin: 'lead', future: { kept: true } }));
    assert.deepEqual(parseObject(childLineOf(raw, BORDER)), {
      ...created('T1', 'lead'),
      by: 'app/lead',
      task: { title: 'Task T1', owner: 'app/lead', source: 'app/lead', ref: null, priority: 1, due: null, goals: [], week: null, pin: 'app/lead', future: { kept: true } },
    });
    const update = { v: TASK_LINE_VERSION, type: 'update', id: 'T1', at: AT, by: 'carol', changes: { owner: 'alpha', source: 'owner', pin: 'org/po' }, note: null };
    assert.deepEqual(parseObject(childLineOf(line(update), BORDER)), { ...update, by: 'app/carol' });
  });

  it('names who must give a decision or an approval across the border, and leaves the other waits', () => {
    const waits = [{ kind: 'approval', who: 'lead' }, { kind: 'decision', who: 'owner' }, { kind: 'decision', who: 'bravo' }, { kind: 'task', id: 'T2' }, 'damaged'];
    const status = { v: TASK_LINE_VERSION, type: 'status', id: 'T1', at: AT, by: 'alpha', status: 'waiting', note: 'n', waits };
    assert.deepEqual(parseObject(childLineOf(line(status), BORDER))?.['waits'], [{ kind: 'approval', who: 'app/lead' }, ...waits.slice(1)]);
  });
});

describe('childRegisterOf', () => {
  it("holds the moving tasks' lines alone, crossed, in write order", () => {
    const lines = [line(created('T1', 'alpha')), line(created('T2', 'lead')), line({ v: TASK_LINE_VERSION, type: 'update', id: 'T1', at: AT, by: 'lead', changes: { priority: 2 }, note: null })];
    const text = childRegisterOf(readEvents(`${lines.join('\n')}\n`), new Set(['T1']), BORDER);
    const read = readRegister(text);
    assert.deepEqual([...read.state.tasks.keys()], ['T1']);
    assert.equal(read.state.tasks.get('T1')?.priority, 2);
    assert.equal(read.state.tasks.get('T1')?.createdBy, 'app/lead');
    assert.equal(text.split('\n').length, 3, 'two lines and the closing newline');
  });
});

describe('parentEventsOf', () => {
  it('updates each staying task that names a moved session as who asked or pinned it, then moves each moving task', () => {
    const split: SplitTasks = {
      moving: [testTask({ id: 'T1' })],
      staying: 3,
      links: [],
      rewrites: [
        { task: 'T1', field: 'source', from: 'lead', to: 'app/lead', moves: true },
        { task: 'T2', field: 'source', from: 'bravo', to: 'web/bravo', moves: false },
        { task: 'T2', field: 'pin', from: 'bravo', to: 'web/bravo', moves: false },
        { task: 'T3', field: 'source', from: 'alpha', to: 'web/alpha', moves: false },
        { task: 'T3', field: 'pin', from: 'bravo', to: 'web/bravo', moves: false },
        { task: 'T4', field: 'answer', from: 'alpha', to: 'web/alpha', moves: false },
      ],
      blockers: [],
    };
    assert.deepEqual(parentEventsOf(split, 'web', 'lead', AT), [
      { v: TASK_LINE_VERSION, id: 'T2', at: AT, by: 'lead', type: 'update', changes: { source: 'web/bravo', pin: 'web/bravo' }, note: 'bravo moved to team web' },
      { v: TASK_LINE_VERSION, id: 'T3', at: AT, by: 'lead', type: 'update', changes: { source: 'web/alpha', pin: 'web/bravo' }, note: 'alpha, bravo moved to team web' },
      { v: EVENT_VERSION, id: 'T1', at: AT, by: 'lead', type: 'moved', to: 'web' },
    ]);
  });
});

describe('splitProblems', () => {
  const moving = [testTask({ id: 'T1' }), testTask({ id: 'T2', owner: 'bravo' })];

  it('finds nothing when the child holds each moved task as it was and the parent sends each there', () => {
    assert.deepEqual(splitProblems(moving, stateOf(moving), stateOf([], { T1: 'web', T2: 'web' }), 'web'), []);
  });

  it('names a task the child lacks, holds astray or reads otherwise, and one the parent does not send there', () => {
    const child = stateOf([testTask({ id: 'T1', status: 'done', title: 'Other' }), testTask({ id: 'T5' })]);
    assert.deepEqual(splitProblems(moving, child, stateOf([], { T1: 'web', T2: 'api' }), 'web'), [
      "team web's register holds T5, which did not move",
      "T1 reads with another status, title in team web's register",
      "T2 is missing from team web's register",
      "T2 does not read as moved to team web in the parent's register",
    ]);
  });
});
