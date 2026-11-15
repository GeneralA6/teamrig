import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { testConfig } from '../testing/config.ts';
import type { HostIssue } from '../issues/issue.ts';
import { MAX_DESCRIPTION } from '../config/defaults.ts';
import { SecretScanner } from '../core/secrets.ts';
import { importRules, issueOutcome, issueOwner, issuePriority, issueRef, issueTask, SECRET_BODY, taskDescription, taskTitle, type ImportRules } from './map.ts';

const RULES: ImportRules = importRules(testConfig({ github: { repos: ['acme/web'], owners: { octocat: 'bravo', hubot: 'alpha' } } }));
const SECRETS = new SecretScanner();

/** Built at runtime so no credential-shaped literal sits in the source. */
function credentialUrl(): string {
  return ['https://', 'user', ':', 'hunter2', '@', 'example.test'].join('');
}

function issue(overrides: Partial<HostIssue> = {}): HostIssue {
  return {
    repo: 'acme/web',
    number: 7,
    title: 'Fix login',
    body: '',
    state: 'open',
    stateReason: '',
    labels: [],
    assignees: [],
    url: 'https://github.com/acme/web/issues/7',
    updatedAt: '2030-01-01T00:00:00Z',
    closedAt: undefined,
    lastEditedAt: undefined,
    authorAssociation: 'OWNER',
    author: 'maintainer',
    authorKind: 'User',
    labelEvents: [],
    renamedAt: undefined,
    ...overrides,
  };
}

describe('importRules', () => {
  it('takes the title cap, the priority levels, the owners, the lead, the secret shapes and the accept label from the config', () => {
    const { secrets, ...rest } = RULES;
    assert.deepEqual(rest, {
      maxTitle: 140,
      priorities: [1, 2, 3, 4, 5],
      owners: new Map([['octocat', 'bravo'], ['hubot', 'alpha']]),
      repoSessions: new Map(),
      lead: 'lead',
      acceptLabel: 'teamrig',
    });
    assert.equal(importRules(testConfig({ github: { acceptLabel: 'Accepted' } })).acceptLabel, 'Accepted');
    assert.equal(secrets.find('uses tok_abcd1234'), undefined);
    const strict = importRules(testConfig({ register: { secretPatterns: ['tok_[a-z0-9]{8}'] } }));
    assert.equal(strict.secrets.find('uses tok_abcd1234')?.id, 'config-1');
  });
});

describe('issueTask', () => {
  it('makes an open issue a task keyed by its ref, with its title, body, priority label and assignee', () => {
    assert.deepEqual(issueTask(issue({ body: 'Steps:\r\n1. log in', labels: ['bug', 'p1'], assignees: ['octocat'] }), RULES), {
      ref: 'gh:acme/web#7',
      title: 'Fix login',
      description: 'Steps:\n1. log in',
      priority: 1,
      owner: 'bravo',
      outcome: 'open',
      url: 'https://github.com/acme/web/issues/7',
    });
    assert.equal(issueTask(issue(), RULES).description, null);
    assert.equal(issueRef('acme/web', 12), 'gh:acme/web#12');
  });
});

describe('taskDescription', () => {
  it('gives none for an empty or blank body', () => {
    assert.equal(taskDescription('', SECRETS), null);
    assert.equal(taskDescription(' \r\n\t\n ', SECRETS), null);
  });

  it('keeps the lines, turning control and format characters into spaces and closing up blank lines', () => {
    const body = '\n\n## Steps  \r\n1. log\u001b[31m in‮\r\n\r\n\r\n\r\n2. see\tthe error\n\n';
    assert.equal(taskDescription(body, SECRETS), '## Steps\n1. log [31m in\n\n2. see the error');
  });

  it(`cuts a body past ${MAX_DESCRIPTION} characters, ending with an ellipsis, never between the halves of a character`, () => {
    const exact = 'b'.repeat(MAX_DESCRIPTION);
    assert.equal(taskDescription(exact, SECRETS), exact);
    const long = taskDescription(`${'b'.repeat(MAX_DESCRIPTION - 2)} tail`, SECRETS) ?? '';
    assert.equal(long, `${'b'.repeat(MAX_DESCRIPTION - 2)}…`);
    const split = taskDescription(`${'b'.repeat(MAX_DESCRIPTION - 2)}\u{1F600}more`, SECRETS) ?? '';
    assert.equal(split, `${'b'.repeat(MAX_DESCRIPTION - 2)}…`);
    assert.ok(split.length <= MAX_DESCRIPTION);
  });

  it('leaves out a body that looks like it holds a secret, in the kept part or past the cut', () => {
    assert.equal(taskDescription(`log in at ${credentialUrl()}`, SECRETS), SECRET_BODY);
    assert.equal(taskDescription(`${'b'.repeat(MAX_DESCRIPTION)} ${credentialUrl()}`, SECRETS), SECRET_BODY);
    assert.equal(taskDescription('uses tok_abcd1234', new SecretScanner(['tok_[a-z0-9]{8}'])), SECRET_BODY);
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
