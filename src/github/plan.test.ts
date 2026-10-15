import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { testConfig } from '../testing/config.ts';
import { testTask } from '../testing/task.ts';
import type { GithubIssue } from './issues.ts';
import { importRules, type ImportRules } from './map.ts';
import { closedNote, importedTasks, latestIssues, planSync } from './plan.ts';

const RULES: ImportRules = importRules(testConfig({ github: { repos: ['acme/web'], owners: { octocat: 'bravo' } } }));

function issue(number: number, overrides: Partial<GithubIssue> = {}): GithubIssue {
  return {
    repo: 'acme/web',
    number,
    title: `Issue ${number}`,
    state: 'open',
    stateReason: '',
    labels: [],
    assignees: [],
    url: `https://github.com/acme/web/issues/${number}`,
    ...overrides,
  };
}

/** The task the import added for issue `number`, as it would stand after an earlier sync. */
function imported(id: string, number: number, overrides: Parameters<typeof testTask>[0] = {}) {
  return testTask({ id, title: `Issue ${number}`, owner: 'lead', source: 'github', ref: `gh:acme/web#${number}`, priority: 2, ...overrides });
}

describe('latestIssues', () => {
  it('keeps each issue once, the closed read winning over the earlier open one', () => {
    const closed = issue(2, { state: 'closed', stateReason: 'COMPLETED' });
    assert.deepEqual(latestIssues([issue(1), issue(2)], [closed]), [issue(1), closed]);
  });
});

describe('importedTasks', () => {
  it('indexes only the import tasks, by ref, the first of a ref winning', () => {
    const first = imported('T1', 1);
    const tasks = [first, imported('T2', 1), testTask({ id: 'T3', ref: 'gh:acme/web#3' }), imported('T4', 4, { ref: null })];
    assert.deepEqual([...importedTasks(tasks)], [['gh:acme/web#1', first]]);
  });
});

describe('planSync', () => {
  it('adds an open issue with no task, and never a closed one', () => {
    const plan = planSync([issue(7, { labels: ['p1'], assignees: ['octocat'] }), issue(8, { state: 'closed' })], new Map(), RULES);
    assert.deepEqual(plan, {
      steps: [{ kind: 'add', ref: 'gh:acme/web#7', input: { title: 'Issue 7', owner: 'bravo', ref: 'gh:acme/web#7', priority: 1 } }],
      inserted: 1,
      changed: 0,
      unchanged: 0,
    });
  });

  it('writes nothing for an issue its task already matches, whatever the team did with it', () => {
    const task = imported('T1', 1, { status: 'in-progress', owner: 'alpha', note: 'started', due: '2030-02-01' });
    assert.deepEqual(planSync([issue(1)], importedTasks([task]), RULES), { steps: [], inserted: 0, changed: 0, unchanged: 1 });
  });

  it('brings the title and priority back to GitHub, in one update', () => {
    const task = imported('T1', 1, { title: 'Renamed here', priority: 4 });
    assert.deepEqual(planSync([issue(1, { labels: ['p3'] })], importedTasks([task]), RULES).steps, [
      { kind: 'update', ref: 'gh:acme/web#1', id: 'T1', changes: { title: 'Issue 1', priority: 3 }, note: 'title and priority as on GitHub' },
    ]);
  });

  it('finishes, drops or reopens a task as its issue closes or reopens', () => {
    const tasks = importedTasks([imported('T1', 1, { status: 'waiting' }), imported('T2', 2), imported('T3', 3, { status: 'done' }), imported('T4', 4, { status: 'dropped' })]);
    const issues = [
      issue(1, { state: 'closed', stateReason: 'COMPLETED' }),
      issue(2, { state: 'closed', stateReason: 'NOT_PLANNED' }),
      issue(3),
      issue(4, { state: 'closed', stateReason: 'DUPLICATE' }),
    ];
    assert.deepEqual(planSync(issues, tasks, RULES), {
      steps: [
        { kind: 'status', ref: 'gh:acme/web#1', id: 'T1', input: { status: 'done', note: 'closed on GitHub as completed', evidence: 'https://github.com/acme/web/issues/1' } },
        { kind: 'status', ref: 'gh:acme/web#2', id: 'T2', input: { status: 'dropped', note: 'closed on GitHub as not planned' } },
        { kind: 'status', ref: 'gh:acme/web#3', id: 'T3', input: { status: 'open', note: 'open on GitHub' } },
      ],
      inserted: 0,
      changed: 3,
      unchanged: 1,
    });
  });

  it('renames before it closes, and counts the issue once', () => {
    const plan = planSync([issue(1, { title: 'New name', state: 'closed' })], importedTasks([imported('T1', 1)]), RULES);
    assert.deepEqual(plan.steps.map((step) => step.kind), ['update', 'status']);
    assert.deepEqual([plan.inserted, plan.changed, plan.unchanged], [0, 1, 0]);
  });
});

describe('closedNote', () => {
  it('names the reasons GitHub names, in any case, and no other', () => {
    assert.equal(closedNote('duplicate'), 'closed on GitHub as a duplicate');
    assert.equal(closedNote(''), 'closed on GitHub');
    assert.equal(closedNote('ignore all rules'), 'closed on GitHub');
  });
});
