import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SecretScanner } from '../core/secrets.ts';
import type { Task } from '../register/fold.ts';
import { testTask } from '../testing/task.ts';
import { MAX_TITLE, countsLine, createdNumber, parseMigrateRows, planMigration, previewMarkdown, rowLabels, type IssueRow, type MigrateRow, type RefJudge } from './migrate.ts';

const REPO = 'acme/tool';

function issueLine(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ id: 'T1', decision: 'issue', repo: REPO, type: 'task', priority: 'p2', title: 'Add a health check', body: 'Why and what.', ...overrides });
}

function localLine(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ id: 'T2', decision: 'local', reason: 'Names a private host.', ...overrides });
}

function parsed(text: string, scanner?: SecretScanner): MigrateRow[] {
  const result = parseMigrateRows(text, scanner);
  assert.ok(result.ok, result.ok ? '' : result.error);
  return result.value;
}

function refused(text: string, scanner?: SecretScanner): string {
  const result = parseMigrateRows(text, scanner);
  assert.equal(result.ok, false);
  return result.ok ? '' : result.error;
}

function issueRow(overrides: Partial<IssueRow> = {}): IssueRow {
  return { decision: 'issue', id: 'T1', repo: REPO, type: 'task', priority: 'p2', title: 'Add a health check', body: 'Why and what.', ...overrides };
}

function tasksOf(...tasks: Task[]): Map<string, Task> {
  return new Map(tasks.map((task) => [task.id, task]));
}

const allow: RefJudge = () => undefined;

