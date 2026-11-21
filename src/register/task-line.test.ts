import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { isRecord, type JsonRecord } from '../core/guards.ts';
import { testTask } from '../testing/task.ts';
import { cutTask, textHash } from './description-cut.ts';
import { foldEvents, type Task } from './fold.ts';
import { readEvents } from './snapshot.ts';
import { isTaskLine, parseTaskLine, taskLineRecord, TASK_LINE_TYPE } from './task-line.ts';

const GOLDEN_LOGS = ['events-v0.jsonl', 'events-v1.jsonl', 'events-v2.jsonl', 'events-v3.jsonl', 'events-one-commit.jsonl'];

/** The record a task line holds once written to disk and read back: JSON text, parsed. */
function onDisk(task: Task): JsonRecord {
  const parsed: unknown = JSON.parse(JSON.stringify(taskLineRecord(5, task)));
  if (!isRecord(parsed)) {
    throw new Error('a task line is not a record');
  }
  return parsed;
}

/** A task line whose task has `change` applied to its written fields: a key set, or dropped when its value is undefined. */
function editedLine(task: Task, change: JsonRecord): JsonRecord {
  const line = onDisk(task);
  const written = line['task'];
  if (!isRecord(written)) {
    throw new Error('a task line holds no task');
  }
  const fields = Object.entries({ ...written, ...change }).filter(([, value]) => value !== undefined);
  return { ...line, task: Object.fromEntries(fields) };
}

/** A task with every part that may be empty set, so a round trip shows each one read back. */
const richTask: Task = testTask({
  id: 'T42',
  description: 'All the parts',
  ref: 'gh:acme/web#7',
  due: '2030-01-09 12:00',
  goals: ['G1', 'G2'],
  week: '2030-01-07',
  after: ['T40', 'T41'],
  size: 3,
  type: 'bug',
  critical: true,
  pin: 'top',
  workClass: 'Roadmap',
  prepares: { goal: 'G1', slice: 2 },
  status: 'waiting',
  note: 'waits on the lead',
  evidence: 'commit abc1234',
  skill: 'none',
  waits: [
    { kind: 'approval', who: 'lead' },
    { kind: 'decision', who: 'owner' },
    { kind: 'task', id: 'T40' },
    { kind: 'time', at: '2030-01-09 12:00' },
  ],
  card: {
    question: 'Ship it?',
    options: ['yes', 'no'],
    recommend: 'yes',
    byDefault: 'no',
    whyAsk: 'a permission',
    gate: 'permissions',
    run: 'teamrig exec deploy',
    affects: 'the web service',
    security: true,
  },
  answer: { verdict: 'approved', by: 'lead', at: '2030-01-08T10:00:00.000Z', note: 'checked the diff' },
  decided: { by: 'lead', at: '2030-01-08T11:00:00.000Z', note: 'the owner said yes' },
  proof: 'the health check answers',
  watch: 'a sighting in the log',
  reparks: 2,
  followups: ['T43'],
  review: { cause: 'web.ts:12', how: 'a refactor', prevent: 'a spec', harden: 'a type', missedTest: 'T44', missedMonitor: 'none fits', missedLog: 'T45' },
  sizeBase: { day: '2030-01-08', w: 12.5 },
  audits: [{ path: 'steps/grant.ps1', sha256: 'a'.repeat(64), by: 'security', at: '2030-01-08T09:00:00.000Z' }],
  securityVerdict: { text: 'PASS', read: { question: 'Ship it?', options: ['yes', 'no'], recommend: 'yes' }, by: 'security', at: '2030-01-08T09:30:00.000Z' },
  startedAt: '2030-01-07T10:00:00.000Z',
  ownerSeenAt: '2030-01-08T12:00:00.000Z',
});

