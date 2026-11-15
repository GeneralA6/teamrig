import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SecretScanner } from '../core/secrets.ts';
import { FakeCredentials } from '../testing/fake-credentials.ts';
import type { JsonRecord } from '../core/guards.ts';
import type { IssueDraft } from '../issues/host.ts';
import { FakeGh, ghIssue } from '../testing/fake-gh.ts';
import { isIssueClose, isIssueComment, isIssueCreate, isIssueQuery, type GhRequest, type GhResult, type GhRunner } from './gh.ts';
import { GitHubIssueHost } from './host.ts';
import { ISSUE_LIMIT, issuePageArgs } from './issues.ts';
import { CLOSED_ISSUES_QUERY } from './queries.ts';
import { RepoTokens } from './tokens.ts';

const ENV = { HOME: '/u' };
const TARGET = { repo: 'acme/web', number: 7 };
const DRAFT: IssueDraft = { repo: 'acme/web', title: 'Fix login', body: 'Steps', labels: ['bug'] };

function hostWith(gh: GhRunner, credentials: FakeCredentials = new FakeCredentials()): GitHubIssueHost {
  return new GitHubIssueHost(gh, new RepoTokens(credentials, ENV), new SecretScanner(['tok_[a-z0-9]{8}']));
}

/** A gh whose closed read fails, as a rate limit hit between the two reads would; the open read is one page. */
class ClosedFails implements GhRunner {
  readonly ran: GhRequest[] = [];
  private readonly open: readonly JsonRecord[];

  constructor(open: readonly JsonRecord[]) {
    this.open = open;
  }

  async run(request: GhRequest): Promise<GhResult> {
    this.ran.push(request);
    const page = { data: { repository: { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: this.open } } } };
    return request.args.includes(`query=${CLOSED_ISSUES_QUERY}`)
      ? { end: { kind: 'exited', code: 1 }, stdout: '', stderr: 'HTTP 403: API rate limit exceeded\n' }
      : { end: { kind: 'exited', code: 0 }, stdout: JSON.stringify(page), stderr: '' };
  }
}

describe('GitHubIssueHost.reach', () => {
  it('words the access for what the run does, scoped to the owner', async () => {
    const host = hostWith(new FakeGh(), new FakeCredentials().saves('teamrig-gh-acme', 'k'));
    assert.deepEqual(await host.reach('acme/web', 'read'), { kind: 'reached', access: 'acme: read with the token saved as teamrig-gh-acme', scope: 'acme' });
    assert.deepEqual(await host.reach('acme/api', 'open'), { kind: 'reached', access: 'acme: opens issues with the token saved as teamrig-gh-acme', scope: 'acme' });
  });
});

describe('GitHubIssueHost.list', () => {
  it('reads the open issues, then those closed since the day, a page of each shipped query when a page holds them', async () => {
    const gh = new FakeGh().holds('acme/web', [ghIssue('acme/web', 7), ghIssue('acme/web', 8, { state: 'CLOSED', stateReason: 'COMPLETED' })]);
    const list = await hostWith(gh).list('acme/web', '2029-12-25');
    assert.equal(list.kind, 'listed');
    assert.deepEqual(list.kind === 'listed' && list.issues.map((issue) => [issue.number, issue.state]), [[7, 'open'], [8, 'closed']]);
    assert.deepEqual(list.kind === 'listed' && list.notes, []);
    assert.deepEqual(
      gh.ran.map((request) => request.args),
      [
        issuePageArgs({ repo: 'acme/web', state: 'open', limit: ISSUE_LIMIT }, undefined),
        issuePageArgs({ repo: 'acme/web', state: 'closed', closedSince: '2029-12-25', limit: ISSUE_LIMIT }, undefined),
      ],
    );
    assert.ok(gh.ran.every((request) => isIssueQuery(request.args)));
  });

  it('says when a list may be cut short, or held items it could not read', async () => {
    // One more open issue than the limit: the read stops at the limit with a page still on GitHub.
    const many = Array.from({ length: ISSUE_LIMIT + 1 }, (_, index) => ghIssue('acme/web', index + 1));
    const gh = new FakeGh().holds('acme/web', [...many, { ...ghIssue('acme/web', 900, { state: 'CLOSED' }), number: 'nine hundred' }]);
    const list = await hostWith(gh).list('acme/web', '2029-12-25');
    assert.deepEqual(list.kind === 'listed' && list.notes, [
      'the open list reached 500 issues, so it may leave some out',
      '1 closed item(s) gh printed did not read as issues and were left out',
    ]);
  });

  it('gives nothing of the repository when either read fails', async () => {
    assert.deepEqual(await hostWith(new FakeGh()).list('acme/nope', '2029-12-25'), {
      kind: 'failed',
      reason: 'acme/nope is not visible to the gh login: check github.repos, or save a read-only token for acme with: save teamrig-gh-acme',
    });
    const gh = new ClosedFails([ghIssue('acme/web', 7)]);
    assert.deepEqual(await hostWith(gh).list('acme/web', '2029-12-25'), {
      kind: 'failed',
      reason: 'gh api graphql for the issues of acme/web exited with code 1: HTTP 403: API rate limit exceeded',
    });
    assert.equal(gh.ran.length, 2);
  });
});

