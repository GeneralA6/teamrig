import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { testHostIssue } from '../testing/host-issue.ts';
import { testTask } from '../testing/task.ts';
import type { Task } from '../register/fold.ts';
import {
  autoPushWrites,
  changeLine,
  changeWrites,
  heldIssue,
  isGoal,
  issueGoal,
  planPush,
  PUSH_WRITES_PER_HOUR,
  PUSH_WRITES_PER_RUN,
  scheduled,
  STATUS_LABELS,
  assigneeOf,
  sessionLogins,
  type IssueChange,
} from './status-push.ts';

const REPO = 'acme/web';

/** Task `id` holding acme/web#`number`, as a team task (migrated) unless overridden. */
function holding(id: string, number: number, overrides: Partial<Task> = {}): Task {
  return testTask({ id, ref: `gh:${REPO}#${number}`, ...overrides });
}

describe('issueGoal (T2682)', () => {
  const task = (overrides: Partial<Task>): Task => testTask(overrides);

  it('gives each started status its one label, its issue claimed', () => {
    assert.deepEqual(issueGoal(task({ status: 'in-progress' }), false), { open: true, label: 'status:in progress', claim: true });
    assert.deepEqual(issueGoal(task({ status: 'waiting' }), false), { open: true, label: 'status:waiting', claim: true });
    assert.deepEqual(issueGoal(task({ status: 'verifying' }), false), { open: true, label: 'status:in review', claim: true });
  });

  it('leaves an open task no one scheduled or took open to anyone, and claims one with a due date or an assignee (T3021)', () => {
    assert.deepEqual(issueGoal(task({ status: 'open' }), false), { open: true, label: 'status:open', claim: false });
    assert.deepEqual(issueGoal(task({ status: 'open', due: '2030-01-09' }), false), { open: true, label: 'status:claimed', claim: true });
    assert.deepEqual(issueGoal(task({ status: 'open' }), true), { open: true, label: 'status:claimed', claim: false });
  });

  it('gives a goal, a task planned after its parts, no status label (T3056)', () => {
    assert.deepEqual(issueGoal(task({ status: 'open', after: ['T2'] }), false), { open: true, label: undefined, claim: false });
    assert.deepEqual(issueGoal(task({ status: 'in-progress', after: ['T2'] }), false), { open: true, label: undefined, claim: true });
  });

  it('closes a done task as completed and a dropped one as not planned, goal or not', () => {
    assert.deepEqual(issueGoal(task({ status: 'done' }), false), { open: false, reason: 'completed' });
    assert.deepEqual(issueGoal(task({ status: 'dropped', after: ['T2'] }), false), { open: false, reason: 'not-planned' });
  });
});

describe('scheduled and isGoal (T3021)', () => {
  it('counts a task as scheduled once started or given a due date', () => {
    assert.equal(scheduled({ status: 'open', due: null }), false);
    assert.equal(scheduled({ status: 'open', due: '2030-01-09' }), true);
    assert.equal(scheduled({ status: 'waiting', due: null }), true);
  });

  it('counts a task as a goal when it is planned after parts', () => {
    assert.equal(isGoal({ after: [] }), false);
    assert.equal(isGoal({ after: ['T2', 'T3'] }), true);
  });
});

describe('heldIssue (T2682)', () => {
  it('reads the issue of a gh: ref, and none from any other ref', () => {
    assert.deepEqual(heldIssue(holding('T1', 7)), { repo: REPO, number: 7 });
    assert.deepEqual(heldIssue(testTask({ ref: 'gh:Acme/Web#7' })), { repo: REPO, number: 7 });
    assert.equal(heldIssue(testTask({ ref: 'notes/plan.md' })), undefined);
    assert.equal(heldIssue(testTask({ ref: 'gh:not an issue' })), undefined);
    assert.equal(heldIssue(testTask({ ref: null })), undefined);
  });
});