describe('task lines', () => {
  it('reads back every task of the golden logs exactly', async () => {
    let tasks = 0;
    for (const name of GOLDEN_LOGS) {
      const read = readEvents(await readFile(new URL(`./testdata/${name}`, import.meta.url), 'utf8'));
      for (const task of foldEvents(read.events, read.seenIds).tasks.values()) {
        assert.deepEqual(parseTaskLine(onDisk(task)), task, `${name} ${task.id}`);
        tasks += 1;
      }
    }
    assert.ok(tasks >= GOLDEN_LOGS.length, `only ${tasks} tasks folded from the golden logs`);
  });

  it('reads back a task with every optional part set', () => {
    assert.deepEqual(parseTaskLine(onDisk(richTask)), richTask);
  });

  it('reads back a card with none of its optional parts', () => {
    const task = testTask({ status: 'waiting', waits: [{ kind: 'decision', who: 'owner' }], card: { question: 'Which?', options: ['a', 'b'], recommend: 'a', byDefault: 'a' } });
    assert.deepEqual(parseTaskLine(onDisk(task)), task);
  });

  it('tells a task line by its type', () => {
    assert.equal(TASK_LINE_TYPE, 'task');
    assert.ok(isTaskLine(onDisk(richTask)));
    assert.equal(isTaskLine({ v: 4, type: 'create', id: 'T1' }), false);
  });

  it('refuses a record that is no task line', () => {
    assert.equal(parseTaskLine({ v: 4, type: 'create', id: 'T1', title: 'x' }), 'not a task line');
    assert.equal(parseTaskLine({ v: 5, type: 'task', task: 'T1' }), 'not a task line');
  });

  it('refuses a task missing a field it folds, as a snapshot written before that field', () => {
    assert.equal(parseTaskLine(editedLine(richTask, { waitsAt: undefined })), 'T42: waitsAt is not text');
    assert.equal(parseTaskLine(editedLine(richTask, { ownerSeenAt: undefined })), 'T42: ownerSeenAt is neither text nor null');
    assert.equal(parseTaskLine(editedLine(richTask, { followups: undefined })), 'T42: followups is missing');
    assert.equal(parseTaskLine(editedLine(richTask, { review: undefined })), 'T42: review is missing');
    assert.match(String(parseTaskLine(editedLine(richTask, { audits: undefined }))), /^T42: audits is not a list$/);
  });

  it('reads back a cut description as its mark, and a whole one with none', () => {
    const cut = cutTask(richTask);
    assert.deepEqual(cut.descriptionCut, { chars: 13, hash: textHash('All the parts') });
    assert.deepEqual(parseTaskLine(onDisk(cut)), cut);
    assert.equal(richTask.descriptionCut, null);
    assert.deepEqual(parseTaskLine(onDisk(richTask)), richTask);
  });

  it('refuses a line written before the mark existed, so its snapshot falls to the history', () => {
    assert.equal(parseTaskLine(editedLine(richTask, { descriptionCut: undefined })), 'T42: descriptionCut is neither a mark nor null');
  });

  it('refuses a bad mark, and one beside a description', () => {
    assert.equal(parseTaskLine(editedLine(richTask, { description: null, descriptionCut: { chars: 13 } })), 'T42: bad descriptionCut {"chars":13}');
    assert.equal(parseTaskLine(editedLine(richTask, { descriptionCut: { chars: 13, hash: '0123abcd' } })), 'T42: holds a description and the mark of a cut one');
  });

  it('refuses a bad id, status or count', () => {
    assert.equal(parseTaskLine(editedLine(richTask, { id: 'X1' })), 'id "X1" is not a task id');
    assert.equal(parseTaskLine(editedLine(richTask, { status: 'paused' })), 'T42: status "paused" is not a status');
    assert.equal(parseTaskLine(editedLine(richTask, { reparks: -1 })), 'T42: reparks is not a count');
  });

  it('refuses a bad answer, decision, audit or verdict', () => {
    assert.match(String(parseTaskLine(editedLine(richTask, { answer: { verdict: 'maybe', by: 'lead', at: '2030-01-08T10:00:00.000Z', note: null } }))), /^T42: bad answer /);
    assert.match(String(parseTaskLine(editedLine(richTask, { answer: { verdict: 'approved', at: '2030-01-08T10:00:00.000Z', note: null } }))), /^T42: bad answer /);
    assert.match(String(parseTaskLine(editedLine(richTask, { decided: { by: 'lead', at: '2030-01-08T11:00:00.000Z' } }))), /^T42: bad decision /);
    assert.match(String(parseTaskLine(editedLine(richTask, { audits: [{ path: 'steps/grant.ps1', sha256: 'a'.repeat(64), at: '2030-01-08T09:00:00.000Z' }] }))), /^T42: bad audit /);
    assert.match(String(parseTaskLine(editedLine(richTask, { securityVerdict: { text: 'PASS', read: { question: 'q', options: [], recommend: 'r' }, by: 'security' } }))), /^T42: bad security verdict /);
  });

  it('refuses bad waits, card or size base', () => {
    assert.match(String(parseTaskLine(editedLine(richTask, { waits: [{ kind: 'nap' }] }))), /^T42: /);
    assert.equal(parseTaskLine(editedLine(richTask, { card: { question: 'q', options: [], recommend: 'r' } })), 'T42: card needs question, recommend and byDefault as text');
    assert.match(String(parseTaskLine(editedLine(richTask, { sizeBase: { day: 'today', w: 1 } }))), /^T42: bad sizeBase /);
  });
});
