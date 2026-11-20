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
  hourPushWrites,
  isGoal,
  issueGoal,
  issuePushPlan,
  planIssue,
  planPush,
  PUSH_WRITES_PER_HOUR,
  PUSH_WRITES_PER_RUN,
  scheduled,
  SESSION_PUSH,
  STATUS_LABELS,
  assigneeOf,
  pushAssignees,
  sessionLogins,
  VIEWER_UNREAD,
  viewerRead,
  type IssueChange,
} from './status-push.ts';

const REPO = 'acme/web';

/** Task `id` holding acme/web#`number`, as a team task (migrated) unless overridden. */
function holding(id: string, number: number, overrides: Partial<Task> = {}): Task {
  return testTask({ id, ref: `gh:${REPO}#${number}`, ...overrides });
}

describe('issueGoal (T2682)', () => {
  const task = (overrides: Partial<Task>): Task => testTask(overrides);
  const FREE = { assigned: false, design: false };
  const TAKEN = { assigned: true, design: false };

  it('gives each started status its one label, its issue claimed', () => {
    assert.deepEqual(issueGoal(task({ status: 'in-progress' }), FREE), { open: true, label: 'status:in progress', claim: true });
    assert.deepEqual(issueGoal(task({ status: 'waiting' }), FREE), { open: true, label: 'status:waiting', claim: true });
    assert.deepEqual(issueGoal(task({ status: 'verifying' }), FREE), { open: true, label: 'status:in review', claim: true });
  });

  it('leaves an open task no one scheduled or took open to anyone, and claims one with a due date or an assignee (T3021)', () => {
    assert.deepEqual(issueGoal(task({ status: 'open' }), FREE), { open: true, label: 'status:open', claim: false });
    assert.deepEqual(issueGoal(task({ status: 'open', due: '2030-01-09' }), FREE), { open: true, label: 'status:claimed', claim: true });
    assert.deepEqual(issueGoal(task({ status: 'open' }), TAKEN), { open: true, label: 'status:claimed', claim: false });
  });

  it('gives a goal, a task planned after its parts, no status label (T3056)', () => {
    assert.deepEqual(issueGoal(task({ status: 'open', after: ['T2'] }), FREE), { open: true, label: undefined, claim: false });
    assert.deepEqual(issueGoal(task({ status: 'in-progress', after: ['T2'] }), FREE), { open: true, label: undefined, claim: true });
  });

  it('gives a design issue no status label and no claim, whatever its task, until the task closes (T3096)', () => {
    const DESIGN = { assigned: false, design: true };
    assert.deepEqual(issueGoal(task({ status: 'open' }), DESIGN), { open: true, label: undefined, claim: false });
    assert.deepEqual(issueGoal(task({ status: 'in-progress', due: '2030-01-09' }), { assigned: true, design: true }), { open: true, label: undefined, claim: false });
    assert.deepEqual(issueGoal(task({ status: 'done' }), DESIGN), { open: false, reason: 'completed' });
  });

  it('closes a done task as completed and a dropped one as not planned, goal or not', () => {
    assert.deepEqual(issueGoal(task({ status: 'done' }), FREE), { open: false, reason: 'completed' });
    assert.deepEqual(issueGoal(task({ status: 'dropped', after: ['T2'] }), FREE), { open: false, reason: 'not-planned' });
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

  it('plans a status label under the name the tracker holds it by, so one it renames is not added again on every run (T4754)', () => {
    const hyphens = (label: string): string => label.replace(/\s+/gu, '-');
    const tasks = [holding('T1', 7, { status: 'in-progress' })];
    const planned = (labels: string[]): ReturnType<typeof planPush> => planPush(REPO, [testHostIssue(7, { labels })], tasks, SESSION_PUSH, undefined, new Set(), hyphens);
    const held = planned(['status:in-progress']);
    assert.deepEqual([held.changes, held.unchanged], [[], 1]);
    assert.deepEqual(
      planned([]).changes.map((change) => [change.add, change.remove]),
      [[['status:in-progress'], []]],
    );
    assert.deepEqual(
      planned(['status:in progress']).changes.map((change) => [change.add, change.remove]),
      [[['status:in-progress'], ['status:in progress']]],
    );
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

  it('never closes an open issue a finished task only took part in: one taken outside the team, or a design issue (T3350)', () => {
    const logins = sessionLogins({ 'Team-Dev': 'dev' });
    const plan = planPush(
      REPO,
      [
        testHostIssue(7, { assignees: ['outsider'], labels: ['status:waiting'] }),
        testHostIssue(8, { labels: ['design'] }),
        testHostIssue(9, { assignees: ['team-dev'] }),
        testHostIssue(10, { assignees: ['ACME', 'outsider'] }),
      ],
      [holding('T1', 7, { status: 'done' }), holding('T2', 8, { status: 'dropped' }), holding('T3', 9, { status: 'done' }), holding('T4', 10, { status: 'done' })],
      SESSION_PUSH,
      pushAssignees(logins, viewerRead(undefined)),
    );
    assert.deepEqual(plan.keptOpen, [
      { target: { repo: REPO, number: 7 }, task: 'T1', status: 'done', why: { kind: 'taken', assignees: ['outsider'] } },
      { target: { repo: REPO, number: 8 }, task: 'T2', status: 'dropped', why: { kind: 'design' } },
    ]);
    assert.deepEqual(
      plan.changes.map((change) => [change.task, change.close]),
      [
        ['T3', 'completed'],
        ['T4', 'completed'],
      ],
    );
    assert.deepEqual(plan.heldCloses, []);
  });

  it('counts only the repository owner as the team when no logins are given (T3350)', () => {
    const plan = planPush(REPO, [testHostIssue(7, { assignees: ['acme'] }), testHostIssue(8, { assignees: ['outsider'] })], [holding('T1', 7, { status: 'done' }), holding('T2', 8, { status: 'done' })]);
    assert.deepEqual(
      plan.changes.map((change) => change.task),
      ['T1'],
    );
    assert.deepEqual(
      plan.keptOpen.map((kept) => kept.task),
      ['T2'],
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

  it('names an active task on an open pull request apart from the unlisted ones; one on a closed pull request stays unlisted (#1451)', () => {
    const plan = planPush(REPO, [], [holding('T1', 9), holding('T2', 10, { status: 'in-progress' })], SESSION_PUSH, undefined, new Set([9]));
    assert.deepEqual(plan.openPulls, [{ target: { repo: REPO, number: 9 }, task: 'T1', status: 'open' }]);
    assert.deepEqual(plan.unlisted, [{ target: { repo: REPO, number: 10 }, task: 'T2', status: 'in-progress' }]);
    assert.deepEqual([plan.changes, plan.unchanged], [[], 0]);
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

  it('writes nothing for an issue two team tasks hold, and names them, while pushing the other issues (#1449)', () => {
    const tasks = [
      holding('T3', 7),
      holding('T5', 7, { source: 'github' }),
      holding('T9', 7, { status: 'in-progress' }),
      holding('T4', 8, { status: 'in-progress' }),
    ];
    for (const order of [tasks, [...tasks].reverse()]) {
      const plan = planPush(REPO, [testHostIssue(7, { labels: ['status:in progress'] }), testHostIssue(8)], order);
      assert.deepEqual(
        plan.changes.map((change) => change.task),
        ['T4'],
      );
      assert.deepEqual(plan.shared, [{ target: { repo: REPO, number: 7 }, tasks: ['T3', 'T9'] }]);
      assert.equal(plan.unchanged, 0);
    }
  });

  it('lets the one active team task speak over finished ones on its issue, and the newest finished one when none is active (#1449)', () => {
    const tasks = [holding('T2', 7, { status: 'done' }), holding('T6', 7, { status: 'dropped' }), holding('T11', 7, { status: 'in-progress' })];
    for (const order of [tasks, [...tasks].reverse()]) {
      const plan = planPush(REPO, [testHostIssue(7, { labels: ['status:open'] })], order);
      assert.deepEqual(
        plan.changes.map((change) => change.task),
        ['T11'],
      );
      assert.deepEqual(plan.shared, []);
    }
    const finished = [holding('T2', 7, { status: 'dropped' }), holding('T10', 7, { status: 'done' })];
    for (const order of [finished, [...finished].reverse()]) {
      const plan = planPush(REPO, [testHostIssue(7, { labels: ['status:open'] })], order);
      assert.deepEqual(
        plan.changes.map((change) => change.task),
        ['T10'],
      );
      assert.deepEqual(plan.shared, []);
    }
  });

  it('names only the active team tasks of an issue it leaves shared (#1449)', () => {
    const tasks = [holding('T1', 7, { status: 'done' }), holding('T3', 7), holding('T9', 7, { status: 'waiting' })];
    const plan = planPush(REPO, [testHostIssue(7)], tasks);
    assert.deepEqual(plan.changes, []);
    assert.deepEqual(plan.shared, [{ target: { repo: REPO, number: 7 }, tasks: ['T3', 'T9'] }]);
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

describe('planIssue (T3169)', () => {
  const target = { repo: REPO, number: 922 };

  it('plans one issue as the repository push would: its status label, an assign of a scheduled task, a close of an ended one', () => {
    const who = pushAssignees(sessionLogins({ octocat: 'bravo' }), VIEWER_UNREAD);
    const verifying = holding('T1', 922, { owner: 'bravo', status: 'verifying' });
    const plan = planIssue(target, verifying, { state: 'open', labels: ['bug', 'status:open'], assignees: [] }, who);
    assert.deepEqual(plan, { kind: 'change', change: { target, task: 'T1', status: 'verifying', add: ['status:in review'], remove: ['status:open'], close: undefined, assign: 'octocat' }, wantsViewer: false });
    assert.deepEqual(planPush(REPO, [testHostIssue(922, { labels: ['bug', 'status:open'] })], [verifying], undefined, who).changes, plan.kind === 'change' ? [plan.change] : []);
    const done = planIssue(target, holding('T1', 922, { status: 'done' }), { state: 'open', labels: ['status:in review'], assignees: [] });
    assert.deepEqual(done, { kind: 'change', change: { target, task: 'T1', status: 'done', add: [], remove: ['status:in review'], close: 'completed' }, wantsViewer: false });
  });

  it('wants the viewer read for an assign its session maps to no login, and assigns the viewer once read (T4581)', () => {
    const unmapped = holding('T1', 922, { owner: 'charlie', status: 'in-progress' });
    const issue = { state: 'open' as const, labels: ['status:open'], assignees: [] };
    const before = planIssue(target, unmapped, issue, pushAssignees(sessionLogins({}), VIEWER_UNREAD));
    assert.ok(before.kind === 'change' && before.wantsViewer && before.change.assign === undefined);
    const after = planIssue(target, unmapped, issue, pushAssignees(sessionLogins({}), viewerRead('sync-bot')));
    assert.ok(after.kind === 'change' && !after.wantsViewer && after.change.assign === 'sync-bot');
  });

  it('leaves an issue showing its status unchanged, and a closed one whose task is active closed', () => {
    assert.deepEqual(planIssue(target, holding('T1', 922, { status: 'waiting' }), { state: 'open', labels: ['status:waiting'], assignees: ['x'] }), { kind: 'unchanged', wantsViewer: false });
    assert.deepEqual(planIssue(target, holding('T1', 922, { status: 'waiting' }), { state: 'closed', labels: [], assignees: [] }), { kind: 'closed-active' });
  });

  it('makes a plan of the one issue as its repository plan: its change alone, nothing for an unchanged or a closed-active one', () => {
    const who = pushAssignees(sessionLogins({ octocat: 'bravo' }), VIEWER_UNREAD);
    const none = { repo: REPO, deferred: [], heldCloses: [], closedActive: [], keptOpen: [], unlisted: [], shared: [], openPulls: [], wantsViewer: false };
    const open = holding('T1', 922, { owner: 'bravo', status: 'open' });
    // An open task whose issue has an assignee shows claimed, as in the repository push.
    const change: IssueChange = { target, task: 'T1', status: 'open', add: ['status:claimed'], remove: [], close: undefined };
    assert.deepEqual(issuePushPlan(target, open, { state: 'open', labels: [], assignees: ['x'] }, who), { ...none, changes: [change], unchanged: 0 });
    assert.deepEqual(issuePushPlan(target, open, { state: 'open', labels: ['status:claimed'], assignees: ['x'] }, who), { ...none, changes: [], unchanged: 1 });
    assert.deepEqual(issuePushPlan(target, open, { state: 'closed', labels: [], assignees: [] }, who), { ...none, changes: [], unchanged: 0 });
  });

  it('leaves open an issue a finished task holds that is taken outside the team, or a design issue, as the repository push does', () => {
    const done = holding('T1', 922, { status: 'done' });
    assert.deepEqual(planIssue(target, done, { state: 'open', labels: ['status:in progress'], assignees: ['outsider'] }), { kind: 'kept-open', why: { kind: 'taken', assignees: ['outsider'] }, wantsViewer: false });
    assert.deepEqual(planIssue(target, done, { state: 'open', labels: ['design'], assignees: [] }), { kind: 'kept-open', why: { kind: 'design' }, wantsViewer: false });
    assert.equal(planIssue(target, done, { state: 'open', labels: [], assignees: ['acme'] }).kind, 'change', 'the repository owner is the team');
  });

  it('plans the one issue status label under the name the tracker holds it by, as the repository push does (T4754)', () => {
    const hyphens = (label: string): string => label.replace(/\s+/gu, '-');
    const verifying = holding('T1', 922, { status: 'verifying' });
    assert.deepEqual(planIssue(target, verifying, { state: 'open', labels: ['status:in-review'], assignees: ['x'] }, undefined, hyphens), { kind: 'unchanged', wantsViewer: false });
    const who = pushAssignees(sessionLogins({}), viewerRead('sync-bot'));
    assert.deepEqual(
      issuePushPlan(target, verifying, { state: 'open', labels: [], assignees: ['x'] }, who, hyphens).changes.map((change) => change.add),
      [['status:in-review']],
    );
    assert.deepEqual(
      issuePushPlan(target, verifying, { state: 'open', labels: [], assignees: ['x'] }, who).changes.map((change) => change.add),
      [['status:in review']],
    );
  });
});

describe('the assignee (T2999)', () => {
  const logins = sessionLogins({ octocat: 'bravo', hubot: 'bravo', monalisa: 'alpha' });
  const who = pushAssignees(logins, viewerRead('sync-bot'));

  it("maps each session to its first login, and an issue to its session's login, else the login the sync runs as, never the repository's owner (T4581)", () => {
    assert.deepEqual([...logins], [
      ['bravo', 'octocat'],
      ['alpha', 'monalisa'],
    ]);
    assert.equal(assigneeOf('bravo', who), 'octocat');
    assert.equal(assigneeOf('lead', who), 'sync-bot');
    assert.equal(assigneeOf('lead', pushAssignees(logins, viewerRead(undefined))), undefined);
    assert.equal(assigneeOf('lead', pushAssignees(logins, VIEWER_UNREAD)), undefined);
    assert.equal(assigneeOf('bravo', pushAssignees(logins, VIEWER_UNREAD)), 'octocat');
  });

  it('wants the unread viewer only for an issue its session cannot assign, or a close left for outside logins (T4581)', () => {
    const unread = pushAssignees(logins, VIEWER_UNREAD);
    const mapped = [holding('T1', 7, { owner: 'bravo', status: 'in-progress' })];
    assert.equal(planPush(REPO, [testHostIssue(7)], mapped, undefined, unread).wantsViewer, false);
    assert.equal(planPush(REPO, [testHostIssue(7)], [holding('T1', 7, { owner: 'lead', status: 'in-progress' })], undefined, unread).wantsViewer, true);
    assert.equal(planPush(REPO, [testHostIssue(7)], mapped, undefined, { ...unread, refused: new Set(['octocat']) }).wantsViewer, true);
    const finished = [holding('T1', 7, { owner: 'bravo', status: 'done' })];
    assert.equal(planPush(REPO, [testHostIssue(7, { assignees: ['outsider'] })], finished, undefined, unread).wantsViewer, true);
    assert.equal(planPush(REPO, [testHostIssue(7, { assignees: ['octocat'] })], finished, undefined, unread).wantsViewer, false);
    assert.equal(planPush(REPO, [testHostIssue(7, { assignees: ['outsider'] })], finished, undefined, pushAssignees(logins, viewerRead('outsider'))).wantsViewer, false);
    assert.equal(planPush(REPO, [testHostIssue(7)], [holding('T1', 7, { owner: 'lead', status: 'in-progress' })], undefined, who).wantsViewer, false);
  });

  it('passes over a login the repository refuses for the next in line, whatever its case, and gives the host spelling of one it takes (T4581)', () => {
    const read = { ...who, refused: new Set(['octocat']), spelled: new Map([['sync-bot', 'Sync-Bot']]) };
    assert.equal(assigneeOf('bravo', read), 'Sync-Bot');
    assert.equal(assigneeOf('alpha', read), 'monalisa');
    assert.equal(assigneeOf('bravo', { ...read, refused: new Set(['octocat', 'sync-bot']) }), undefined);
    assert.equal(assigneeOf('bravo', { ...who, refused: new Set(['octocat']), viewer: viewerRead('OctoCat') }), undefined);
  });

  it('assigns an open issue of a scheduled task no one is assigned to, alone or with its label, and never one a person assigned', () => {
    const issues = [testHostIssue(7), testHostIssue(8, { labels: ['status:claimed'] }), testHostIssue(9, { assignees: ['someone'] })];
    const tasks = [holding('T1', 7, { owner: 'bravo', status: 'in-progress' }), holding('T2', 8, { owner: 'lead', due: '2030-01-09' }), holding('T3', 9, { owner: 'bravo' })];
    const plan = planPush(REPO, issues, tasks, undefined, who);
    assert.deepEqual(
      plan.changes.map((change) => [change.task, change.add, change.assign, changeWrites(change)]),
      [
        ['T1', ['status:in progress'], 'octocat', 2],
        ['T2', [], 'sync-bot', 1],
        ['T3', ['status:claimed'], undefined, 1],
      ],
    );
    assert.deepEqual(plan.changes.map(changeLine), [
      'LABEL acme/web#7 T1 in-progress: add status:in progress, assign octocat',
      'ASSIGN acme/web#8 T2 open: assign sync-bot',
      'LABEL acme/web#9 T3 open: add status:claimed',
    ]);
  });

  it('plans no write for an assign no login is left for, so it takes none of the run (T4581)', () => {
    const issues = [testHostIssue(7, { labels: ['status:claimed'] }), testHostIssue(8)];
    const tasks = [holding('T1', 7, { owner: 'lead', due: '2030-01-09' }), holding('T2', 8, { owner: 'bravo', status: 'in-progress' })];
    const limits = { writesPerRun: 2, closes: true };
    assert.deepEqual(planPush(REPO, issues, tasks, limits, who).deferred.map((change) => change.task), ['T2']);
    const plan = planPush(REPO, issues, tasks, limits, { ...who, refused: new Set(['sync-bot']), spelled: new Map([['octocat', 'octocat']]) });
    assert.equal(plan.unchanged, 1);
    assert.deepEqual(plan.changes.map(changeLine), ['LABEL acme/web#8 T2 in-progress: add status:in progress, assign octocat']);
    assert.deepEqual(plan.deferred, []);
  });

  it("counts the login the sync runs as one of the team's, so a finished task closes an issue it was assigned (T4581)", () => {
    const plan = planPush(REPO, [testHostIssue(7, { assignees: ['Sync-Bot'] })], [holding('T1', 7, { status: 'done' })], SESSION_PUSH, who);
    assert.deepEqual(plan.keptOpen, []);
    assert.deepEqual(plan.changes.map((change) => change.close), ['completed']);
  });

  it('assigns no one to the issue of an open task no one scheduled, and claims it once a person is assigned (T3021)', () => {
    const issues = [testHostIssue(7, { labels: ['status:open'] }), testHostIssue(8, { labels: ['status:open'], assignees: ['someone'] })];
    const plan = planPush(REPO, issues, [holding('T1', 7, { owner: 'bravo' }), holding('T2', 8, { owner: 'bravo' })], undefined, who);
    assert.equal(plan.unchanged, 1);
    assert.deepEqual(plan.changes.map(changeLine), ['LABEL acme/web#8 T2 open: add status:claimed, take off status:open']);
  });

  it('takes every status label off a design issue and assigns it to no one, even once scheduled (T3096)', () => {
    const issues = [testHostIssue(7, { labels: ['design', 'status:open'] }), testHostIssue(8, { labels: ['design'] })];
    const tasks = [holding('T1', 7, { owner: 'bravo' }), holding('T2', 8, { owner: 'bravo', status: 'in-progress', due: '2030-01-09' })];
    const plan = planPush(REPO, issues, tasks, undefined, who);
    assert.equal(plan.unchanged, 1);
    assert.deepEqual(plan.changes.map(changeLine), ['LABEL acme/web#7 T1 open: take off status:open']);
  });

  it('takes every status label off a goal, and still assigns it once scheduled (T3056)', () => {
    const issues = [testHostIssue(7, { labels: ['feature', 'status:open'] }), testHostIssue(8)];
    const tasks = [holding('T1', 7, { owner: 'bravo', after: ['T3'] }), holding('T2', 8, { owner: 'bravo', status: 'in-progress', after: ['T3'] })];
    const plan = planPush(REPO, issues, tasks, undefined, who);
    assert.deepEqual(plan.changes.map(changeLine), ['LABEL acme/web#7 T1 open: take off status:open', 'ASSIGN acme/web#8 T2 in-progress: assign octocat']);
  });

  it('assigns no closing issue, and nobody without logins', () => {
    const issues = [testHostIssue(7), testHostIssue(8, { labels: ['status:open'] })];
    assert.equal(planPush(REPO, issues, [holding('T1', 7, { status: 'done' })], undefined, who).changes[0]?.assign, undefined);
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

describe('hourPushWrites (T4592)', () => {
  it('sends the run limit while the hour has room, at any probe interval', () => {
    assert.equal(hourPushWrites(60, 0), PUSH_WRITES_PER_RUN);
    assert.equal(hourPushWrites(30, 40), PUSH_WRITES_PER_RUN);
  });

  it('sends only what the hour has left, and none once it is spent', () => {
    assert.equal(hourPushWrites(60, PUSH_WRITES_PER_HOUR - 4), 4);
    assert.equal(hourPushWrites(60, PUSH_WRITES_PER_HOUR), 0);
    assert.equal(hourPushWrites(60, PUSH_WRITES_PER_HOUR + 5), 0);
  });

  it('sends nothing with the watch turned off', () => {
    assert.equal(hourPushWrites(0, 0), 0);
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
