import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SecretScanner } from '../core/secrets.ts';
import { STAMP_MARKER, withStampFooter } from '../core/stamp.ts';
import { MAX_COMMENT } from '../issues/write.ts';
import { FakeCredentials, TEST_OWNERS } from '../testing/fake-credentials.ts';
import type { JsonRecord } from '../core/guards.ts';
import type { IssueDraft } from '../issues/host.ts';
import { STATUS_LABEL_SPECS } from '../issues/status-push.ts';
import { commentNode, FakeGh, ghIssue, ghPull, restComment } from '../testing/fake-gh.ts';
import type { HostPull } from '../issues/pull.ts';
import {
  assigneeReadArgs,
  isAssigneeRead,
  isCommentsRead,
  isIssueAssign,
  isIssueBodyEdit,
  isIssueClose,
  isIssueComment,
  isIssueCreate,
  isIssueQuery,
  isIssueRead,
  isIssueUnassign,
  isLabelAdd,
  isFileLabelCreate,
  isLabelCreate,
  isLabelFileRead,
  isLabelRead,
  isLabelRemove,
  isFieldValueSet,
  isIssueTypeSet,
  isLinkAdd,
  isWatchProbe,
  isUserRead,
  LabelFileReads,
  labelCreateArgs,
  userReadArgs,
  type GhRequest,
  type GhResult,
  type GhRunner,
} from './gh.ts';
import { GitHubIssueHost, issueIdIn, loginIn } from './host.ts';
import { ISSUE_LIMIT, issuePageArgs } from './issues.ts';
import { CLOSED_ISSUES_QUERY, PULL_PAGE_SIZE } from './queries.ts';
import { PULL_LIMIT } from './pulls.ts';
import { RepoTokens } from './tokens.ts';

const ENV = { HOME: '/u' };
const TARGET = { repo: 'acme/web', number: 7 };
const DRAFT: IssueDraft = { repo: 'acme/web', title: 'Fix login', body: 'Steps', labels: ['bug'] };

function hostWith(
  gh: GhRunner,
  credentials: FakeCredentials = new FakeCredentials().savesTokensFor(TEST_OWNERS),
  stamp = true,
): GitHubIssueHost {
  return new GitHubIssueHost(gh, new RepoTokens(credentials, ENV), new SecretScanner(['tok_[a-z0-9]{8}']), stamp);
}

/** The `body=` field of a command line, or undefined when it has none. */
function bodyOf(args: readonly string[] | undefined): string | undefined {
  return args?.find((arg) => arg.startsWith('body='))?.slice('body='.length);
}

/** How many footers `text` carries. */
function stamps(text: string | undefined): number {
  return (text ?? '').split(STAMP_MARKER).length - 1;
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
      reason: 'acme/nope is not visible to the token saved as teamrig-gh-acme: check github.repos, and on GitHub give that token this repository',
    });
    const gh = new ClosedFails([ghIssue('acme/web', 7)]);
    assert.deepEqual(await hostWith(gh).list('acme/web', '2029-12-25'), {
      kind: 'failed',
      reason: 'gh api graphql for the issues of acme/web exited with code 1: HTTP 403: API rate limit exceeded',
    });
    assert.equal(gh.ran.length, 2);
  });
});

