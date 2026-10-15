import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FakeGh, ghIssue } from '../testing/fake-gh.ts';
import { isReadCommand } from './gh.ts';
import { issueListArgs, listIssues, parseIssueList, plainLine, type IssueListRequest } from './issues.ts';

const OPEN: IssueListRequest = { repo: 'acme/web', state: 'open', limit: 500 };
const FIELDS = 'number,title,state,stateReason,labels,assignees,url';

/** A gh error, as `spawn` raises it. */
function spawnError(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

describe('issueListArgs', () => {
  it('lists one state as JSON with only the fields the import reads, never the body', () => {
    assert.deepEqual(issueListArgs(OPEN), ['issue', 'list', '-R', 'acme/web', '--state', 'open', '--limit', '500', '--json', FIELDS]);
    assert.deepEqual(issueListArgs({ repo: 'acme/web', state: 'closed', closedSince: '2029-12-25', limit: 50 }), [
      'issue', 'list', '-R', 'acme/web', '--state', 'closed', '--search', 'closed:>=2029-12-25', '--limit', '50', '--json', FIELDS,
    ]);
  });
});

describe('listIssues', () => {
  it('reads the issues of one state, with label names and assignee logins, through a read only', async () => {
    const gh = new FakeGh().holds('acme/web', [
      ghIssue('acme/web', 7, { title: 'Fix login', labels: ['bug', 'p1'], assignees: ['octocat'] }),
      ghIssue('acme/web', 8, { state: 'CLOSED', stateReason: 'COMPLETED' }),
    ]);
    const list = await listIssues(gh, { HOME: '/u' }, OPEN);
    assert.deepEqual(list, {
      kind: 'listed',
      issues: [
        { repo: 'acme/web', number: 7, title: 'Fix login', state: 'open', stateReason: '', labels: ['bug', 'p1'], assignees: ['octocat'], url: 'https://github.com/acme/web/issues/7' },
      ],
      unreadable: 0,
      full: false,
    });
    assert.deepEqual(gh.ran, [{ args: issueListArgs(OPEN), env: { HOME: '/u' } }]);
    assert.ok(gh.ran.every((request) => isReadCommand(request.args)));
  });

  it('says how to fix a repository the login cannot see', async () => {
    assert.deepEqual(await listIssues(new FakeGh(), {}, { ...OPEN, repo: 'acme/nope' }), {
      kind: 'failed',
      reason: 'acme/nope is not visible to the gh login: check github.repos, and that gh auth status shows an account that can read it',
    });
  });

  it('says to log in when gh has no login', async () => {
    const byCode = new FakeGh().answers('acme/web', { end: { kind: 'exited', code: 4 }, stdout: '', stderr: 'To get started with GitHub CLI, please run:  gh auth login\n' });
    const byText = new FakeGh().answers('acme/web', { end: { kind: 'exited', code: 1 }, stdout: '', stderr: 'HTTP 401: Bad credentials (https://api.github.com/graphql)\n' });
    for (const gh of [byCode, byText]) {
      assert.deepEqual(await listIssues(gh, {}, OPEN), { kind: 'failed', reason: 'gh is not logged in to GitHub: run gh auth login' });
    }
  });

  it('says gh is not installed, or why it could not start', async () => {
    assert.deepEqual(await listIssues(new FakeGh().failsWith(spawnError('spawn gh ENOENT', 'ENOENT')), {}, OPEN), {
      kind: 'failed',
      reason: 'gh, the GitHub CLI, is not installed or not on PATH: install it from https://cli.github.com, then run gh auth login',
    });
    assert.deepEqual(await listIssues(new FakeGh().failsWith(spawnError('spawn gh EACCES', 'EACCES')), {}, OPEN), {
      kind: 'failed',
      reason: 'gh could not start: spawn gh EACCES',
    });
  });

  it('gives any other failure as gh first stderr line, on one plain line, and a stop by its signal', async () => {
    const failed = new FakeGh().answers('acme/web', { end: { kind: 'exited', code: 1 }, stdout: '', stderr: 'HTTP 502:\u001b[31m Bad Gateway\nretry later\n' });
    assert.deepEqual(await listIssues(failed, {}, OPEN), { kind: 'failed', reason: 'gh issue list -R acme/web exited with code 1: HTTP 502: [31m Bad Gateway' });
    const stopped = new FakeGh().answers('acme/web', { end: { kind: 'signal', signal: 'SIGTERM' }, stdout: '', stderr: '' });
    assert.deepEqual(await listIssues(stopped, {}, OPEN), { kind: 'failed', reason: 'gh was stopped (SIGTERM) before it listed the issues of acme/web; it gets 60 s' });
  });
});

describe('parseIssueList', () => {
  it('refuses output that is not a JSON list', () => {
    for (const stdout of ['', 'not json', '{"number": 1}']) {
      assert.deepEqual(parseIssueList(stdout, OPEN), { kind: 'failed', reason: 'gh printed no JSON list of the issues of acme/web' });
    }
  });

  it('reads the shape gh prints, and counts each item it cannot read as an issue', () => {
    // Recorded from `gh issue list --json number,title,state,stateReason`: an open issue's stateReason is empty.
    const recorded = { number: 14704, state: 'OPEN', stateReason: '', title: 'run list shows cancelled jobs' };
    const items = [
      { ...recorded, url: 'https://github.com/cli/cli/issues/14704', labels: [{ name: 'bug' }, { id: 'no name' }], assignees: [{ login: 5 }, { login: 'octocat' }] },
      { ...recorded, number: '14705', url: 'https://github.com/cli/cli/issues/14705' },
      { ...recorded, number: 0, url: 'https://github.com/cli/cli/issues/0' },
      { ...recorded, state: 'MERGED', url: 'https://github.com/cli/cli/issues/14704' },
      { ...recorded, url: 'javascript:alert(1)' },
      { ...recorded, title: null, url: 'https://github.com/cli/cli/issues/14704' },
      { ...recorded, stateReason: null, labels: 'bug', url: 'https://github.com/cli/cli/issues/14706' },
      'an issue',
    ];
    const list = parseIssueList(JSON.stringify(items), { ...OPEN, repo: 'cli/cli', limit: 8 });
    assert.deepEqual(list, {
      kind: 'listed',
      issues: [
        { repo: 'cli/cli', number: 14704, title: 'run list shows cancelled jobs', state: 'open', stateReason: '', labels: ['bug'], assignees: ['octocat'], url: 'https://github.com/cli/cli/issues/14704' },
        { repo: 'cli/cli', number: 14704, title: 'run list shows cancelled jobs', state: 'open', stateReason: '', labels: [], assignees: [], url: 'https://github.com/cli/cli/issues/14706' },
      ],
      unreadable: 6,
      full: true,
    });
  });
});

describe('plainLine', () => {
  it('turns control and format characters into spaces, so outside text stays one plain line', () => {
    assert.equal(plainLine('  Fix\u001b[2J the‮ login\r\nnow\t '), 'Fix [2J the login now');
  });
});
