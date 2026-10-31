import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { JsonRecord } from '../core/guards.ts';
import { FakeGh, ghIssue, labeledEvent, renamedEvent } from '../testing/fake-gh.ts';
import { isIssueQuery, type GhRequest, type GhResult, type GhRunner } from './gh.ts';
import { issuePageArgs, listIssues, parseIssuePage, plainLine, type GithubIssue, type IssueListRequest } from './issues.ts';
import { closedPageArgs, openPageArgs } from './queries.ts';
import type { RepoAccess } from './tokens.ts';

const OPEN: IssueListRequest = { repo: 'acme/web', state: 'open', limit: 500 };
const CLOSED: IssueListRequest = { repo: 'acme/web', state: 'closed', closedSince: '2029-12-25', limit: 500 };
/** Reading through the gh login, as when no token is saved for acme. */
const LOGIN: RepoAccess = { via: 'login', env: { HOME: '/u' }, owner: 'acme', credential: 'teamrig-gh-acme', save: 'save teamrig-gh-acme' };
const TOKEN: RepoAccess = { ...LOGIN, via: 'token', env: { HOME: '/u', GH_TOKEN: 'read-token' } };

/** A gh error, as `spawn` raises it. */
function spawnError(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

/** An issue of acme/web as read from what ghIssue gives when a test sets nothing. */
function readIssue(number: number, overrides: Partial<GithubIssue> = {}): GithubIssue {
  return {
    repo: 'acme/web',
    number,
    title: `Issue ${number}`,
    body: '',
    state: 'open',
    stateReason: '',
    labels: [],
    assignees: [],
    url: `https://github.com/acme/web/issues/${number}`,
    updatedAt: '2030-01-01T00:00:00Z',
    closedAt: undefined,
    lastEditedAt: undefined,
    authorAssociation: 'OWNER',
    author: 'maintainer',
    labelEvents: [],
    renamedAt: undefined,
    ...overrides,
  };
}

/** Issues 1 to `count` of acme/web, all open. */
function openIssues(count: number): JsonRecord[] {
  return Array.from({ length: count }, (_, index) => ghIssue('acme/web', index + 1));
}

/** A page as gh prints the answer to a shipped issue query. */
function pageText(nodes: readonly unknown[], pageInfo: JsonRecord = { hasNextPage: false, endCursor: null }): string {
  return JSON.stringify({ data: { repository: { issues: { pageInfo, nodes } } } });
}

/** A gh whose first page reads well and whose second fails, as a rate limit hit in the middle of a read would. */
class SecondPageFails implements GhRunner {
  readonly ran: GhRequest[] = [];
  private readonly first = new FakeGh().pages(1).holds('acme/web', openIssues(2));

  async run(request: GhRequest): Promise<GhResult> {
    this.ran.push(request);
    return this.ran.length === 1 ? this.first.run(request) : { end: { kind: 'exited', code: 1 }, stdout: '', stderr: 'HTTP 403: API rate limit exceeded\n' };
  }
}

describe('issuePageArgs', () => {
  it('asks for a page of the open or closed query, after the cursor given, closed ones from the start of their day', () => {
    assert.deepEqual(issuePageArgs(OPEN, undefined), openPageArgs({ owner: 'acme', name: 'web', after: undefined }));
    assert.deepEqual(issuePageArgs(CLOSED, 'Y3Vyc29y'), closedPageArgs({ owner: 'acme', name: 'web', after: 'Y3Vyc29y' }, '2029-12-25T00:00:00Z'));
  });

  it('gives nothing for a repository that is not owner/name', () => {
    for (const repo of ['acme', 'acme/', '/web', 'acme/web/issues', '']) {
      assert.equal(issuePageArgs({ ...OPEN, repo }, undefined), null, repo);
    }
  });
});

describe('listIssues', () => {
  it('reads the issues of one state, with who wrote, labelled and renamed each, through a read only', async () => {
    const gh = new FakeGh().holds('acme/web', [
      ghIssue('acme/web', 7, {
        title: 'Fix login',
        body: 'Steps:\n1. log in',
        labels: ['bug', 'p1'],
        assignees: ['octocat'],
        authorAssociation: 'NONE',
        author: 'stranger',
        lastEditedAt: '2030-01-02T00:00:00Z',
        timeline: [labeledEvent('p1', 'maintainer', '2030-01-03T00:00:00Z'), renamedEvent('2030-01-04T00:00:00Z')],
      }),
      ghIssue('acme/web', 8, { state: 'CLOSED', stateReason: 'COMPLETED' }),
    ]);
    assert.deepEqual(await listIssues(gh, LOGIN, OPEN), {
      kind: 'listed',
      issues: [
        readIssue(7, {
          title: 'Fix login',
          body: 'Steps:\n1. log in',
          labels: ['bug', 'p1'],
          assignees: ['octocat'],
          authorAssociation: 'NONE',
          author: 'stranger',
          lastEditedAt: '2030-01-02T00:00:00Z',
          labelEvents: [{ label: 'p1', at: '2030-01-03T00:00:00Z', actor: 'maintainer', actorKind: 'User' }],
          renamedAt: '2030-01-04T00:00:00Z',
        }),
      ],
      unreadable: 0,
      full: false,
    });
    assert.deepEqual(gh.ran, [{ args: issuePageArgs(OPEN, undefined), env: { HOME: '/u' } }]);
    assert.ok(gh.ran.every((request) => isIssueQuery(request.args)));
  });

  it('reads page after page, each after the cursor the one before ended on', async () => {
    const gh = new FakeGh().pages(2).holds('acme/web', openIssues(5));
    const list = await listIssues(gh, LOGIN, OPEN);
    assert.deepEqual(list.kind === 'listed' && [list.issues.map((issue) => issue.number), list.full], [[1, 2, 3, 4, 5], false]);
    assert.deepEqual(
      gh.ran.map((request) => request.args),
      [issuePageArgs(OPEN, undefined), issuePageArgs(OPEN, '2'), issuePageArgs(OPEN, '4')],
    );
  });

  it('stops at its limit, and says it left issues out only when GitHub has more', async () => {
    const stopped = new FakeGh().pages(2).holds('acme/web', openIssues(5));
    const cut = await listIssues(stopped, LOGIN, { ...OPEN, limit: 4 });
    assert.deepEqual(cut.kind === 'listed' && [cut.issues.map((issue) => issue.number), cut.full], [[1, 2, 3, 4], true]);
    assert.equal(stopped.ran.length, 2);
    const whole = await listIssues(new FakeGh().pages(2).holds('acme/web', openIssues(5)), LOGIN, { ...OPEN, limit: 5 });
    assert.deepEqual(whole.kind === 'listed' && [whole.issues.length, whole.full], [5, false]);
  });

  it('ends on a page with nothing on it, even when GitHub says more follow', async () => {
    const gh = new FakeGh().answers('acme/web', { end: { kind: 'exited', code: 0 }, stdout: pageText([], { hasNextPage: true, endCursor: 'x' }), stderr: '' });
    assert.deepEqual(await listIssues(gh, LOGIN, OPEN), { kind: 'listed', issues: [], unreadable: 0, full: true });
    assert.equal(gh.ran.length, 1);
  });

  it('fails the whole read when a later page fails, so nothing is judged on half of it', async () => {
    const gh = new SecondPageFails();
    assert.deepEqual(await listIssues(gh, LOGIN, OPEN), {
      kind: 'failed',
      reason: 'gh api graphql for the issues of acme/web exited with code 1: HTTP 403: API rate limit exceeded',
    });
    assert.equal(gh.ran.length, 2);
  });

  it('runs nothing for a repository that is not owner/name', async () => {
    const gh = new FakeGh();
    assert.deepEqual(await listIssues(gh, LOGIN, { ...OPEN, repo: 'acme\u001b[2J' }), { kind: 'failed', reason: 'acme [2J is not owner/name: check github.repos' });
    assert.deepEqual(gh.ran, []);
  });

  it('keeps the closed issues closed on or after the day, though GitHub sends any changed since it', async () => {
    const gh = new FakeGh().holds('acme/web', [
      ghIssue('acme/web', 7),
      ghIssue('acme/web', 8, { state: 'CLOSED', stateReason: 'COMPLETED' }),
      ghIssue('acme/web', 9, { state: 'CLOSED', updatedAt: '2030-01-02T00:00:00Z', closedAt: '2029-12-24T23:59:59Z' }),
      ghIssue('acme/web', 10, { state: 'CLOSED', updatedAt: '2030-01-02T00:00:00Z', closedAt: '2029-12-25T00:00:00Z' }),
    ]);
    const list = await listIssues(gh, LOGIN, CLOSED);
    assert.deepEqual(list.kind === 'listed' && list.issues, [
      readIssue(8, { state: 'closed', stateReason: 'COMPLETED', closedAt: '2030-01-01T00:00:00Z' }),
      readIssue(10, { state: 'closed', updatedAt: '2030-01-02T00:00:00Z', closedAt: '2029-12-25T00:00:00Z' }),
    ]);
    assert.deepEqual(list.kind === 'listed' && list.unreadable, 0);
    assert.deepEqual(gh.ran.map((request) => request.args), [issuePageArgs(CLOSED, undefined)]);
  });

  it('says how to fix a repository the login cannot see', async () => {
    assert.deepEqual(await listIssues(new FakeGh(), LOGIN, { ...OPEN, repo: 'acme/nope' }), {
      kind: 'failed',
      reason: 'acme/nope is not visible to the gh login: check github.repos, or save a read-only token for acme with: save teamrig-gh-acme',
    });
  });

  it('says to log in when gh has no login', async () => {
    const byCode = new FakeGh().answers('acme/web', { end: { kind: 'exited', code: 4 }, stdout: '', stderr: 'To get started with GitHub CLI, please run:  gh auth login\n' });
    const byText = new FakeGh().answers('acme/web', { end: { kind: 'exited', code: 1 }, stdout: '', stderr: 'HTTP 401: Bad credentials (https://api.github.com/graphql)\n' });
    for (const gh of [byCode, byText]) {
      assert.deepEqual(await listIssues(gh, LOGIN, OPEN), { kind: 'failed', reason: 'gh is not logged in to GitHub: run gh auth login, or save a read-only token for acme with: save teamrig-gh-acme' });
    }
  });

  it('says the login may not read the issues, and saving a token would', async () => {
    const gh = new FakeGh().answers('acme/web', { end: { kind: 'exited', code: 1 }, stdout: '', stderr: 'GraphQL: Resource not accessible by personal access token (repository.issues)\n' });
    assert.deepEqual(await listIssues(gh, LOGIN, OPEN), {
      kind: 'failed',
      reason: 'the gh login may not read the issues of acme/web: save a read-only token for acme with: save teamrig-gh-acme',
    });
  });

  it('names the token for a token GitHub refused, could not see the repository with, or may not read issues with', async () => {
    const failing = (stderr: string): FakeGh => new FakeGh().answers('acme/web', { end: { kind: 'exited', code: 1 }, stdout: '', stderr });
    assert.deepEqual(await listIssues(failing('HTTP 401: Bad credentials (https://api.github.com/graphql)\n'), TOKEN, OPEN), {
      kind: 'failed',
      reason: 'GitHub refused the token saved as teamrig-gh-acme (expired or revoked?): create a new one and save it again with: save teamrig-gh-acme',
    });
    assert.deepEqual(await listIssues(failing("gh: Could not resolve to a Repository with the name 'acme/web'.\n"), TOKEN, OPEN), {
      kind: 'failed',
      reason: 'acme/web is not visible to the token saved as teamrig-gh-acme: check github.repos, and on GitHub give that token this repository',
    });
    assert.deepEqual(await listIssues(failing('GraphQL: Resource not accessible by personal access token (repository.issues)\n'), TOKEN, OPEN), {
      kind: 'failed',
      reason: 'the token saved as teamrig-gh-acme may not read the issues of acme/web: on GitHub, edit that token and set Issues to Read-only; its text stays the same, so nothing needs saving again',
    });
  });

  it('runs gh with the token only in its environment, never in its arguments', async () => {
    const gh = new FakeGh().holds('acme/web', []);
    await listIssues(gh, TOKEN, OPEN);
    assert.deepEqual(gh.ran, [{ args: issuePageArgs(OPEN, undefined), env: { HOME: '/u', GH_TOKEN: 'read-token' } }]);
  });

  it('says gh is not installed, or why it could not start', async () => {
    assert.deepEqual(await listIssues(new FakeGh().failsWith(spawnError('spawn gh ENOENT', 'ENOENT')), LOGIN, OPEN), {
      kind: 'failed',
      reason: 'gh, the GitHub CLI, is not installed or not on PATH: install it from https://cli.github.com, then run gh auth login',
    });
    assert.deepEqual(await listIssues(new FakeGh().failsWith(spawnError('spawn gh EACCES', 'EACCES')), LOGIN, OPEN), {
      kind: 'failed',
      reason: 'gh could not start: spawn gh EACCES',
    });
  });

  it('gives any other failure as gh first stderr line, on one plain line, and a stop by its signal', async () => {
    const failed = new FakeGh().answers('acme/web', { end: { kind: 'exited', code: 1 }, stdout: '', stderr: 'HTTP 502:\u001b[31m Bad Gateway\nretry later\n' });
    assert.deepEqual(await listIssues(failed, LOGIN, OPEN), { kind: 'failed', reason: 'gh api graphql for the issues of acme/web exited with code 1: HTTP 502: [31m Bad Gateway' });
    const stopped = new FakeGh().answers('acme/web', { end: { kind: 'signal', signal: 'SIGTERM' }, stdout: '', stderr: '' });
    assert.deepEqual(await listIssues(stopped, LOGIN, OPEN), { kind: 'failed', reason: 'gh was stopped (SIGTERM) before it listed the issues of acme/web; it gets 60 s' });
  });
});

describe('parseIssuePage', () => {
  it('refuses output that is not a page of issues, or says more follow with no cursor to read them by', () => {
    const outputs = [
      '',
      'not json',
      '[]',
      JSON.stringify({ data: { repository: null } }),
      JSON.stringify({ data: { repository: { issues: { nodes: [] } } } }),
      pageText([], { hasNextPage: true, endCursor: null }),
      JSON.stringify({ data: { repository: { issues: { pageInfo: { hasNextPage: false }, nodes: 'none' } } } }),
    ];
    for (const stdout of outputs) {
      assert.deepEqual(parseIssuePage(stdout, OPEN), { kind: 'failed', reason: 'gh printed no page of the issues of acme/web' }, stdout);
    }
  });

  it('reads the shape GitHub sends, and counts each item it cannot read as an issue', () => {
    // Shaped as GitHub's GraphQL API answers the shipped queries: missing values are null, lists are connections.
    const node = {
      number: 14704,
      title: 'run list shows cancelled jobs',
      body: 'Seen in 2.62.',
      state: 'OPEN',
      stateReason: null,
      url: 'https://github.com/cli/cli/issues/14704',
      updatedAt: '2024-11-05T10:11:12Z',
      closedAt: null,
      lastEditedAt: '2024-11-04T08:00:00Z',
      authorAssociation: 'NONE',
      author: null,
      labels: { nodes: [{ name: 'bug' }, { id: 'no name' }] },
      assignees: { nodes: [{ login: 5 }, { login: 'octocat' }] },
      timelineItems: {
        nodes: [
          labeledEvent('bug', 'triage-bot', '2024-11-04T09:00:00Z', 'Bot'),
          { __typename: 'LabeledEvent', createdAt: '2024-11-04T10:00:00Z', actor: null, label: { name: 'p1' } },
          { __typename: 'LabeledEvent', createdAt: 'soon', actor: null, label: { name: 'p2' } },
          { __typename: 'LabeledEvent', createdAt: '2024-11-04T10:00:00Z', actor: null, label: null },
          renamedEvent('2024-11-04T12:00:00Z'),
          renamedEvent('2024-11-04T11:00:00Z'),
          { __typename: 'RenamedTitleEvent', createdAt: 'later' },
          'an event',
        ],
      },
    };
    const items = [
      node,
      { ...node, number: '14705' },
      { ...node, number: 0 },
      { ...node, state: 'MERGED' },
      { ...node, url: 'javascript:alert(1)' },
      { ...node, title: null },
      { number: 14706, title: 'Old shape', state: 'CLOSED', url: 'https://github.com/cli/cli/issues/14706', body: null, labels: [{ name: 'bug' }], assignees: 'octocat', updatedAt: 'yesterday', authorAssociation: 7, author: { login: null }, timelineItems: null },
      'an issue',
    ];
    const read = { repo: 'cli/cli', url: 'https://github.com/cli/cli/issues/14704' };
    assert.deepEqual(parseIssuePage(pageText(items, { hasNextPage: true, endCursor: 'Y3Vyc29yOjg=' }), { ...OPEN, repo: 'cli/cli' }), {
      kind: 'page',
      issues: [
        readIssue(14704, {
          ...read,
          title: 'run list shows cancelled jobs',
          body: 'Seen in 2.62.',
          labels: ['bug'],
          assignees: ['octocat'],
          updatedAt: '2024-11-05T10:11:12Z',
          lastEditedAt: '2024-11-04T08:00:00Z',
          authorAssociation: 'NONE',
          author: '',
          labelEvents: [
            { label: 'bug', at: '2024-11-04T09:00:00Z', actor: 'triage-bot', actorKind: 'Bot' },
            { label: 'p1', at: '2024-11-04T10:00:00Z', actor: '', actorKind: '' },
          ],
          renamedAt: '2024-11-04T12:00:00Z',
        }),
        readIssue(14706, { repo: 'cli/cli', url: 'https://github.com/cli/cli/issues/14706', title: 'Old shape', state: 'closed', updatedAt: undefined, authorAssociation: '', author: '' }),
      ],
      unreadable: 6,
      items: 8,
      next: 'Y3Vyc29yOjg=',
    });
  });

  it('gives no next cursor on the last page', () => {
    assert.deepEqual(parseIssuePage(pageText([], { hasNextPage: false, endCursor: 'Y3Vyc29y' }), OPEN), { kind: 'page', issues: [], unreadable: 0, items: 0, next: undefined });
  });
});

describe('plainLine', () => {
  it('turns control and format characters into spaces, so outside text stays one plain line', () => {
    assert.equal(plainLine('  Fix\u001b[2J the‮ login\r\nnow\t '), 'Fix [2J the login now');
  });
});