describe('GitHubIssueHost.open', () => {
  it("opens the issue through the allowlisted create, with the owner's token, and gives its number", async () => {
    const gh = new FakeGh().holds('acme/web', [ghIssue('acme/web', 7)]);
    assert.deepEqual(await hostWith(gh, new FakeCredentials().saves('teamrig-gh-acme', 'acme-issues-token')).open(DRAFT), { kind: 'opened', target: { repo: 'acme/web', number: 8 } });
    assert.ok(isIssueCreate(gh.ran[0]?.args ?? []));
    assert.equal(gh.ran[0]?.env['GH_TOKEN'], 'acme-issues-token');
  });

  it('says to look before a rerun when gh may have opened it, and redacts a secret shape in gh error text', async () => {
    const look = "look for it on acme/web before a rerun, and set the task's ref if it is there";
    const stopped = new FakeGh().failsCreate('acme/web', { end: { kind: 'signal', signal: 'SIGTERM' }, stdout: '', stderr: '' });
    assert.deepEqual(await hostWith(stopped).open(DRAFT), { kind: 'failed', reason: `gh was stopped (SIGTERM) while opening the issue: ${look}` });
    const silent = new FakeGh().failsCreate('acme/web', { end: { kind: 'exited', code: 0 }, stdout: 'created', stderr: '' });
    assert.deepEqual(await hostWith(silent).open(DRAFT), { kind: 'failed', reason: `gh printed no issue number: ${look}` });
    const secret = ['tok', '_abcd1234'].join('');
    const odd = new FakeGh().failsCreate('acme/web', { end: { kind: 'exited', code: 1 }, stdout: '', stderr: `gh: unexpected ${secret}\n` });
    const end = await hostWith(odd).open(DRAFT);
    assert.ok(end.kind === 'failed' && !end.reason.includes(secret) && end.reason.startsWith('gh api for an issue of acme/web exited with code 1: gh: unexpected [redacted'));
    const absent = new FakeGh().failsWith(Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }));
    const notInstalled = await hostWith(absent).open(DRAFT);
    assert.ok(notInstalled.kind === 'failed' && notInstalled.reason.startsWith('gh, the GitHub CLI, is not installed'));
  });
});