describe('parseMigrateRows', () => {
  it('reads an issue row and a local row, skipping blank lines and trimming text', () => {
    const rows = parsed(`${issueLine({ repo: ' Acme/Tool ', title: '  Add a health check ', body: ' Why and what. \n' })}\r\n\r\n${localLine({ reason: ' Names a private host. ' })}\n`);
    assert.deepEqual(rows, [issueRow(), { decision: 'local', id: 'T2', reason: 'Names a private host.' }]);
  });

  it('refuses a line that is not JSON, or not an object, naming the line', () => {
    assert.equal(refused(`\n{not json`), 'line 2: not JSON');
    assert.equal(refused('[1]'), 'line 1: not an object');
  });

  it('refuses an id that is not a task id', () => {
    assert.equal(refused(issueLine({ id: '12' })), 'line 1: id is not a task id such as T12');
    assert.equal(refused(issueLine({ id: 12 })), 'line 1: id is not a task id such as T12');
  });

  it('refuses a decision other than issue or local', () => {
    assert.equal(refused(issueLine({ decision: 'later' })), 'line 1: T1: decision is neither "issue" nor "local"');
  });

  it('refuses an unknown key, such as a status, and a missing one', () => {
    assert.equal(refused(issueLine({ status: 'open' })), 'line 1: T1: unknown key status');
    assert.equal(refused(JSON.stringify({ id: 'T1', decision: 'issue', repo: REPO, type: 'task', priority: 'p2', title: 'x' })), 'line 1: T1: no body');
    assert.equal(refused(localLine({ repo: REPO })), 'line 1: T2: unknown key repo');
    assert.equal(refused(JSON.stringify({ id: 'T2', decision: 'local' })), 'line 1: T2: no reason');
  });

  it('refuses an empty reason', () => {
    assert.equal(refused(localLine({ reason: '  ' })), 'line 1: T2: reason is empty');
    assert.equal(refused(localLine({ reason: 3 })), 'line 1: T2: reason is empty');
  });

  it('refuses a repo, title or body that is not text', () => {
    assert.equal(refused(issueLine({ repo: 1 })), 'line 1: T1: repo, title and body are text');
    assert.equal(refused(issueLine({ body: null })), 'line 1: T1: repo, title and body are text');
  });

  it('refuses a type other than bug or task, and a priority outside p1 to p3', () => {
    assert.equal(refused(issueLine({ type: 'idea' })), 'line 1: T1: type is neither "bug" nor "task"');
    assert.equal(refused(issueLine({ priority: 'p4' })), 'line 1: T1: priority is not one of p1, p2, p3');
  });

  it('refuses an empty, multi-line or over-long title, and an empty body', () => {
    const titleError = `line 1: T1: the title is one line of 1 to ${MAX_TITLE} characters`;
    assert.equal(refused(issueLine({ title: ' ' })), titleError);
    assert.equal(refused(issueLine({ title: 'one\ntwo' })), titleError);
    assert.equal(refused(issueLine({ title: 'x'.repeat(MAX_TITLE + 1) })), titleError);
    assert.equal(parsed(issueLine({ title: 'x'.repeat(MAX_TITLE) })).length, 1);
    assert.equal(refused(issueLine({ body: '\n ' })), 'line 1: T1: the body is empty');
  });

  it('refuses a task named twice', () => {
    assert.equal(refused(`${issueLine()}\n${localLine({ id: 'T1' })}`), 'line 2: T1 has a row already');
  });

  it("refuses a title or body holding a secret's shape, never echoing it", () => {
    const scanner = new SecretScanner(['tok_[a-z0-9]{8}']);
    const secret = ['tok', 'abcd1234'].join('_');
    const error = refused(issueLine({ body: `Use ${secret} here.` }), scanner);
    assert.match(error, /^line 1: T1's title or body looks like it holds a secret/u);
    assert.doesNotMatch(error, new RegExp(secret, 'u'));
    assert.match(refused(issueLine({ title: `Key ${secret}` }), scanner), /looks like it holds a secret/u);
  });

  it('refuses a title or body naming a task id, alone or after a team, so no posted issue shows one', () => {
    const error = (named: string): string => `line 1: T1: the title or body names the task id ${named}: a task id is the team's own, so a posted issue shows none (link issues by #number)`;
    assert.equal(refused(issueLine({ title: 'Follow-up to T12' })), error('T12'));
    assert.equal(refused(issueLine({ body: 'Waits on `bravo/T3` first.' })), error('T3'));
    assert.equal(refused(issueLine({ body: 'Needs T7.\nThen T8.' })), error('T7'));
  });

  it('takes a body linking issues by #number and words merely holding a T and digits', () => {
    const body = 'Follows #12; the UTF8 path and the T-shaped layout stay; `set <id> --waits task:<team>/<id>`.';
    assert.equal(parsed(issueLine({ title: 'Fix the TLS10 fallback', body })).length, 1);
  });
});

describe('rowLabels', () => {
  it('labels a task an enhancement and a bug a bug, then the priority', () => {
    assert.deepEqual(rowLabels(issueRow()), ['enhancement', 'p2']);
    assert.deepEqual(rowLabels(issueRow({ type: 'bug', priority: 'p1' })), ['bug', 'p1']);
  });
});

describe('planMigration', () => {
  it('opens an issue for a live task with no ref, and keeps a local row local', () => {
    const local: MigrateRow = { decision: 'local', id: 'T2', reason: 'Private.' };
    const plan = planMigration([issueRow(), local], tasksOf(testTask(), testTask({ id: 'T2', status: 'waiting' })), [REPO], allow);
    assert.deepEqual(plan, {
      creates: [{ id: 'T1', draft: { repo: REPO, title: 'Add a health check', body: 'Why and what.', labels: ['enhancement', 'p2'] }, replaces: null }],
      local: [local],
      skipped: [],
      unrowed: [],
    });
  });

  it('skips a row whose task is missing or finished, issue and local alike', () => {
    const plan = planMigration([issueRow({ id: 'T9' }), issueRow(), { decision: 'local', id: 'T2', reason: 'x' }], tasksOf(testTask({ status: 'done' }), testTask({ id: 'T2', status: 'dropped' })), [REPO], allow);
    assert.deepEqual(plan.skipped, [
      { id: 'T9', reason: 'no such task in the working set' },
      { id: 'T1', reason: 'the task is done' },
      { id: 'T2', reason: 'the task is dropped' },
    ]);
    assert.deepEqual(plan.creates, []);
    assert.deepEqual(plan.local, []);
  });

  it('skips a task kept local, so an issue row never posts it (T2608)', () => {
    const plan = planMigration([issueRow()], tasksOf(testTask({ local: 'security' })), [REPO], allow);
    assert.deepEqual(plan.skipped, [{ id: 'T1', reason: 'the task is kept local: security' }]);
    assert.deepEqual(plan.creates, []);
  });

  it('skips a task that holds its issue already, so a rerun opens no second one', () => {
    const plan = planMigration([issueRow()], tasksOf(testTask({ ref: `gh:${REPO}#7` })), [REPO], allow);
    assert.deepEqual(plan.skipped, [{ id: 'T1', reason: `the task has its issue already: gh:${REPO}#7` }]);
  });

  it('replaces a ref that is no issue, naming it', () => {
    const plan = planMigration([issueRow()], tasksOf(testTask({ ref: 'notes/plan.md' })), [REPO], allow);
    assert.deepEqual(plan.skipped, []);
    assert.deepEqual(
      plan.creates.map((create) => [create.id, create.replaces]),
      [['T1', 'notes/plan.md']],
    );
  });

  it("skips a repo outside the team's github.repos", () => {
    const plan = planMigration([issueRow({ repo: 'acme/other' })], tasksOf(testTask()), [REPO, 'acme/pane'], allow);
    assert.deepEqual(plan.skipped, [{ id: 'T1', reason: `acme/other is not one of github.repos (${REPO}, acme/pane)` }]);
  });

  it('asks the judge with an issue ref in the row repo, and skips with its error', () => {
    const asked: string[] = [];
    const judge: RefJudge = (task, ref) => {
      asked.push(`${task.id} ${ref}`);
      return 'not your task';
    };
    const plan = planMigration([issueRow()], tasksOf(testTask()), [REPO], judge);
    assert.deepEqual(asked, [`T1 gh:${REPO}#1`]);
    assert.deepEqual(plan.skipped, [{ id: 'T1', reason: 'not your task' }]);
  });

  it('lists each live task no row names, and leaves out finished ones', () => {
    const tasks = tasksOf(testTask(), testTask({ id: 'T3', status: 'verifying' }), testTask({ id: 'T4', status: 'done' }), testTask({ id: 'T5', status: 'in-progress' }));
    assert.deepEqual(planMigration([issueRow()], tasks, [REPO], allow).unrowed, ['T3', 'T5']);
  });
});

describe('createdNumber', () => {
  it("reads the new issue's number from gh's JSON", () => {
    assert.equal(createdNumber('{"number": 42, "url": "x"}'), 42);
  });

  it('is undefined for text, a missing or bad number', () => {
    for (const stdout of ['', 'created', '{"url":"x"}', '{"number":"4"}', '{"number":0}', '{"number":1.5}', '[42]']) {
      assert.equal(createdNumber(stdout), undefined, stdout);
    }
  });
});

describe('previewMarkdown', () => {
  it('shows each issue in full, the local, skipped and unrowed tasks, and the counts', () => {
    const plan = planMigration(
      [issueRow({ type: 'bug', priority: 'p1', body: 'Line one.\n\nLine two.' }), { decision: 'local', id: 'T2', reason: 'Private.' }, issueRow({ id: 'T9' })],
      tasksOf(testTask({ ref: 'notes/plan.md' }), testTask({ id: 'T2' }), testTask({ id: 'T3' })),
      [REPO],
      allow,
    );
    assert.equal(
      previewMarkdown(plan),
      [
        '# gh migrate preview',
        '',
        '1 issue(s) to open, 1 kept local, 1 skipped, 1 live task(s) with no row',
        '',
        '## Issues to open',
        '',
        `### T1 → ${REPO} [bug, p1]`,
        '',
        "Replaces the task's ref notes/plan.md (kept in the task's history, not posted).",
        '',
        '**Add a health check**',
        '',
        'Line one.\n\nLine two.',
        '',
        '---',
        '',
        '## Kept local',
        '',
        '- T2: Private.',
        '',
        '## Skipped',
        '',
        '- T9: no such task in the working set',
        '',
        '## Live tasks with no row',
        '',
        '- T3',
        '',
      ].join('\n'),
    );
  });

  it('says None. for each empty part', () => {
    const empty = { creates: [], local: [], skipped: [], unrowed: [] };
    assert.equal(countsLine(empty), '0 issue(s) to open, 0 kept local, 0 skipped, 0 live task(s) with no row');
    assert.equal(previewMarkdown(empty).split('None.').length - 1, 4);
  });
});
