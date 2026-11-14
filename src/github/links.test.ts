import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FakeGh, ghIssue } from '../testing/fake-gh.ts';
import { isIssueQuery, type GhResult } from './gh.ts';
import { listLinks, parseLinksPage } from './links.ts';
import { ISSUE_LINKS_QUERY } from './queries.ts';
import type { RepoAccess } from './tokens.ts';

const REPO = 'acme/web';

const LOGIN: RepoAccess = { via: 'login', owner: 'acme', credential: 'teamrig-gh-acme', save: 'save teamrig-gh-acme', env: { HOME: '/u' } };

function page(nodes: readonly unknown[], next?: string): string {
  return JSON.stringify({ data: { repository: { issues: { pageInfo: { hasNextPage: next !== undefined, endCursor: next ?? null }, nodes } } } });
}

describe('parseLinksPage', () => {
  it("reads each issue's id, its parent in any repository, and its blockers of the same repository", () => {
    const nodes = [
      ghIssue('Acme/Web', 7, { hostId: 6375244885, parent: { repo: 'Acme/API', number: 3 }, blockedBy: [{ repo: 'Acme/Web', number: 8 }, { repo: 'acme/api', number: 9 }] }),
      ghIssue('acme/web', 8, { state: 'CLOSED' }),
    ];
    assert.deepEqual(parseLinksPage(page(nodes, 'Y3Vyc29y'), REPO), {
      kind: 'page',
      issues: [
        { number: 7, hostId: 6375244885, parent: { repo: 'acme/api', number: 3 }, blockedBy: [8] },
        { number: 8, hostId: 1008, parent: undefined, blockedBy: [] },
      ],
      unreadable: 0,
      items: 2,
      next: 'Y3Vyc29y',
    });
  });

  it('leaves out and counts an issue whose number, id, parent or any blocker does not read', () => {
    const good = ghIssue(REPO, 7);
    const nodes = [
      'not an issue',
      { ...good, number: 0 },
      { ...good, fullDatabaseId: 6375244885 },
      { ...good, fullDatabaseId: '0123' },
      { ...good, fullDatabaseId: '1234567890123456' },
      { ...good, parent: { number: 3 } },
      { ...good, parent: { number: 3, repository: { nameWithOwner: 'no-slash' } } },
      { ...good, blockedBy: { nodes: [{ number: 'eight', repository: { nameWithOwner: REPO } }] } },
      good,
    ];
    const read = parseLinksPage(page(nodes), REPO);
    assert.equal(read.kind, 'page');
    assert.deepEqual(read.kind === 'page' && [read.issues.map((issue) => issue.number), read.unreadable, read.items, read.next], [[7], 8, 9, undefined]);
  });

  it('fails on anything that is not a page, or a page that says more follow with no cursor', () => {
    const failed = { kind: 'failed', reason: 'gh printed no page of the issue links of acme/web' };
    for (const stdout of ['', 'not json', '[]', '{"data":{"repository":null}}', JSON.stringify({ data: { repository: { issues: { pageInfo: {}, nodes: {} } } } })]) {
      assert.deepEqual(parseLinksPage(stdout, REPO), failed, stdout);
    }
    const noCursor = JSON.stringify({ data: { repository: { issues: { pageInfo: { hasNextPage: true, endCursor: '' }, nodes: [] } } } });
    assert.deepEqual(parseLinksPage(noCursor, REPO), failed);
  });
});

describe('listLinks', () => {
  it('reads every issue, open and closed, a page of the shipped links query at a time', async () => {
    const gh = new FakeGh().pages(2).holds(REPO, [ghIssue(REPO, 1), ghIssue(REPO, 2, { state: 'CLOSED' }), ghIssue(REPO, 3, { blockedBy: [{ repo: REPO, number: 1 }] })]);
    const links = await listLinks(gh, LOGIN, REPO);
    assert.deepEqual(links.kind === 'listed' && [links.issues.map((issue) => [issue.number, issue.blockedBy]), links.notes], [
      [
        [1, []],
        [2, []],
        [3, [1]],
      ],
      [],
    ]);
    assert.equal(gh.ran.length, 2);
    assert.ok(gh.ran.every((request) => isIssueQuery(request.args) && request.args.includes(`query=${ISSUE_LINKS_QUERY}`)));
    assert.deepEqual(gh.ran[1]?.args.slice(-2), ['-f', 'after=2']);
  });

  it('says when it stopped at its limit, or left out items it could not read', async () => {
    const gh = new FakeGh().pages(2).holds(REPO, [ghIssue(REPO, 1), { ...ghIssue(REPO, 2), fullDatabaseId: null }, ghIssue(REPO, 3)]);
    const links = await listLinks(gh, LOGIN, REPO, 2);
    assert.deepEqual(links.kind === 'listed' && [links.issues.map((issue) => issue.number), links.notes], [
      [1],
      ['the links read reached 2 issues, so it may leave some out', '1 item(s) gh printed did not read as issues with links and were left out'],
    ]);
  });

  it('gives nothing when any page fails, a repository that is not owner/name, or a gh that cannot start', async () => {
    assert.deepEqual(await listLinks(new FakeGh(), LOGIN, 'acme/nope'), {
      kind: 'failed',
      reason: 'acme/nope is not visible to the gh login: check github.repos, or save a read-only token for acme with: save teamrig-gh-acme',
    });
    const gh = new FakeGh();
    assert.deepEqual(await listLinks(gh, LOGIN, 'acme'), { kind: 'failed', reason: 'acme is not owner/name: check github.repos' });
    assert.deepEqual(gh.ran, []);
    const absent = new FakeGh().failsWith(Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }));
    const failed = await listLinks(absent, LOGIN, REPO);
    assert.ok(failed.kind === 'failed' && failed.reason.startsWith('gh, the GitHub CLI, is not installed'));
  });

  it('stops at a page with nothing on it, even one that says more follow', async () => {
    const empty: GhResult = { end: { kind: 'exited', code: 0 }, stdout: page([], 'Y3Vyc29y'), stderr: '' };
    const gh = new FakeGh().answers(REPO, empty);
    assert.deepEqual(await listLinks(gh, LOGIN, REPO), { kind: 'listed', issues: [], notes: ['GitHub sent an empty page that said more follow, so the links read may leave some out'] });
    assert.equal(gh.ran.length, 1);
  });
});