describe('GitHubIssueHost', () => {
  it("comments and closes through the allowlisted calls, with the owner's token in gh's environment only", async () => {
    const gh = new FakeGh();
    const host = hostWith(gh, new FakeCredentials().saves('teamrig-gh-acme', 'acme-issues-token'));
    assert.deepEqual(await host.reach('acme/web', 'write'), { kind: 'reached', access: 'acme: writes with the token saved as teamrig-gh-acme', scope: 'acme' });
    assert.deepEqual(await host.comment(TARGET, 'Thanks'), { kind: 'done' });
    assert.deepEqual(await host.close(TARGET), { kind: 'done' });
    assert.deepEqual(gh.ran.map((request) => request.args), [
      ['api', 'repos/acme/web/issues/7/comments', '-X', 'POST', '-f', 'body=Thanks'],
      ['api', 'repos/acme/web/issues/7', '-X', 'PATCH', '-f', 'state=closed'],
    ]);
    assert.ok(isIssueComment(gh.ran[0]?.args ?? []) && isIssueClose(gh.ran[1]?.args ?? []));
    assert.deepEqual(gh.ran.map((request) => request.env['GH_TOKEN']), ['acme-issues-token', 'acme-issues-token']);
  });

  it('writes with the gh login when no token is saved, and says so', async () => {
    const gh = new FakeGh();
    const host = hostWith(gh);
    assert.deepEqual(await host.reach('acme/web', 'write'), { kind: 'reached', access: 'acme: writes with the gh login; no token saved as teamrig-gh-acme', scope: 'acme' });
    assert.deepEqual(await host.close(TARGET), { kind: 'done' });
    assert.equal(gh.ran[0]?.env['GH_TOKEN'], undefined);
  });

  it('reaches nothing and runs no gh when the store holds the key but cannot read it', async () => {
    const gh = new FakeGh();
    const host = hostWith(gh, new FakeCredentials().failsOn('teamrig-gh-acme', 'the keyring is locked'));
    const reason = 'could not read teamrig-gh-acme from the test store: the keyring is locked; unlock the store and rerun, or save the key again with: save teamrig-gh-acme';
    assert.deepEqual(await host.reach('acme/web', 'read'), { kind: 'unreachable', reason });
    assert.deepEqual(await host.list('acme/web', '2029-12-25'), { kind: 'failed', reason });
    assert.deepEqual(await host.open(DRAFT), { kind: 'failed', reason });
    assert.deepEqual(await host.comment(TARGET, 'Thanks'), { kind: 'failed', reason });
    assert.deepEqual(await host.close(TARGET), { kind: 'failed', reason });
    assert.deepEqual(gh.ran, []);
  });

  it('says how to fix a token that may not write, and redacts a secret shape in gh error text', async () => {
    const denied = new FakeGh().failsWrite({ end: { kind: 'exited', code: 1 }, stdout: '', stderr: 'gh: Resource not accessible by personal access token (HTTP 403)\n' });
    assert.deepEqual(await hostWith(denied, new FakeCredentials().saves('teamrig-gh-acme', 'k')).close(TARGET), {
      kind: 'failed',
      reason: 'the token saved as teamrig-gh-acme may not close acme/web#7: on GitHub, edit that token and set Issues and Pull requests to Read and write; its text stays the same, so nothing needs saving again',
    });
    const secret = ['tok', '_abcd1234'].join('');
    const odd = new FakeGh().failsWrite({ end: { kind: 'exited', code: 1 }, stdout: '', stderr: `gh: unexpected ${secret}\n` });
    const end = await hostWith(odd).comment(TARGET, 'Thanks');
    assert.equal(end.kind, 'failed');
    assert.ok(end.kind === 'failed' && !end.reason.includes(secret) && end.reason.startsWith('gh api to comment on acme/web#7 exited with code 1: gh: unexpected [redacted'));
  });

  it('names an issue not there, a gh that could not start, and one stopped by a signal', async () => {
    const missing = new FakeGh().failsWrite({ end: { kind: 'exited', code: 1 }, stdout: '', stderr: 'gh: Not Found (HTTP 404)\n' });
    assert.deepEqual(await hostWith(missing).close(TARGET), { kind: 'failed', reason: 'acme/web#7 is not there for the gh login: check the number, and that the token reaches acme/web' });
    const absent = new FakeGh().failsWith(Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }));
    const notInstalled = await hostWith(absent).close(TARGET);
    assert.ok(notInstalled.kind === 'failed' && notInstalled.reason.startsWith('gh, the GitHub CLI, is not installed'));
    const stopped = new FakeGh().failsWrite({ end: { kind: 'signal', signal: 'SIGTERM' }, stdout: '', stderr: '' });
    assert.deepEqual(await hostWith(stopped).comment(TARGET, 'Thanks'), { kind: 'failed', reason: 'gh was stopped (SIGTERM) on its way to comment on acme/web#7: look on GitHub before a rerun' });
  });
});
