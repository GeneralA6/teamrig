import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { testConfig } from '../testing/config.ts';
import type { GithubIssue } from './issues.ts';
import { importRules, issueOutcome, issueOwner, issuePriority, issueRef, issueTask, taskTitle, type ImportRules } from './map.ts';

const RULES: ImportRules = importRules(testConfig({ github: { repos: ['acme/web'], owners: { octocat: 'bravo', hubot: 'alpha' } } }));

function issue(overrides: Partial<GithubIssue> = {}): GithubIssue {
  return {
    repo: 'acme/web',
    number: 7,
    title: 'Fix login',
    state: 'open',
    stateReason: '',
    labels: [],
    assignees: [],
    url: 'https://github.com/acme/web/issues/7',
    ...overrides,
  };
}

describe('importRules', () => {
  it('takes the title cap, the priority levels, the owners and the lead from the config', () => {
    assert.deepEqual(RULES, { maxTitle: 140, priorities: [1, 2, 3, 4, 5], owners: new Map([['octocat', 'bravo'], ['hubot', 'alpha']]), repoSessions: new Map(), lead: 'lead' });
  });
});

describe('issueTask', () => {
  it('makes an open issue a task keyed by its ref, with its title, priority label and assignee', () => {
    assert.deepEqual(issueTask(issue({ labels: ['bug', 'p1'], assignees: ['octocat'] }), RULES), {
      ref: 'gh:acme/web#7',
      title: 'Fix login',
      priority: 1,
      owner: 'bravo',
      outcome: 'open',
      url: 'https://github.com/acme/web/issues/7',
    });
    assert.equal(issueRef('acme/web', 12), 'gh:acme/web#12');
  });
});

describe('taskTitle', () => {
  it('strips control and format characters, so an outside title stays one plain line', () => {
    assert.equal(taskTitle(issue({ title: 'Fix\u001b[31m login‮\r\nnow' }), 140), 'Fix [31m login now');
  });

  it('cuts a long title to the cap, never between the halves of a character', () => {
    assert.equal(taskTitle(issue({ title: 'abcdef ghij' }), 7), 'abcdef');
    assert.equal(taskTitle(issue({ title: 'abc\u{1F600}def' }), 4), 'abc');
    assert.equal(taskTitle(issue({ title: 'abc\u{1F600}def' }), 5), 'abc\u{1F600}');
  });

  it('names the issue when its title has nothing left', () => {
    assert.equal(taskTitle(issue({ title: ' \u0007​ ' }), 140), 'GitHub issue acme/web#7');
  });
});

describe('issuePriority', () => {
  it('takes the most urgent p<n> label that is a team level, in any case', () => {
    assert.equal(issuePriority(['P3', 'bug', ' p2 '], [1, 2, 3]), 2);
    assert.equal(issuePriority(['p9', 'p3'], [1, 2, 3]), 3);
  });

  it('falls back to p2, or to the least urgent level of a team with no p2', () => {
    assert.equal(issuePriority(['bug', 'p9', 'priority-1', 'p0'], [1, 2, 3]), 2);
    assert.equal(issuePriority([], [1, 3, 4]), 4);
  });
});

describe('issueOwner', () => {
  it('gives the issue to the first listed assignee, in any case, else to the lead', () => {
    assert.equal(issueOwner({ repo: 'acme/web', assignees: ['monalisa', 'HuBot', 'octocat'] }, RULES), 'alpha');
    assert.equal(issueOwner({ repo: 'acme/web', assignees: ['monalisa', 'constructor'] }, RULES), 'lead');
    assert.equal(issueOwner({ repo: 'acme/web', assignees: [] }, RULES), 'lead');
  });

  it("gives an issue no listed login is assigned to its repository's session, before the lead", () => {
    const rules = importRules(testConfig({ github: { repos: ['acme/web', 'acme/api'], owners: { octocat: 'bravo' }, sessions: { 'acme/api': 'alpha' } } }));
    assert.equal(issueOwner({ repo: 'acme/api', assignees: ['monalisa'] }, rules), 'alpha');
    assert.equal(issueOwner({ repo: 'acme/api', assignees: ['octocat'] }, rules), 'bravo');
    assert.equal(issueOwner({ repo: 'acme/web', assignees: [] }, rules), 'lead');
  });
});

describe('issueOutcome', () => {
  it('reads open as open, closed as not planned or duplicate as dropped, and any other close as done', () => {
    assert.equal(issueOutcome(issue({ stateReason: 'REOPENED' })), 'open');
    assert.equal(issueOutcome(issue({ state: 'closed', stateReason: 'NOT_PLANNED' })), 'dropped');
    assert.equal(issueOutcome(issue({ state: 'closed', stateReason: 'duplicate' })), 'dropped');
    assert.equal(issueOutcome(issue({ state: 'closed', stateReason: 'COMPLETED' })), 'done');
    assert.equal(issueOutcome(issue({ state: 'closed', stateReason: '' })), 'done');
  });
});