describe('GitHubIssueHost.pulls', () => {
  it('reads every open pull request, then those changed since the time, through the shipped queries with the saved token', async () => {
    const gh = new FakeGh().holdsPulls('acme/web', [
      ghPull('acme/web', 1, { updatedAt: '2030-01-01T00:00:00Z' }),
      ghPull('acme/web', 2, { updatedAt: '2030-01-03T00:00:00Z', state: 'MERGED' }),
      ghPull('acme/web', 3, { updatedAt: '2030-01-04T00:00:00Z' }),
    ]);
    const read = await hostWith(gh, new FakeCredentials().saves('teamrig-gh-acme', 'tok_abcdefgh')).pulls('acme/web', '2030-01-02T00:00:00Z');
    const numbers = (pulls: readonly HostPull[]): number[] => pulls.map((pull) => pull.number);
    assert.deepEqual(read.kind === 'listed' && [numbers(read.open), numbers(read.changed), read.notes], [[3, 1], [3, 2], []]);
    assert.ok(gh.ran.every((request) => isIssueQuery(request.args) && request.env['GH_TOKEN'] === 'tok_abcdefgh'));
  });

  it('says when the read may be cut short, or held items it could not read', async () => {
    const many = Array.from({ length: PULL_LIMIT + 1 }, (_, index) => ghPull('acme/web', index + 1));
    const first = await hostWith(new FakeGh().holdsPulls('acme/web', many)).pulls('acme/web', undefined);
    assert.deepEqual(first.kind === 'listed' && [first.open.length, first.changed.length, first.notes], [PULL_LIMIT, PULL_PAGE_SIZE, ['the open pull request read reached 200, so it may leave some out']]);
    const later = await hostWith(new FakeGh().holdsPulls('acme/web', many)).pulls('acme/web', '2029-12-31T00:00:00Z');
    assert.deepEqual(later.kind === 'listed' && later.notes, ['the open pull request read reached 200, so it may leave some out', 'the changed pull request read reached 200, so it may leave some out']);
    const odd = await hostWith(new FakeGh().holdsPulls('acme/web', [{ ...ghPull('acme/web', 900), state: 'DRAFTED' }])).pulls('acme/web', undefined);
    assert.deepEqual(odd.kind === 'listed' && odd.notes, ['1 item(s) gh printed did not read as pull requests and were left out']);
  });

  it('gives the one line when the read fails', async () => {
    assert.deepEqual(await hostWith(new FakeGh()).pulls('acme/nope', undefined), {
      kind: 'failed',
      reason: 'acme/nope is not visible to the token saved as teamrig-gh-acme: check github.repos, and on GitHub give that token this repository',
    });
  });
});

describe('GitHubIssueHost.jobLog', () => {
  it("reads the failed job's log with the saved token and gives its excerpt, a secret shape redacted", async () => {
    const stdout = ['check\tRun tests\t2030-01-01T00:00:00.0000000Z not ok 1 - reads', 'check\tRun tests\t2030-01-01T00:00:01.0000000Z token tok_abcdefgh leaked'].join('\n');
    const gh = new FakeGh().holdsJobLog(41, stdout);
    const log = await hostWith(gh, new FakeCredentials().saves('teamrig-gh-acme', 'tok_zzzzzzzz')).jobLog('acme/web', 41);
    assert.deepEqual(log, { kind: 'read', step: 'Run tests', lines: ['not ok 1 - reads', 'token [redacted secret pattern from the team config] leaked'] });
    assert.deepEqual(
      gh.ran.map((request) => [request.args, request.env['GH_TOKEN']]),
      [[['run', 'view', '--job', '41', '--log-failed', '--repo', 'acme/web'], 'tok_zzzzzzzz']],
    );
  });

  it('gives the one line, naming the Actions permission, when the read fails', async () => {
    const forbidden: GhResult = { end: { kind: 'exited', code: 1 }, stdout: '', stderr: 'HTTP 403: Resource not accessible by personal access token\n' };
    const log = await hostWith(new FakeGh().answers('acme/web', forbidden), new FakeCredentials().saves('teamrig-gh-acme', 'k')).jobLog('acme/web', 41);
    assert.equal(log.kind === 'failed' && log.reason.includes('may not read the failed job logs of acme/web') && log.reason.includes('set Actions to Read-only'), true, JSON.stringify(log));
    const odd: GhResult = { end: { kind: 'exited', code: 2 }, stdout: '', stderr: 'boom tok_abcdefgh\n' };
    const failed = await hostWith(new FakeGh().answers('acme/web', odd)).jobLog('acme/web', 41);
    assert.deepEqual(failed.kind === 'failed' && failed.reason.startsWith('gh run view for the failed job logs of acme/web') && !failed.reason.includes('tok_abcdefgh'), true, JSON.stringify(failed));
  });
});

