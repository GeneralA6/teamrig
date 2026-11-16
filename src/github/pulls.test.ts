import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FakeGh, ghPull } from '../testing/fake-gh.ts';
import { isIssueQuery } from './gh.ts';
import type { HostPull } from '../issues/pull.ts';
import { listPulls, pullOf, type PullListRequest } from './pulls.ts';
import type { RepoAccess } from './tokens.ts';

const TOKEN: RepoAccess = { env: { HOME: '/u', GH_TOKEN: 'read-token' }, owner: 'acme', credential: 'teamrig-gh-acme', save: 'save teamrig-gh-acme' };
const ALL: PullListRequest = { repo: 'acme/web', read: 'changed', since: undefined, limit: 200 };

/** A pull request of acme/web as read from what ghPull gives when a test sets nothing. */
function readPull(number: number, overrides: Partial<HostPull> = {}): HostPull {
  return {
    repo: 'acme/web',
    number,
    title: `Change ${number}`,
    url: `https://github.com/acme/web/pull/${number}`,
    state: 'open',
    draft: false,
    createdAt: '2030-01-01T00:00:00Z',
    updatedAt: '2030-01-01T00:00:00Z',
    mergedAt: undefined,
    closedAt: undefined,
    authorAssociation: 'OWNER',
    author: 'maintainer',
    head: 't1-change',
    fork: false,
    mergeable: 'mergeable',
    checks: 'none',
    review: 'none',
    failedJobs: [],
    ...overrides,
  };
}

/** Pull requests 1 to `count`, the higher the number the later its change. */
function changed(count: number): ReturnType<typeof ghPull>[] {
  return Array.from({ length: count }, (_, index) => ghPull('acme/web', index + 1, { updatedAt: `2030-01-0${index + 1}T00:00:00Z` }));
}

describe('listPulls', () => {
  it('reads every pull request newest change first, through the shipped query only', async () => {
    const gh = new FakeGh().holdsPulls('acme/web', changed(3));
    const list = await listPulls(gh, TOKEN,ALL);
    assert.equal(list.kind, 'listed');
    assert.deepEqual(list.kind === 'listed' ? list.pulls.map((pull) => pull.number) : [], [3, 2, 1]);
    assert.ok(gh.ran.every((request) => isIssueQuery(request.args)));
  });

  it('reads only the open ones for the open read', async () => {
    const gh = new FakeGh().holdsPulls('acme/web', [...changed(2), ghPull('acme/web', 3, { state: 'MERGED' })]);
    const list = await listPulls(gh, TOKEN,{ ...ALL, read: 'open' });
    assert.deepEqual(list.kind === 'listed' ? list.pulls.map((pull) => pull.number) : [], [2, 1]);
  });

  it('stops at the first one changed before since, so a run reads only what changed', async () => {
    const gh = new FakeGh().pages(1).holdsPulls('acme/web', changed(5));
    const list = await listPulls(gh, TOKEN,{ ...ALL, since: '2030-01-04T00:00:00Z' });
    assert.deepEqual(list, { kind: 'listed', pulls: [readPull(5, { updatedAt: '2030-01-05T00:00:00Z' }), readPull(4, { updatedAt: '2030-01-04T00:00:00Z' })], unreadable: 0, full: false });
    assert.equal(gh.ran.length, 3, 'the third page held the first older one');
  });

  it('stops at its limit, and says it left some out only when GitHub has more', async () => {
    const full = await listPulls(new FakeGh().pages(2).holdsPulls('acme/web', changed(5)), TOKEN,{ ...ALL, limit: 4 });
    assert.deepEqual(full.kind === 'listed' ? [full.pulls.length, full.full] : [], [4, true]);
    const exact = await listPulls(new FakeGh().pages(2).holdsPulls('acme/web', changed(4)), TOKEN,{ ...ALL, limit: 4 });
    assert.deepEqual(exact.kind === 'listed' ? [exact.pulls.length, exact.full] : [], [4, false]);
  });

  it('counts an item it cannot read and reads on past it', async () => {
    const gh = new FakeGh().holdsPulls('acme/web', [...changed(2), { ...ghPull('acme/web', 9), state: 'DRAFTED' }]);
    const list = await listPulls(gh, TOKEN,ALL);
    assert.deepEqual(list.kind === 'listed' ? [list.pulls.map((pull) => pull.number), list.unreadable] : [], [[2, 1], 1]);
  });

  it('runs nothing for a repository that is not owner/name', async () => {
    const gh = new FakeGh();
    assert.deepEqual(await listPulls(gh, TOKEN,{ ...ALL, repo: 'acme' }), { kind: 'failed', reason: 'acme is not owner/name: check github.repos' });
    assert.equal(gh.ran.length, 0);
  });

  it('words a refused read for pull requests, naming the permission a token needs', async () => {
    const gh = new FakeGh().answers('acme/web', { end: { kind: 'exited', code: 1 }, stdout: '', stderr: 'gh: Resource not accessible by personal access token\n' });
    assert.deepEqual(await listPulls(gh, TOKEN, ALL), {
      kind: 'failed',
      reason: 'the token saved as teamrig-gh-acme may not read the pull requests of acme/web: on GitHub, edit that token and set Pull requests to Read-only; its text stays the same, so nothing needs saving again',
    });
  });

  it('fails on output that is not a page of pull requests', async () => {
    const gh = new FakeGh().answers('acme/web', { end: { kind: 'exited', code: 0 }, stdout: '{"data":{"repository":{"issues":{}}}}', stderr: '' });
    assert.deepEqual(await listPulls(gh, TOKEN,ALL), { kind: 'failed', reason: 'gh printed no page of the pull requests of acme/web' });
  });

  it('runs gh with the token only in its environment', async () => {
    const gh = new FakeGh().holdsPulls('acme/web', changed(1));
    await listPulls(gh, TOKEN, ALL);
    assert.equal(gh.ran[0]?.env['GH_TOKEN'], 'read-token');
    assert.ok(!gh.ran[0]?.args.some((arg) => arg.includes('read-token')));
  });
});