describe('planPush (T2682)', () => {
  it('labels an unlabelled open issue with its task status', () => {
    const plan = planPush(REPO, [testHostIssue(7)], [holding('T1', 7, { status: 'in-progress' })]);
    assert.deepEqual(plan.changes, [{ target: { repo: REPO, number: 7 }, task: 'T1', status: 'in-progress', add: ['status:in progress'], remove: [], close: undefined }]);
    assert.equal(plan.unchanged, 0);
  });

  it('swaps an old status label, and takes off a hand-made one in the namespace, keeping every other label', () => {
    const issue = testHostIssue(7, { labels: ['bug', 'status:open', 'status:blocked'] });
    const [change] = planPush(REPO, [issue], [holding('T1', 7, { status: 'waiting' })]).changes;
    assert.deepEqual(change?.add, ['status:waiting']);
    assert.deepEqual(change?.remove, ['status:open', 'status:blocked']);
  });

  it('counts an issue already showing its status as unchanged', () => {
    const plan = planPush(REPO, [testHostIssue(7, { labels: ['status:in review'] })], [holding('T1', 7, { status: 'verifying' })]);
    assert.deepEqual(plan.changes, []);
    assert.equal(plan.unchanged, 1);
  });

  it('closes the open issue of a done task as completed and of a dropped one as not planned, taking off its status labels', () => {
    const plan = planPush(
      REPO,
      [testHostIssue(7, { labels: ['status:in review'] }), testHostIssue(8)],
      [holding('T1', 7, { status: 'done' }), holding('T2', 8, { status: 'dropped' })],
    );
    assert.deepEqual(
      plan.changes.map((change) => [change.task, change.close, change.add, change.remove]),
      [
        ['T1', 'completed', [], ['status:in review']],
        ['T2', 'not-planned', [], []],
      ],
    );
  });

  it('leaves a closed issue of a closed task as it is', () => {
    const plan = planPush(REPO, [testHostIssue(7, { state: 'closed', stateReason: 'COMPLETED', labels: ['status:in review'] })], [holding('T1', 7, { status: 'done' })]);
    assert.deepEqual(plan.changes, []);
    assert.equal(plan.unchanged, 1);
  });

  it('never reopens an issue a person closed while its task is active: it names it instead', () => {
    const plan = planPush(REPO, [testHostIssue(7, { state: 'closed', stateReason: 'NOT_PLANNED' })], [holding('T1', 7, { status: 'in-progress' })]);
    assert.deepEqual(plan.changes, []);
    assert.deepEqual(plan.closedActive, [{ target: { repo: REPO, number: 7 }, task: 'T1', status: 'in-progress', stateReason: 'NOT_PLANNED' }]);
  });

  it('names the issue of an active task the list did not include, and skips tasks of other repositories and without an issue', () => {
    const tasks = [holding('T1', 9), testTask({ id: 'T2', ref: 'gh:acme/api#3' }), testTask({ id: 'T3' })];
    const plan = planPush(REPO, [testHostIssue(3, { repo: 'acme/api' })], tasks);
    assert.deepEqual(plan.unlisted, [{ target: { repo: REPO, number: 9 }, task: 'T1', status: 'open' }]);
    assert.deepEqual(plan.changes, []);
    assert.equal(plan.unchanged, 0);
  });

  it('counts a closed task whose issue the list left out as unchanged: the list holds every open issue', () => {
    const plan = planPush(REPO, [], [holding('T1', 9, { status: 'done' }), holding('T2', 10, { status: 'dropped' })]);
    assert.deepEqual(plan.unlisted, []);
    assert.equal(plan.unchanged, 2);
  });

  it('lets a team task speak for an issue the import also added a task for, whichever comes first', () => {
    const imported = holding('T5', 7, { source: 'github', status: 'open' });
    const team = holding('T9', 7, { status: 'in-progress' });
    for (const tasks of [
      [imported, team],
      [team, imported],
    ]) {
      assert.deepEqual(
        planPush(REPO, [testHostIssue(7)], tasks).changes.map((change) => change.task),
        ['T9'],
      );
    }
  });

  it('keeps the first of two imported tasks on one issue', () => {
    const tasks = [holding('T5', 7, { source: 'github' }), holding('T6', 7, { source: 'github', status: 'waiting' })];
    assert.deepEqual(
      planPush(REPO, [testHostIssue(7)], tasks).changes.map((change) => change.task),
      ['T5'],
    );
  });

  it('plans in issue order and sends whole changes within the run, leaving the rest for the next run', () => {
    // Each change swaps a label: two writes, so the run's writes hold half as many changes.
    const count = PUSH_WRITES_PER_RUN / 2 + 3;
    const numbers = Array.from({ length: count }, (_, index) => count - index);
    const issues = numbers.map((number) => testHostIssue(number, { labels: ['status:open'] }));
    const tasks = numbers.map((number) => holding(`T${number}`, number, { status: 'in-progress' }));
    const plan = planPush(REPO, issues, tasks);
    assert.equal(plan.changes.length, PUSH_WRITES_PER_RUN / 2);
    assert.equal(plan.deferred.length, 3);
    assert.deepEqual(
      plan.changes.slice(0, 2).map((change) => change.target.number),
      [1, 2],
    );
    assert.equal(plan.changes.reduce((sum, change) => sum + changeWrites(change), 0), PUSH_WRITES_PER_RUN);
  });

  it('defers every change after the first that does not fit, so the issue order holds across runs', () => {
    const big = testHostIssue(1, { labels: Array.from({ length: PUSH_WRITES_PER_RUN }, (_, index) => `status:old-${index}`) });
    const plan = planPush(REPO, [big, testHostIssue(2)], [holding('T1', 1), holding('T2', 2)]);
    assert.deepEqual(plan.changes, []);
    assert.deepEqual(
      plan.deferred.map((change) => change.task),
      ['T1', 'T2'],
    );
  });

  it('sends at most the writes a run is given, deferring the rest', () => {
    const issues = [1, 2, 3].map((number) => testHostIssue(number, { labels: ['status:open'] }));
    const tasks = [1, 2, 3].map((number) => holding(`T${number}`, number, { status: 'in-progress' }));
    const plan = planPush(REPO, issues, tasks, { writesPerRun: 5, closes: true });
    assert.deepEqual(
      plan.changes.map((change) => change.task),
      ['T1', 'T2'],
    );
    assert.deepEqual(
      plan.deferred.map((change) => change.task),
      ['T3'],
    );
    assert.deepEqual(planPush(REPO, issues, tasks, { writesPerRun: 0, closes: true }).changes, []);
  });

  it('without closes holds each closing change, printed apart, and gives the run writes to the label changes', () => {
    const issues = [1, 2, 3].map((number) => testHostIssue(number, { labels: ['status:open'] }));
    const tasks = [holding('T1', 1, { status: 'done' }), holding('T2', 2, { status: 'dropped' }), holding('T3', 3, { status: 'in-progress' })];
    const plan = planPush(REPO, issues, tasks, { writesPerRun: 2, closes: false });
    assert.deepEqual(
      plan.heldCloses.map((change) => [change.task, change.close]),
      [
        ['T1', 'completed'],
        ['T2', 'not-planned'],
      ],
    );
    assert.deepEqual(
      plan.changes.map((change) => change.task),
      ['T3'],
    );
    assert.deepEqual(plan.deferred, []);
    assert.deepEqual(planPush(REPO, issues, tasks).heldCloses, []);
  });
});

