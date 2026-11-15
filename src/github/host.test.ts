import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SecretScanner } from '../core/secrets.ts';
import { FakeCredentials } from '../testing/fake-credentials.ts';
import type { JsonRecord } from '../core/guards.ts';
import type { IssueDraft } from '../issues/host.ts';
import { FakeGh, ghIssue } from '../testing/fake-gh.ts';
import {
  isAssigneeRead,
  isIssueAssign,
  isIssueBodyEdit,
  isIssueClose,
  isIssueComment,
  isIssueCreate,
  isIssueQuery,
  isIssueRead,
  isLabelAdd,
  isLabelRead,
  isLabelRemove,
  isLinkAdd,
  isWatchProbe,
  type GhRequest,
  type GhResult,
  type GhRunner,
} from './gh.ts';
import { GitHubIssueHost, issueIdIn } from './host.ts';
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

  it("replaces a body through the allowlisted call, with the owner's token, and says a refused one in plain words", async () => {
    const gh = new FakeGh();
    const host = hostWith(gh, new FakeCredentials().saves('teamrig-gh-acme', 'acme-issues-token'));
    assert.deepEqual(await host.editBody(TARGET, '## Spec\n\nStep one: $(x) @file'), { kind: 'done' });
    assert.deepEqual(gh.ran.map((request) => request.args), [['api', 'repos/acme/web/issues/7', '-X', 'PATCH', '-f', 'body=## Spec\n\nStep one: $(x) @file']]);
    assert.ok(isIssueBodyEdit(gh.ran[0]?.args ?? []));
    assert.deepEqual(gh.ran.map((request) => request.env['GH_TOKEN']), ['acme-issues-token']);
    const denied = new FakeGh().failsWrite({ end: { kind: 'exited', code: 1 }, stdout: '', stderr: 'gh: Resource not accessible by personal access token (HTTP 403)\n' });
    const end = await hostWith(denied, new FakeCredentials().saves('teamrig-gh-acme', 'k')).editBody(TARGET, 'b');
    assert.ok(end.kind === 'failed' && end.reason.startsWith('the token saved as teamrig-gh-acme may not edit the body of acme/web#7'), JSON.stringify(end));
  });

  it("closes with a reason and adds and takes off labels through the allowlisted calls, with the owner's token", async () => {
    const gh = new FakeGh();
    const host = hostWith(gh, new FakeCredentials().saves('teamrig-gh-acme', 'acme-issues-token'));
    assert.deepEqual(await host.close(TARGET, 'duplicate'), { kind: 'done' });
    assert.deepEqual(await host.addLabels(TARGET, ['type: bug', 'p1']), { kind: 'done' });
    assert.deepEqual(await host.removeLabel(TARGET, 'needs triage'), { kind: 'done' });
    assert.deepEqual(gh.ran.map((request) => request.args), [
      ['api', 'repos/acme/web/issues/7', '-X', 'PATCH', '-f', 'state=closed', '-f', 'state_reason=duplicate'],
      ['api', 'repos/acme/web/issues/7/labels', '-X', 'POST', '-f', 'labels[]=type: bug', '-f', 'labels[]=p1'],
      ['api', 'repos/acme/web/issues/7/labels/needs%20triage', '-X', 'DELETE'],
    ]);
    const [close, add, remove] = gh.ran.map((request) => request.args);
    assert.ok(isIssueClose(close ?? []) && isLabelAdd(add ?? []) && isLabelRemove(remove ?? []));
    assert.deepEqual(gh.ran.map((request) => request.env['GH_TOKEN']), ['acme-issues-token', 'acme-issues-token', 'acme-issues-token']);
  });

  it("reads whether the repository has a label: found, missing on Not Found, else failed with gh's line", async () => {
    const gh = new FakeGh().hasLabels('acme/web', ['type: bug']);
    const host = hostWith(gh);
    assert.deepEqual(await host.labelExists('acme/web', 'type: bug'), { kind: 'found' });
    assert.deepEqual(await host.labelExists('acme/web', 'typo'), { kind: 'missing' });
    assert.deepEqual(gh.ran.map((request) => request.args), [['api', 'repos/acme/web/labels/type%3A%20bug'], ['api', 'repos/acme/web/labels/typo']]);
    assert.ok(gh.ran.every((request) => isLabelRead(request.args)));
    const secret = ['tok', '_abcd1234'].join('');
    const odd = await hostWith(new FakeGh().answers('acme/web', { end: { kind: 'exited', code: 1 }, stdout: '', stderr: `gh: HTTP 502 ${secret}\n` })).labelExists('acme/web', 'p1');
    assert.ok(odd.kind === 'failed' && !odd.reason.includes(secret) && odd.reason.startsWith('gh api to read the label "p1" of acme/web exited with code 1: gh: HTTP 502 [redacted'), JSON.stringify(odd));
  });

  it("reads an issue's id: found, missing on Not Found, else failed with gh's line redacted, or with no id printed", async () => {
    const gh = new FakeGh().holds('acme/web', [ghIssue('acme/web', 7)]);
    const host = hostWith(gh);
    assert.deepEqual(await host.issueId(TARGET), { kind: 'found', id: 1007 });
    assert.deepEqual(await host.issueId({ repo: 'acme/web', number: 8 }), { kind: 'missing' });
    assert.deepEqual(gh.ran.map((request) => request.args), [['api', 'repos/acme/web/issues/7', '-X', 'GET'], ['api', 'repos/acme/web/issues/8', '-X', 'GET']]);
    assert.ok(gh.ran.every((request) => isIssueRead(request.args)));
    const secret = ['tok', '_abcd1234'].join('');
    const odd = await hostWith(new FakeGh().answers('acme/web', { end: { kind: 'exited', code: 1 }, stdout: '', stderr: `gh: HTTP 502 ${secret}\n` })).issueId(TARGET);
    assert.ok(odd.kind === 'failed' && !odd.reason.includes(secret) && odd.reason.startsWith('gh api to read acme/web#7 exited with code 1: gh: HTTP 502 [redacted'), JSON.stringify(odd));
    const blank = new FakeGh().answers('acme/web', { end: { kind: 'exited', code: 0 }, stdout: '{"number":7}', stderr: '' });
    assert.deepEqual(await hostWith(blank).issueId(TARGET), { kind: 'failed', reason: 'gh printed no id for acme/web#7' });
    const stopped = new FakeGh().answers('acme/web', { end: { kind: 'signal', signal: 'SIGTERM' }, stdout: '', stderr: '' });
    assert.deepEqual(await hostWith(stopped).issueId(TARGET), { kind: 'failed', reason: 'gh was stopped (SIGTERM) while reading acme/web#7' });
    const absent = new FakeGh().failsWith(Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }));
    const notInstalled = await hostWith(absent).issueId(TARGET);
    assert.ok(notInstalled.kind === 'failed' && notInstalled.reason.startsWith('gh, the GitHub CLI, is not installed'));
    const lockedGh = new FakeGh();
    const locked = await hostWith(lockedGh, new FakeCredentials().failsOn('teamrig-gh-acme', 'the keyring is locked')).issueId(TARGET);
    assert.equal(locked.kind, 'failed');
    assert.deepEqual(lockedGh.ran, []);
  });

  it('takes as an id only a positive whole number in the printed issue', () => {
    assert.equal(issueIdIn('{"id":4242,"number":7}'), 4242);
    for (const stdout of ['', 'not json', 'null', '[]', '7', '{"number":7}', '{"id":"4242"}', '{"id":0}', '{"id":-3}', '{"id":1.5}', '{"id":1e300}']) {
      assert.equal(issueIdIn(stdout), undefined, stdout);
    }
  });

  it('reads whether a login may be assigned, found or missing on Not Found, and assigns through the allowlisted call (T2999)', async () => {
    const gh = new FakeGh().cannotAssign('acme/web', ['acme']);
    const host = hostWith(gh);
    assert.deepEqual(await host.assigneeExists('acme/web', 'octocat'), { kind: 'found' });
    assert.deepEqual(await host.assigneeExists('acme/web', 'acme'), { kind: 'missing' });
    assert.deepEqual(await host.assign(TARGET, ['octocat']), { kind: 'done' });
    const [found, missing, assign] = gh.ran.map((request) => request.args);
    assert.ok(isAssigneeRead(found ?? []) && isAssigneeRead(missing ?? []) && isIssueAssign(assign ?? []));
    const stopped = new FakeGh().answers('acme/web', { end: { kind: 'signal', signal: 'SIGTERM' }, stdout: '', stderr: '' });
    assert.deepEqual(await hostWith(stopped).assigneeExists('acme/web', 'octocat'), { kind: 'failed', reason: 'gh was stopped (SIGTERM) while reading whether octocat may be assigned in acme/web' });
  });

  it('names a label read that gh could not start, was stopped, or had no key to run with', async () => {
    const absent = new FakeGh().failsWith(Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }));
    const notInstalled = await hostWith(absent).labelExists('acme/web', 'p1');
    assert.ok(notInstalled.kind === 'failed' && notInstalled.reason.startsWith('gh, the GitHub CLI, is not installed'));
    const stopped = new FakeGh().answers('acme/web', { end: { kind: 'signal', signal: 'SIGTERM' }, stdout: '', stderr: '' });
    assert.deepEqual(await hostWith(stopped).labelExists('acme/web', 'p1'), { kind: 'failed', reason: 'gh was stopped (SIGTERM) while reading the label "p1" of acme/web' });
    const locked = hostWith(new FakeGh(), new FakeCredentials().failsOn('teamrig-gh-acme', 'the keyring is locked'));
    assert.match((await locked.labelExists('acme/web', 'p1')).kind, /^failed$/u);
  });

  it('says a label taken off is not on the issue when GitHub answers Not Found, and the usual fix for a refused token', async () => {
    const missing = new FakeGh().failsWrite({ end: { kind: 'exited', code: 1 }, stdout: '', stderr: 'gh: Label does not exist (HTTP 404)\n' });
    assert.deepEqual(await hostWith(missing).removeLabel(TARGET, 'p1'), { kind: 'failed', reason: 'acme/web#7 does not carry the label "p1", or is not there' });
    const denied = new FakeGh().failsWrite({ end: { kind: 'exited', code: 1 }, stdout: '', stderr: 'gh: Resource not accessible by personal access token (HTTP 403)\n' });
    const end = await hostWith(denied, new FakeCredentials().saves('teamrig-gh-acme', 'k')).addLabels(TARGET, ['p1']);
    assert.ok(end.kind === 'failed' && end.reason.startsWith('the token saved as teamrig-gh-acme may not label acme/web#7'), JSON.stringify(end));
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
    assert.deepEqual(await host.watch('acme/web', new Map()), { kind: 'failed', reason });
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

describe('GitHubIssueHost links', () => {
  it("adds a sub-issue and a blocker through the allowlisted calls with the owner's token, and a links read then has them", async () => {
    const gh = new FakeGh().holds('acme/web', [ghIssue('acme/web', 7), ghIssue('acme/web', 8, { hostId: 6375244885 }), ghIssue('acme/web', 9)]);
    const host = hostWith(gh, new FakeCredentials().saves('teamrig-gh-acme', 'acme-issues-token'));
    assert.deepEqual(await host.addSubIssue(TARGET, 6375244885), { kind: 'done' });
    assert.deepEqual(await host.addBlockedBy(TARGET, 1009), { kind: 'done' });
    assert.deepEqual(gh.ran.map((request) => request.args), [
      ['api', 'repos/acme/web/issues/7/sub_issues', '-X', 'POST', '-F', 'sub_issue_id=6375244885'],
      ['api', 'repos/acme/web/issues/7/dependencies/blocked_by', '-X', 'POST', '-F', 'issue_id=1009'],
    ]);
    assert.ok(gh.ran.every((request) => isLinkAdd(request.args) && request.env['GH_TOKEN'] === 'acme-issues-token'));
    const links = await host.links('acme/web');
    assert.deepEqual(links.kind === 'listed' && links.issues, [
      { number: 7, hostId: 1007, parent: undefined, blockedBy: [9] },
      { number: 8, hostId: 6375244885, parent: { repo: 'acme/web', number: 7 }, blockedBy: [] },
      { number: 9, hostId: 1009, parent: undefined, blockedBy: [] },
    ]);
    assert.ok(isIssueQuery(gh.ran[2]?.args ?? []) && gh.ran[2]?.env['GH_TOKEN'] === 'acme-issues-token');
  });

  it('names the link a refusal was for: one GitHub has already, or one the token may not add', async () => {
    const gh = new FakeGh().holds('acme/web', [ghIssue('acme/web', 7, { blockedBy: [{ repo: 'acme/web', number: 9 }] }), ghIssue('acme/web', 9)]);
    assert.deepEqual(await hostWith(gh).addBlockedBy(TARGET, 1009), { kind: 'failed', reason: 'gh api to add a blocker to acme/web#7 exited with code 1: gh: Validation Failed (HTTP 422)' });
    const denied = new FakeGh().failsWrite({ end: { kind: 'exited', code: 1 }, stdout: '', stderr: 'gh: Resource not accessible by personal access token (HTTP 403)\n' });
    assert.deepEqual(await hostWith(denied).addSubIssue(TARGET, 1008), {
      kind: 'failed',
      reason: 'the gh login may not add a sub-issue to acme/web#7: save a token for acme with Issues and Pull requests read and write, with: save teamrig-gh-acme',
    });
  });

  it('reads and writes no link, and runs no gh, when the store holds the key but cannot read it', async () => {
    const gh = new FakeGh();
    const host = hostWith(gh, new FakeCredentials().failsOn('teamrig-gh-acme', 'the keyring is locked'));
    const reason = 'could not read teamrig-gh-acme from the test store: the keyring is locked; unlock the store and rerun, or save the key again with: save teamrig-gh-acme';
    assert.deepEqual(await host.links('acme/web'), { kind: 'failed', reason });
    assert.deepEqual(await host.addSubIssue(TARGET, 1008), { kind: 'failed', reason });
    assert.deepEqual(await host.addBlockedBy(TARGET, 1008), { kind: 'failed', reason });
    assert.deepEqual(gh.ran, []);
  });
});

describe('GitHubIssueHost.watch', () => {
  const ISSUES = 'issues?state=all&sort=updated&per_page=1';
  const RUNS = 'actions/runs?per_page=5';

  it('reads a repository with no marks as changed, then unchanged until GitHub moves, at no list read', async () => {
    const gh = new FakeGh().holds('acme/web', []);
    const host = hostWith(gh);
    const first = await host.watch('acme/web', new Map());
    assert.deepEqual(first, { kind: 'changed', marks: new Map([[ISSUES, 'W/"v1"'], [RUNS, 'W/"v1"']]) });
    assert.ok(first.kind === 'changed');
    assert.deepEqual(await host.watch('acme/web', first.marks), { kind: 'unchanged' });
    gh.changes('acme/web', RUNS);
    assert.deepEqual(await host.watch('acme/web', first.marks), { kind: 'changed', marks: new Map([[ISSUES, 'W/"v1"'], [RUNS, 'W/"v2"']]) });
    assert.deepEqual(gh.probes(), Array.from({ length: 3 }, () => [`acme/web/${ISSUES}`, `acme/web/${RUNS}`]).flat());
    assert.ok(gh.ran.every((request) => isWatchProbe(request.args)));
  });

  it('sends each path its own tag, with the token the repository is read with', async () => {
    const gh = new FakeGh().holds('acme/web', []);
    await hostWith(gh, new FakeCredentials().saves('teamrig-gh-acme', 'k')).watch('acme/web', new Map([[ISSUES, 'W/"a"']]));
    assert.deepEqual(
      gh.ran.map((request) => request.args),
      [
        ['api', '-i', '-H', 'If-None-Match: W/"a"', `repos/acme/web/${ISSUES}`],
        ['api', '-i', `repos/acme/web/${RUNS}`],
      ],
    );
    assert.ok(gh.ran.every((request) => request.env['GH_TOKEN'] === 'k'));
  });

  it('fails only when nothing changed, naming the probe, a secret shape redacted', async () => {
    const secret = ['tok', '_abcd1234'].join('');
    const gh = new FakeGh().failsProbe('acme/web', { end: { kind: 'exited', code: 1 }, stdout: 'HTTP/2.0 403 Forbidden\r\n\r\n{}', stderr: `gh: denied ${secret}\n` });
    const failed = await hostWith(gh).watch('acme/web', new Map([[ISSUES, 'W/"v1"'], [RUNS, 'W/"v1"']]));
    assert.ok(failed.kind === 'failed' && failed.reason.startsWith('acme/web issues: GitHub answered HTTP 403: gh: denied [redacted') && !failed.reason.includes(secret));
    const absent = new FakeGh().failsWith(Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }));
    const notInstalled = await hostWith(absent).watch('acme/web', new Map());
    assert.ok(notInstalled.kind === 'failed' && notInstalled.reason.startsWith('acme/web issues: gh, the GitHub CLI, is not installed'));
  });

  it('reads one changed path as changed though the other failed, the failed one keeping its old tag', async () => {
    const runsFail: GhRunner = {
      run: async (request) =>
        request.args.at(-1)?.endsWith(RUNS) === true
          ? { end: { kind: 'exited', code: 1 }, stdout: 'HTTP/2.0 502 Bad Gateway\r\n\r\n', stderr: '' }
          : { end: { kind: 'exited', code: 0 }, stdout: 'HTTP/2.0 200 OK\r\nEtag: "n"\r\n\r\n[]', stderr: '' },
    };
    assert.deepEqual(await hostWith(runsFail).watch('acme/web', new Map([[ISSUES, '"o"'], [RUNS, '"r"']])), { kind: 'changed', marks: new Map([[ISSUES, '"n"'], [RUNS, '"r"']]) });
  });

  it('drops the mark of a path whose answer has no usable tag, so the next probe reads it whole', async () => {
    const untagged: GhRunner = { run: async () => ({ end: { kind: 'exited', code: 0 }, stdout: 'HTTP/2.0 200 OK\r\n\r\n[]', stderr: '' }) };
    assert.deepEqual(await hostWith(untagged).watch('acme/web', new Map([[ISSUES, '"o"']])), { kind: 'changed', marks: new Map() });
  });
});
