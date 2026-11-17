import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_ISSUE_FIELDS } from '../../config/defaults.ts';
import type { HostField, HostFieldRead } from '../../issues/fields.ts';
import type { Task } from '../../register/fold.ts';
import { FakeIssueHost } from '../../testing/fake-issue-host.ts';
import { testHostIssue } from '../../testing/host-issue.ts';
import { testTask } from '../../testing/task.ts';
import { JERUSALEM } from '../../testing/zone.ts';
import { fieldPlanLines, pushFields, SHOWN_FIELD_WRITES, type FieldStep } from './issue-field-push.ts';

const PRIORITY: HostField = { name: 'Priority', kind: 'single-select', id: 11, options: ['P1', 'P2'] };
const SCORE: HostField = { name: 'Score', kind: 'number', id: 14, options: [] };

/** acme/web with a Priority and a Score field and the Task and Bug types; issue 7 holds P1 and no type, issue 8 nothing. */
const READ: HostFieldRead = {
  kind: 'read',
  fields: [PRIORITY, SCORE],
  types: ['Task', 'Bug'],
  issues: [
    { number: 7, type: undefined, values: new Map([['priority', 'P1']]) },
    { number: 8, type: 'Task', values: new Map() },
  ],
  notes: ['a note of the read'],
};

const TASKS: readonly Task[] = [
  testTask({ id: 'T1', ref: 'gh:acme/web#7', priority: 2, type: 'bug' }),
  testTask({ id: 'T2', ref: 'gh:acme/web#8', priority: 1 }),
];

function stepOn(host: FakeIssueHost, overrides: Partial<FieldStep> = {}): FieldStep {
  return {
    host,
    run: { config: DEFAULT_ISSUE_FIELDS, zone: JERUSALEM, scoreOf: (task) => (task.id === 'T1' ? 41.6 : undefined) },
    repo: 'acme/web',
    issues: [testHostIssue(7), testHostIssue(8)],
    tasks: TASKS,
    writes: 10,
    send: false,
    ...overrides,
  };
}

describe('pushFields (T3406)', () => {
  it('previews each field and type that differs, with the read and plan notes, and writes nothing', async () => {
    const host = new FakeIssueHost().hasFields(READ);
    const lines: string[] = [];
    assert.deepEqual(await pushFields(stepOn(host), (line) => lines.push(line)), { planned: 4, writes: 4, sent: 0, failed: undefined });
    assert.deepEqual(lines, [
      'NOTE acme/web: a note of the read',
      'FIELDS acme/web: 4 to write',
      'FIELD acme/web#7 (T1): Priority P2, was P1',
      'FIELD acme/web#7 (T1): Score 42',
      'TYPE acme/web#7 (T1): Bug',
      'FIELD acme/web#8 (T2): Priority P1',
      'NOTE acme/web: acme/web has no issue field named "Start date", so none is written there',
      'NOTE acme/web: acme/web has no issue field named "Target date", so none is written there',
    ]);
    assert.deepEqual(host.calls, []);
  });

  it('with send, writes each in turn within its share of the writes, and counts the issues it changed', async () => {
    const host = new FakeIssueHost().hasFields(READ);
    const lines: string[] = [];
    assert.deepEqual(await pushFields(stepOn(host, { send: true, writes: 3 }), (line) => lines.push(line)), { planned: 3, writes: 3, sent: 1, failed: undefined });
    assert.deepEqual(host.calls, [
      { kind: 'field', target: { repo: 'acme/web', number: 7 }, field: 'Priority', value: 'P2' },
      { kind: 'field', target: { repo: 'acme/web', number: 7 }, field: 'Score', value: 42 },
      { kind: 'type', target: { repo: 'acme/web', number: 7 }, type: 'Bug' },
    ]);
    assert.ok(lines.includes('FIELDS acme/web: 3 to write, 1 left for the next run'));
    assert.ok(lines.includes('SENT TYPE acme/web#7 (T1): Bug'));
  });

  it('stops at the first failed write and gives its reason', async () => {
    const host = new FakeIssueHost().hasFields(READ, { kind: 'failed', reason: 'the token may not' });
    const lines: string[] = [];
    assert.deepEqual(await pushFields(stepOn(host, { send: true }), (line) => lines.push(line)), { planned: 4, writes: 0, sent: 0, failed: 'the token may not' });
    assert.equal(host.calls.length, 1);
    assert.equal(lines.at(-1), 'FAILED acme/web#7 T1: the token may not; the rest of the fields of acme/web wait for the next run');
  });

  it('writes nothing and says nothing for a host with no fields or a repository with none; a failed read is a failure', async () => {
    const say = (line: string): void => assert.fail(`said ${line}`);
    const nothing = { planned: 0, writes: 0, sent: 0, failed: undefined };
    assert.deepEqual(await pushFields(stepOn(new FakeIssueHost(), { send: true }), say), nothing);
    assert.deepEqual(await pushFields(stepOn(new FakeIssueHost().hasFields({ kind: 'none', reason: 'acme/web has no issue fields or issue types' }), { send: true }), say), nothing);
    const lines: string[] = [];
    const failed = await pushFields(stepOn(new FakeIssueHost().hasFields({ kind: 'failed', reason: 'gh printed no page' })), (line) => lines.push(line));
    assert.deepEqual([failed, lines], [{ ...nothing, failed: 'gh printed no page' }, ['FAILED acme/web: gh printed no page; no field or type planned for it']]);
  });
});

describe('fieldPlanLines (T3406)', () => {
  it('shows the first writes and counts the rest', () => {
    const write = { kind: 'type', task: 'T1', target: { repo: 'acme/web', number: 7 }, type: 'Bug', was: undefined } as const;
    const lines = fieldPlanLines('acme/web', { writes: Array.from({ length: SHOWN_FIELD_WRITES + 2 }, () => write), deferred: 0, notes: [] });
    assert.deepEqual([lines[0], lines.length, lines.at(-1)], ['FIELDS acme/web: 12 to write', SHOWN_FIELD_WRITES + 2, '... and 2 more']);
  });
});