describe('the assignee (T2999)', () => {
  const logins = sessionLogins({ octocat: 'bravo', hubot: 'bravo', monalisa: 'alpha' });

  it("maps each session to its first login, and an issue to its session's login, else the repository's owner", () => {
    assert.deepEqual([...logins], [
      ['bravo', 'octocat'],
      ['alpha', 'monalisa'],
    ]);
    assert.equal(assigneeOf(REPO, 'bravo', logins), 'octocat');
    assert.equal(assigneeOf(REPO, 'lead', logins), 'acme');
  });

  it('assigns an open issue of a scheduled task no one is assigned to, alone or with its label, and never one a person assigned', () => {
    const issues = [testHostIssue(7), testHostIssue(8, { labels: ['status:claimed'] }), testHostIssue(9, { assignees: ['someone'] })];
    const tasks = [holding('T1', 7, { owner: 'bravo', status: 'in-progress' }), holding('T2', 8, { owner: 'lead', due: '2030-01-09' }), holding('T3', 9, { owner: 'bravo' })];
    const plan = planPush(REPO, issues, tasks, undefined, logins);
    assert.deepEqual(
      plan.changes.map((change) => [change.task, change.add, change.assign, changeWrites(change)]),
      [
        ['T1', ['status:in progress'], 'octocat', 2],
        ['T2', [], 'acme', 1],
        ['T3', ['status:claimed'], undefined, 1],
      ],
    );
    assert.deepEqual(plan.changes.map(changeLine), [
      'LABEL acme/web#7 T1 in-progress: add status:in progress, assign octocat',
      'ASSIGN acme/web#8 T2 open: assign acme',
      'LABEL acme/web#9 T3 open: add status:claimed',
    ]);
  });

  it('assigns no one to the issue of an open task no one scheduled, and claims it once a person is assigned (T3021)', () => {
    const issues = [testHostIssue(7, { labels: ['status:open'] }), testHostIssue(8, { labels: ['status:open'], assignees: ['someone'] })];
    const plan = planPush(REPO, issues, [holding('T1', 7, { owner: 'bravo' }), holding('T2', 8, { owner: 'bravo' })], undefined, logins);
    assert.equal(plan.unchanged, 1);
    assert.deepEqual(plan.changes.map(changeLine), ['LABEL acme/web#8 T2 open: add status:claimed, take off status:open']);
  });

  it('takes every status label off a goal, and still assigns it once scheduled (T3056)', () => {
    const issues = [testHostIssue(7, { labels: ['feature', 'status:open'] }), testHostIssue(8)];
    const tasks = [holding('T1', 7, { owner: 'bravo', after: ['T3'] }), holding('T2', 8, { owner: 'bravo', status: 'in-progress', after: ['T3'] })];
    const plan = planPush(REPO, issues, tasks, undefined, logins);
    assert.deepEqual(plan.changes.map(changeLine), ['LABEL acme/web#7 T1 open: take off status:open', 'ASSIGN acme/web#8 T2 in-progress: assign octocat']);
  });

  it('assigns no closing issue, and nobody without logins', () => {
    const issues = [testHostIssue(7), testHostIssue(8, { labels: ['status:open'] })];
    assert.equal(planPush(REPO, issues, [holding('T1', 7, { status: 'done' })], undefined, logins).changes[0]?.assign, undefined);
    assert.deepEqual(planPush(REPO, issues, [holding('T2', 8, { status: 'open' })]).changes, []);
  });
});