describe('pullOf', () => {
  it('reads the state, fork, mergeable, review and check rollup GitHub sends', () => {
    const merged = ghPull('acme/web', 7, {
      state: 'MERGED',
      updatedAt: '2030-01-02T00:00:00Z',
      authorAssociation: 'NONE',
      author: 'outsider',
      head: 'patch-1',
      fork: true,
      mergeable: 'CONFLICTING',
      reviewDecision: 'CHANGES_REQUESTED',
      checks: 'ERROR',
      isDraft: true,
    });
    assert.deepEqual(
      pullOf(merged, 'acme/web'),
      readPull(7, {
        state: 'merged',
        draft: true,
        updatedAt: '2030-01-02T00:00:00Z',
        mergedAt: '2030-01-02T00:00:00Z',
        closedAt: '2030-01-02T00:00:00Z',
        authorAssociation: 'NONE',
        author: 'outsider',
        head: 'patch-1',
        fork: true,
        mergeable: 'conflicting',
        review: 'changes-requested',
        checks: 'failing',
      }),
    );
    const rollups = [['SUCCESS', 'passing'], ['FAILURE', 'failing'], ['PENDING', 'pending'], ['EXPECTED', 'pending'], [null, 'none']] as const;
    for (const [state, checks] of rollups) {
      assert.equal(pullOf(ghPull('acme/web', 1, { checks: state }), 'acme/web')?.checks, checks, String(state));
    }
    assert.equal(pullOf(ghPull('acme/web', 1, { state: 'CLOSED', reviewDecision: 'APPROVED', mergeable: 'UNKNOWN' }), 'acme/web')?.mergedAt, undefined);
  });

  it('names each failed check run with its job id, leaving out passing runs, status contexts and bad ids', () => {
    const run = (name: string, conclusion: string | null, databaseId: unknown) => ({ __typename: 'CheckRun', name, conclusion, databaseId });
    const contexts = [
      run('test (ubuntu-latest)', 'FAILURE', 41),
      run('lint', 'SUCCESS', 42),
      run('test (windows-latest)', 'TIMED_OUT', 43),
      run('build', 'CANCELLED', 44),
      run('setup', 'STARTUP_FAILURE', 45),
      run('still running', null, 46),
      run('no id', 'FAILURE', null),
      run('bad id', 'FAILURE', -1),
      { __typename: 'StatusContext', context: 'ci/external', state: 'FAILURE' },
      'junk',
    ];
    assert.deepEqual(pullOf(ghPull('acme/web', 1, { checks: 'FAILURE', contexts }), 'acme/web')?.failedJobs, [
      { name: 'test (ubuntu-latest)', id: 41 },
      { name: 'test (windows-latest)', id: 43 },
      { name: 'build', id: 44 },
      { name: 'setup', id: 45 },
    ]);
    assert.deepEqual(pullOf(ghPull('acme/web', 1, { checks: null }), 'acme/web')?.failedJobs, []);
  });

  it('gives null for an item missing what a monitor needs', () => {
    const good = ghPull('acme/web', 1);
    for (const bad of [null, 'text', { ...good, number: 0 }, { ...good, url: 'javascript:alert(1)' }, { ...good, state: 'DRAFT' }, { ...good, updatedAt: 'yesterday' }, { ...good, createdAt: null }, { ...good, headRefName: null }]) {
      assert.equal(pullOf(bad, 'acme/web'), null, JSON.stringify(bad));
    }
  });
});
