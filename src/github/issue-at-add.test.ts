import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SecretScanner } from '../core/secrets.ts';
import { addIssuePlan, type AddIssueAsk, type AddIssuePlan } from './issue-at-add.ts';

const NONE: AddIssueAsk = { title: undefined, body: undefined, repo: undefined, local: undefined, ref: undefined, type: undefined, priority: 2 };
const ONE_REPO = { repos: ['acme/web'] };
const TWO_REPOS = { repos: ['acme/web', 'acme/api'] };
const AT_ADD = { repos: ['acme/web', 'acme/api'], issueAtAdd: 'acme/api' };
const ISSUE = { title: ' Add a health check ', body: 'Why it is needed.\n' };

function planned(ask: Partial<AddIssueAsk>, github: { readonly repos: readonly string[]; readonly issueAtAdd?: string }): AddIssuePlan {
  const verdict = addIssuePlan({ ...NONE, ...ask }, github, new SecretScanner());
  assert.ok(verdict.ok, verdict.ok ? '' : verdict.error);
  return verdict.value;
}

function refused(ask: Partial<AddIssueAsk>, github: { readonly repos: readonly string[]; readonly issueAtAdd?: string }): string {
  const verdict = addIssuePlan({ ...NONE, ...ask }, github, new SecretScanner());
  assert.ok(!verdict.ok, 'expected a refusal');
  return verdict.error;
}

describe('addIssuePlan', () => {
  it('asks nothing while github.issueAtAdd is unset and the add names no issue', () => {
    assert.deepEqual(planned({}, TWO_REPOS), { kind: 'none' });
    assert.deepEqual(planned({ ref: 'notes/plan.md' }, { repos: [] }), { kind: 'none' });
  });

  it('refuses an add with neither an issue nor a reason while github.issueAtAdd is set, unless --ref names an issue', () => {
    assert.match(refused({}, AT_ADD), /^github\.issueAtAdd is acme\/api: give the task's public issue with --issue <title> --issue-body <text>, or why it stays local with --local <reason>$/u);
    assert.match(refused({ ref: 'notes/plan.md' }, AT_ADD), /^github\.issueAtAdd is acme\/api/u);
    assert.deepEqual(planned({ ref: 'gh:acme/web#7' }, AT_ADD), { kind: 'none' });
  });

  it('opens the issue in --issue-repo, else issueAtAdd, else the only repository, labelled by type and priority', () => {
    assert.deepEqual(planned({ ...ISSUE, repo: 'Acme/Web', type: 'bug', priority: 0 }, AT_ADD), {
      kind: 'open',
      draft: { repo: 'acme/web', title: 'Add a health check', body: 'Why it is needed.', labels: ['bug', 'p1'] },
    });
    assert.deepEqual(planned({ ...ISSUE, priority: 2 }, AT_ADD), {
      kind: 'open',
      draft: { repo: 'acme/api', title: 'Add a health check', body: 'Why it is needed.', labels: ['enhancement', 'p2'] },
    });
    assert.deepEqual(planned({ ...ISSUE, type: 'task', priority: 3 }, ONE_REPO), {
      kind: 'open',
      draft: { repo: 'acme/web', title: 'Add a health check', body: 'Why it is needed.', labels: ['enhancement', 'p3'] },
    });
  });

  it('refuses an issue with no repository to open it in, or one outside github.repos', () => {
    assert.equal(refused(ISSUE, TWO_REPOS), '--issue-repo names the repository: github.repos has 2 (acme/web, acme/api) and github.issueAtAdd names none');
    assert.equal(refused(ISSUE, { repos: [] }), 'github.repos names no repository to open the issue in');
    assert.equal(refused({ ...ISSUE, repo: 'acme/other' }, TWO_REPOS), '--issue-repo acme/other is not one of github.repos (acme/web, acme/api)');
  });

  it('refuses half an issue, an issue with --ref, and wording that is not public', () => {
    const together = "--issue and --issue-body come together: the issue's public title and body";
    assert.equal(refused({ title: 'Only a title' }, ONE_REPO), together);
    assert.equal(refused({ body: 'Only a body' }, ONE_REPO), together);
    assert.equal(refused({ repo: 'acme/web' }, ONE_REPO), together);
    assert.equal(refused({ ...ISSUE, ref: 'gh:acme/web#7' }, ONE_REPO), "--issue points the task's ref at its new issue; give --issue or --ref, not both");
    assert.match(refused({ ...ISSUE, body: 'Follows T12.' }, ONE_REPO), /^the new task: the title or body names the task id T12/u);
    assert.match(refused({ ...ISSUE, title: 'two\nlines' }, ONE_REPO), /^the new task: the title is one line/u);
  });

  it('keeps a task local with its reason as its ref, and refuses a reason with an issue, a ref or no text', () => {
    assert.deepEqual(planned({ local: ' names an unfixed weakness ' }, AT_ADD), { kind: 'local', ref: 'local: names an unfixed weakness' });
    assert.equal(refused({ local: 'why', title: 'An issue' }, AT_ADD), '--local keeps the task off GitHub, so it takes no --issue, --issue-body or --issue-repo');
    assert.equal(refused({ local: 'why', ref: 'notes/plan.md' }, AT_ADD), "--local writes the task's ref as the reason; give --local or --ref, not both");
    assert.equal(refused({ local: '  ' }, AT_ADD), '--local is one line saying why the task gets no issue');
    assert.equal(refused({ local: 'two\nlines' }, AT_ADD), '--local is one line saying why the task gets no issue');
  });
});