describe('autoPushWrites (T2876)', () => {
  it('keeps the run writes when the hour holds them, and lowers them so an hour of runs stays within the hourly writes', () => {
    assert.equal(autoPushWrites(900), PUSH_WRITES_PER_RUN);
    assert.equal(autoPushWrites(300), 20);
    assert.equal(autoPushWrites(60), 4);
    assert.equal(autoPushWrites(30), 2);
    // Every 7 minutes, 9 runs start within an hour: 27 writes each, not floor(250 * 7 / 60) = 29.
    assert.equal(autoPushWrites(420), 27);
    assert.equal(autoPushWrites(0), 0);
    for (const probeSeconds of [30, 45, 60, 90, 120, 300, 420, 540, 600, 660, 780, 900, 3540, 3600]) {
      assert.ok(autoPushWrites(probeSeconds) * Math.ceil(3600 / probeSeconds) <= PUSH_WRITES_PER_HOUR, `every ${probeSeconds} seconds`);
    }
  });
});

describe('changeLine (T2682)', () => {
  const target = { repo: REPO, number: 7 };

  it('prints a label swap', () => {
    const change: IssueChange = { target, task: 'T1', status: 'waiting', add: [STATUS_LABELS.waiting], remove: ['status:open'], close: undefined };
    assert.equal(changeLine(change), 'LABEL acme/web#7 T1 waiting: add status:waiting, take off status:open');
  });

  it('prints a close first', () => {
    const change: IssueChange = { target, task: 'T1', status: 'dropped', add: [], remove: ['status:waiting'], close: 'not-planned' };
    assert.equal(changeLine(change), 'CLOSE acme/web#7 T1 dropped: close as not-planned, take off status:waiting');
  });
});