describe('GitHubIssueHost.posts', () => {
  it('reads the posts with the saved token and says how many items it left out', async () => {
    const gh = new FakeGh().holdsPosts('acme/web', 'issues/comments', [restComment('acme/web', 3, 11, { body: 'hi @octocat' }), { id: 12, updated_at: '2030-01-10T00:00:00Z' }]);
    const read = await hostWith(gh, new FakeCredentials().saves('teamrig-gh-acme', 'tok_zzzzzzzz')).posts('acme/web', '2030-01-01T00:00:00Z');
    assert.deepEqual(read.kind === 'read' ? [read.posts.map((post) => post.key), read.cutAt, read.notes] : read, [
      ['comment:11'],
      undefined,
      ['1 item(s) gh printed did not read as comments, reviews or bodies and were left out'],
    ]);
    assert.ok(gh.ran.every((request) => request.env['GH_TOKEN'] === 'tok_zzzzzzzz'));
  });

  it('gives the one line, naming the Issues permission, a secret shape redacted, when a read fails', async () => {
    const forbidden: GhResult = { end: { kind: 'exited', code: 1 }, stdout: '', stderr: 'HTTP 403: Resource not accessible by personal access token\n' };
    const read = await hostWith(new FakeGh().answers('acme/web', forbidden), new FakeCredentials().saves('teamrig-gh-acme', 'k')).posts('acme/web', '2030-01-01T00:00:00Z');
    assert.equal(read.kind === 'failed' && read.reason.includes('may not read the issue comments of acme/web') && read.reason.includes('set Issues to Read-only'), true, JSON.stringify(read));
    const odd: GhResult = { end: { kind: 'exited', code: 2 }, stdout: '', stderr: 'boom tok_abcdefgh\n' };
    const failed = await hostWith(new FakeGh().answers('acme/web', odd)).posts('acme/web', '2030-01-01T00:00:00Z');
    assert.equal(failed.kind === 'failed' && !failed.reason.includes('tok_abcdefgh'), true, JSON.stringify(failed));
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

describe('GitHubIssueHost stamp', () => {
  it('ends an opened issue, a comment and a replaced body with one made-with-teamrig footer (#1102)', async () => {
    const gh = new FakeGh().holds('acme/web', [ghIssue('acme/web', 7)]);
    const host = hostWith(gh);
    await host.open(DRAFT);
    await host.comment(TARGET, 'Thanks');
    await host.editBody(TARGET, 'Spec');
    assert.deepEqual(gh.ran.map((request) => bodyOf(request.args)), [withStampFooter('Steps'), withStampFooter('Thanks'), withStampFooter('Spec')]);
    assert.ok(isIssueCreate(gh.ran[0]?.args ?? []) && isIssueComment(gh.ran[1]?.args ?? []) && isIssueBodyEdit(gh.ran[2]?.args ?? []));
  });

  it('keeps one footer when a stamped text is posted again: a rerun, or a body read back and edited', async () => {
    const gh = new FakeGh();
    const host = hostWith(gh);
    await host.comment(TARGET, withStampFooter('Thanks'));
    await host.editBody(TARGET, `${withStampFooter('Spec', '0.1.0')}\n\nOne more step.`);
    assert.deepEqual(gh.ran.map((request) => stamps(bodyOf(request.args))), [1, 1]);
    assert.equal(bodyOf(gh.ran[1]?.args), withStampFooter('Spec\n\nOne more step.'));
  });

  it('posts the text as given when the stamp is off, or when the footer would take it past what GitHub holds', async () => {
    const off = new FakeGh();
    assert.deepEqual(await hostWith(off, new FakeCredentials().savesTokensFor(TEST_OWNERS), false).comment(TARGET, 'Thanks'), { kind: 'done' });
    assert.equal(bodyOf(off.ran[0]?.args), 'Thanks');
    const full = new FakeGh();
    const long = 'x'.repeat(MAX_COMMENT - 10);
    await hostWith(full).comment(TARGET, long);
    assert.equal(bodyOf(full.ran[0]?.args), long);
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
      ['api', 'repos/acme/web/issues/7/comments', '-X', 'POST', '-f', `body=${withStampFooter('Thanks')}`],
      ['api', 'repos/acme/web/issues/7', '-X', 'PATCH', '-f', 'state=closed'],
    ]);
    assert.ok(isIssueComment(gh.ran[0]?.args ?? []) && isIssueClose(gh.ran[1]?.args ?? []));
    assert.deepEqual(gh.ran.map((request) => request.env['GH_TOKEN']), ['acme-issues-token', 'acme-issues-token']);
  });

  it("replaces a body through the allowlisted call, with the owner's token, and says a refused one in plain words", async () => {
    const gh = new FakeGh();
    const host = hostWith(gh, new FakeCredentials().saves('teamrig-gh-acme', 'acme-issues-token'));
    assert.deepEqual(await host.editBody(TARGET, '## Spec\n\nStep one: $(x) @file'), { kind: 'done' });
    assert.deepEqual(gh.ran.map((request) => request.args), [['api', 'repos/acme/web/issues/7', '-X', 'PATCH', '-f', `body=${withStampFooter('## Spec\n\nStep one: $(x) @file')}`]]);
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

  it("reads an issue's comments since a time with their claim match, and fails on an issue GitHub does not show", async () => {
    const comments = [
      commentNode('2030-01-01T09:00:00Z', 'NONE', 'User', { login: 'old', body: '/take' }),
      commentNode('2030-01-01T11:00:00Z', 'NONE', 'User', { login: 'ada', body: '/take' }),
      commentNode('2030-01-01T10:00:00Z', 'MEMBER', 'User', { login: 'maintainer', body: 'Thanks.' }),
    ];
    const gh = new FakeGh().holds('acme/web', [ghIssue('acme/web', 7, { comments })]);
    const host = hostWith(gh);
    assert.deepEqual(await host.newComments(TARGET, Date.parse('2030-01-01T10:00:00Z')), {
      kind: 'read',
      comments: [
        { at: '2030-01-01T10:00:00Z', login: 'maintainer', authorAssociation: 'MEMBER', authorKind: 'User', claims: false },
        { at: '2030-01-01T11:00:00Z', login: 'ada', authorAssociation: 'NONE', authorKind: 'User', claims: true },
      ],
    });
    assert.ok(gh.ran.every((request) => isCommentsRead(request.args)));
    const gone = await host.newComments({ repo: 'acme/web', number: 8 }, 0);
    assert.ok(gone.kind === 'failed' && gone.reason.includes('acme/web#8'), JSON.stringify(gone));
    const odd = await hostWith(new FakeGh().answers('acme/web', { end: { kind: 'exited', code: 0 }, stdout: '{}', stderr: '' })).newComments(TARGET, 0);
    assert.deepEqual(odd, { kind: 'failed', reason: 'gh printed no comment list for the new comments of acme/web#7' });
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

  it('makes a status label through the allowlisted create, after which the label reads found (T2999)', async () => {
    const [label] = STATUS_LABEL_SPECS;
    assert.ok(label !== undefined);
    const gh = new FakeGh();
    const host = hostWith(gh);
    assert.deepEqual(await host.labelExists('acme/web', label.name), { kind: 'missing' });
    assert.deepEqual(await host.createLabel('acme/web', label), { kind: 'done' });
    assert.deepEqual(await host.labelExists('acme/web', label.name), { kind: 'found' });
    assert.ok(isLabelCreate(gh.ran[1]?.args ?? []));
  });

  it("reads the repository's label file raw, then makes a label it names through the runner's file-label create (T3198)", async () => {
    const area = { name: 'area:cli', color: '1d76db', description: 'Area: the command line' };
    const gh = new FakeGh().holdsLabelFile('acme/web', JSON.stringify({ labels: [area] }));
    const host = hostWith(gh);
    assert.deepEqual(await host.labelFile('acme/web'), { kind: 'read', labels: [area] });
    assert.deepEqual(await host.createLabel('acme/web', area), { kind: 'done' });
    assert.deepEqual(await host.labelExists('acme/web', area.name), { kind: 'found' });
    assert.ok(isLabelFileRead(gh.ran[0]?.args ?? []));
    const reads = new LabelFileReads();
    reads.note(gh.ran[0]?.args ?? [], { end: { kind: 'exited', code: 0 }, stdout: JSON.stringify({ labels: [area] }), stderr: '' });
    assert.ok(isFileLabelCreate(gh.ran[1]?.args ?? [], reads.of) && !isLabelCreate(gh.ran[1]?.args ?? []));
    assert.deepEqual(gh.ran[1]?.args, labelCreateArgs('acme/web', area));
  });

  it('gives no label file as missing on Not Found, and a malformed one or a refused read as failed', async () => {
    assert.deepEqual(await hostWith(new FakeGh()).labelFile('acme/web'), { kind: 'missing' });
    const broken = await hostWith(new FakeGh().holdsLabelFile('acme/web', '{"labels":[{"name":"x"}]}')).labelFile('acme/web');
    assert.ok(broken.kind === 'failed' && broken.reason.startsWith('the .github/labels.json of acme/web does not parse: labels.json: each label needs'), JSON.stringify(broken));
    const junk = await hostWith(new FakeGh().holdsLabelFile('acme/web', 'not json')).labelFile('acme/web');
    assert.ok(junk.kind === 'failed' && junk.reason.startsWith('the .github/labels.json of acme/web does not parse: '), JSON.stringify(junk));
    const refused = await hostWith(new FakeGh().answers('acme/web', { end: { kind: 'exited', code: 1 }, stdout: '', stderr: 'gh: HTTP 502\n' })).labelFile('acme/web');
    assert.ok(refused.kind === 'failed' && refused.reason.startsWith('gh api to read .github/labels.json of acme/web exited with code 1'), JSON.stringify(refused));
  });

  it('gives gh\'s own line when the create fails', async () => {
    const [label] = STATUS_LABEL_SPECS;
    assert.ok(label !== undefined);
    const gh = new FakeGh().failsWrite({ end: { kind: 'exited', code: 1 }, stdout: '', stderr: 'gh: Validation Failed (HTTP 422)\n' });
    const made = await hostWith(gh).createLabel('acme/web', label);
    assert.equal(made.kind, 'failed');
    assert.match(made.kind === 'failed' ? made.reason : '', /^gh api to make the label "status:open" in acme\/web .*HTTP 422/u);
  });

  it('reads whether a login may be assigned, found or missing on Not Found, and assigns through the allowlisted call (T2999)', async () => {
    const gh = new FakeGh().cannotAssign('acme/web', ['acme']);
    const host = hostWith(gh);
    assert.deepEqual(await host.assigneeExists('acme/web', 'octocat'), { kind: 'found', login: 'octocat' });
    assert.deepEqual(await host.assigneeExists('acme/web', 'acme'), { kind: 'missing' });
    assert.deepEqual(await host.assign(TARGET, ['octocat']), { kind: 'done' });
    assert.deepEqual(await host.unassign(TARGET, 'octocat'), { kind: 'done' });
    const [user, found, acme, missing, assign, unassign] = gh.ran.map((request) => request.args);
    assert.ok(isUserRead(user ?? []) && isUserRead(acme ?? []) && isAssigneeRead(found ?? []) && isAssigneeRead(missing ?? []) && isIssueAssign(assign ?? []));
    assert.ok(isIssueUnassign(unassign ?? []));
    const stopped = new FakeGh().answers('acme/web', { end: { kind: 'signal', signal: 'SIGTERM' }, stdout: '', stderr: '' });
    assert.deepEqual(await hostWith(stopped).assigneeExists('acme/web', 'octocat'), { kind: 'failed', reason: 'gh was stopped (SIGTERM) while reading whether octocat may be assigned in acme/web' });
  });

  it('reads a login in the case GitHub spells it, so the case-exact assignee check finds it (T2999)', async () => {
    const gh = new FakeGh().spells('OctoCat');
    assert.deepEqual(await hostWith(gh).assigneeExists('acme/web', 'octocat'), { kind: 'found', login: 'OctoCat' });
    assert.deepEqual(gh.ran.map((request) => request.args), [userReadArgs('octocat'), assigneeReadArgs('acme/web', 'OctoCat')]);
  });

  it('gives missing for no such user and failed for a user read naming another login, reading no assignee', async () => {
    const absent = new FakeGh().answersUserRead({ end: { kind: 'exited', code: 1 }, stdout: '', stderr: 'gh: Not Found (HTTP 404)\n' });
    assert.deepEqual(await hostWith(absent).assigneeExists('acme/web', 'ghost'), { kind: 'missing' });
    assert.equal(absent.ran.length, 1);
    const other = new FakeGh().answersUserRead({ end: { kind: 'exited', code: 0 }, stdout: '{"login":"mallory"}', stderr: '' });
    assert.deepEqual(await hostWith(other).assigneeExists('acme/web', 'octocat'), { kind: 'failed', reason: 'gh printed no login octocat for the GitHub user octocat' });
    assert.equal(other.ran.length, 1);
  });

  it("takes as a login only a string of a login's shape in the printed user", () => {
    assert.equal(loginIn('{"login":"OctoCat","type":"User"}'), 'OctoCat');
    for (const stdout of ['', 'not json', 'null', '[]', '{}', '{"login":7}', '{"login":"-x"}', '{"login":"a b"}']) {
      assert.equal(loginIn(stdout), undefined, stdout);
    }
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

  it('writes with the saved token and says so, and with no token saved reaches nothing, running no gh, never the gh login', async () => {
    const gh = new FakeGh();
    const host = hostWith(gh);
    assert.deepEqual(await host.reach('acme/web', 'write'), { kind: 'reached', access: 'acme: writes with the token saved as teamrig-gh-acme', scope: 'acme' });
    assert.deepEqual(await host.close(TARGET), { kind: 'done' });
    assert.equal(gh.ran[0]?.env['GH_TOKEN'], 'acme-token');
    const none = new FakeGh();
    const keyless = hostWith(none, new FakeCredentials());
    const missing = "no token for acme is saved as teamrig-gh-acme in the test store; teamrig reaches a repository only with its owner's saved token, never the gh login: save one with: save teamrig-gh-acme";
    assert.deepEqual(await keyless.reach('acme/web', 'write'), { kind: 'unreachable', reason: missing });
    assert.deepEqual(await keyless.close(TARGET), { kind: 'failed', reason: missing });
    assert.deepEqual(none.ran, []);
  });

  it('reaches nothing and runs no gh when the store holds the key but cannot read it', async () => {
    const gh = new FakeGh();
    const host = hostWith(gh, new FakeCredentials().failsOn('teamrig-gh-acme', 'the keyring is locked'));
    const reason = 'could not read teamrig-gh-acme from the test store: the keyring is locked; unlock the store and rerun, or save the key again with: save teamrig-gh-acme';
    assert.deepEqual(await host.reach('acme/web', 'read'), { kind: 'unreachable', reason });
    assert.deepEqual(await host.list('acme/web', '2029-12-25'), { kind: 'failed', reason });
    assert.deepEqual(await host.pulls('acme/web', undefined), { kind: 'failed', reason });
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
    assert.deepEqual(await hostWith(missing).close(TARGET), { kind: 'failed', reason: 'acme/web#7 is not there for the token saved as teamrig-gh-acme: check the number, and that the token reaches acme/web' });
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
      reason: 'the token saved as teamrig-gh-acme may not add a sub-issue to acme/web#7: on GitHub, edit that token and set Issues and Pull requests to Read and write; its text stays the same, so nothing needs saving again',
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

describe('GitHubIssueHost fields (T3406)', () => {
  const PRIORITY = { name: 'Priority', kind: 'single-select', id: 11, options: ['P1'] } as const;

  it("reads the fields with the owner's token, and sets a field's value and an issue's type through the allowlisted calls", async () => {
    const stdout = JSON.stringify({
      data: {
        repository: {
          issueTypes: { nodes: [{ name: 'Bug', isEnabled: true }] },
          issueFields: { nodes: [{ __typename: 'IssueFieldSingleSelect', name: 'Priority', fullDatabaseId: '11', options: [{ name: 'P1' }] }] },
          issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ number: 7, issueType: null, issueFieldValues: { nodes: [] } }] },
        },
      },
    });
    const reader = new FakeGh().answers('acme/web', { end: { kind: 'exited', code: 0 }, stdout, stderr: '' });
    const read = await hostWith(reader, new FakeCredentials().saves('teamrig-gh-acme', 'acme-issues-token')).fields.read('acme/web');
    assert.deepEqual(read, { kind: 'read', fields: [PRIORITY], types: ['Bug'], issues: [{ number: 7, type: undefined, values: new Map() }], notes: [] });
    assert.ok(isIssueQuery(reader.ran[0]?.args ?? []) && reader.ran[0]?.env['GH_TOKEN'] === 'acme-issues-token');
    const gh = new FakeGh();
    const host = hostWith(gh, new FakeCredentials().saves('teamrig-gh-acme', 'acme-issues-token'));
    assert.deepEqual(await host.fields.setField(TARGET, PRIORITY, 'P1'), { kind: 'done' });
    assert.deepEqual(await host.fields.setType(TARGET, 'Bug'), { kind: 'done' });
    assert.deepEqual(gh.ran.map((request) => request.args), [
      ['api', 'repos/acme/web/issues/7/issue-field-values', '-X', 'POST', '-F', 'issue_field_values[][field_id]=11', '-f', 'issue_field_values[][value]=P1'],
      ['api', 'repos/acme/web/issues/7', '-X', 'PATCH', '-f', 'type=Bug'],
    ]);
    assert.ok(isFieldValueSet(gh.ran[0]?.args ?? []) && isIssueTypeSet(gh.ran[1]?.args ?? []));
    assert.ok(gh.ran.every((request) => request.env['GH_TOKEN'] === 'acme-issues-token'));
  });

  it('names the field or type a refusal was for, and runs no gh when the store cannot read the key', async () => {
    const denied = new FakeGh().failsWrite({ end: { kind: 'exited', code: 1 }, stdout: '', stderr: 'gh: Resource not accessible by personal access token (HTTP 403)\n' });
    const host = hostWith(denied);
    assert.deepEqual(await host.fields.setField(TARGET, PRIORITY, 'P1'), {
      kind: 'failed',
      reason: 'the token saved as teamrig-gh-acme may not set the field "Priority" of acme/web#7: on GitHub, edit that token and set Issues and Pull requests to Read and write; its text stays the same, so nothing needs saving again',
    });
    const refused = new FakeGh().failsWrite({ end: { kind: 'exited', code: 1 }, stdout: '', stderr: 'gh: Validation Failed (HTTP 422)\n' });
    assert.deepEqual(await hostWith(refused).fields.setType(TARGET, 'Bug'), { kind: 'failed', reason: 'gh api to set the type of acme/web#7 exited with code 1: gh: Validation Failed (HTTP 422)' });
    const gh = new FakeGh();
    const locked = hostWith(gh, new FakeCredentials().failsOn('teamrig-gh-acme', 'the keyring is locked'));
    const reason = 'could not read teamrig-gh-acme from the test store: the keyring is locked; unlock the store and rerun, or save the key again with: save teamrig-gh-acme';
    assert.deepEqual(await locked.fields.read('acme/web'), { kind: 'failed', reason });
    assert.deepEqual(await locked.fields.setType(TARGET, 'Bug'), { kind: 'failed', reason });
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
