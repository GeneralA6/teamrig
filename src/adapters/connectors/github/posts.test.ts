import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FakeGh, restComment, restIssue, restReview, restReviewComment } from '../../../testing/fake-gh.ts';
import { MENTION_PAGE_SIZE, MENTION_PAGES_MAX, REVIEW_READS_MAX } from '../../../plugin-api/index.ts';
import { isMentionRead, isReviewRead } from './gh.ts';
import { postOf, readPosts, reviewOf } from './posts.ts';
import type { RepoAccess } from './tokens.ts';

const TOKEN: RepoAccess = { env: { HOME: '/u', GH_TOKEN: 'read-token' }, owner: 'acme', credential: 'teamrig-gh-acme', save: 'save teamrig-gh-acme' };
const REPO = 'acme/web';
const SINCE = '2030-01-10T00:00:00Z';
const LATER = '2030-01-10T01:00:00Z';

describe('readPosts', () => {
  it('reads the comments, review comments, bodies and the moved pull requests\' reviews changed since the time, with read-only calls', async () => {
    const gh = new FakeGh()
      .holdsPosts(REPO, 'issues/comments', [restComment(REPO, 3, 11, { author: 'visitor', body: 'hi @octocat', updatedAt: LATER }), restComment(REPO, 3, 10, { updatedAt: '2030-01-09T00:00:00Z' })])
      .holdsPosts(REPO, 'pulls/comments', [restReviewComment(REPO, 4, 21, { body: 'nit', updatedAt: LATER })])
      .holdsPosts(REPO, 'issues', [restIssue(REPO, 3, { body: 'issue body', updatedAt: LATER }), restIssue(REPO, 4, { pull: true, body: 'pr body', updatedAt: LATER })])
      .holdsReviews(REPO, 4, [
        restReview(REPO, 4, 31, { body: 'lgtm @hubber', updatedAt: LATER }),
        restReview(REPO, 4, 30, { body: 'old', updatedAt: '2030-01-09T00:00:00Z' }),
        restReview(REPO, 4, 32, { body: 'draft', state: 'PENDING', updatedAt: LATER }),
      ]);
    const read = await readPosts(gh, TOKEN, REPO, SINCE);
    assert.equal(read.kind, 'read');
    assert.deepEqual(
      read.kind === 'read' ? read.posts.map((post) => [post.key, post.number, post.author, post.text]) : [],
      [
        ['comment:11', 3, 'visitor', 'hi @octocat'],
        ['review-comment:21', 4, 'someone', 'nit'],
        ['body:3', 3, 'someone', 'issue body'],
        ['body:4', 4, 'someone', 'pr body'],
        ['review:31', 4, 'someone', 'lgtm @hubber'],
      ],
    );
    assert.equal(read.kind === 'read' ? read.cutAt : 'failed', undefined);
    assert.equal(gh.ran.length, 4);
    assert.ok(gh.ran.every((request) => isMentionRead(request.args) || isReviewRead(request.args)));
  });

  it('reads no reviews when no pull request moved', async () => {
    const gh = new FakeGh().holdsPosts(REPO, 'issues', [restIssue(REPO, 3, { updatedAt: LATER })]);
    await readPosts(gh, TOKEN, REPO, SINCE);
    assert.equal(gh.ran.filter((request) => isReviewRead(request.args)).length, 0);
  });

  it('pages a list to its end, and stops at MENTION_PAGES_MAX pages with the time it is read through', async () => {
    const minute = (at: number): string => new Date(Date.parse(SINCE) + at * 60_000).toISOString().replace('.000', '');
    const full = MENTION_PAGES_MAX * MENTION_PAGE_SIZE;
    const comments = Array.from({ length: full + 1 }, (_, at) => restComment(REPO, 1, 100 + at, { updatedAt: minute(at) }));
    const short = new FakeGh().holdsPosts(REPO, 'issues/comments', comments.slice(0, MENTION_PAGE_SIZE + 5));
    const shortRead = await readPosts(short, TOKEN, REPO, SINCE);
    assert.equal(shortRead.kind === 'read' ? shortRead.posts.length : 0, MENTION_PAGE_SIZE + 5);
    assert.equal(shortRead.kind === 'read' ? shortRead.cutAt : 'failed', undefined);
    assert.equal(short.ran.length, 2 + 1 + 1);
    const long = await readPosts(new FakeGh().holdsPosts(REPO, 'issues/comments', comments), TOKEN, REPO, SINCE);
    assert.equal(long.kind === 'read' ? long.posts.length : 0, full);
    assert.equal(long.kind === 'read' ? long.cutAt : 'failed', minute(full - 1));
  });

  it(`reads the reviews of at most ${REVIEW_READS_MAX} pull requests, the rest from the next one's time on`, async () => {
    const minute = (at: number): string => new Date(Date.parse(SINCE) + at * 60_000).toISOString().replace('.000', '');
    const pulls = Array.from({ length: REVIEW_READS_MAX + 2 }, (_, at) => restIssue(REPO, at + 1, { pull: true, updatedAt: minute(at) }));
    const gh = new FakeGh().holdsPosts(REPO, 'issues', pulls);
    const read = await readPosts(gh, TOKEN, REPO, SINCE);
    assert.equal(gh.ran.filter((request) => isReviewRead(request.args)).length, REVIEW_READS_MAX);
    assert.equal(read.kind === 'read' ? read.cutAt : 'failed', minute(REVIEW_READS_MAX));
  });

  it('fails the whole read, as one line naming the permission, when a page fails', async () => {
    const gh = new FakeGh().answers(REPO, { end: { kind: 'exited', code: 1 }, stdout: '', stderr: 'gh: Resource not accessible by integration (HTTP 403)\n' });
    const read = await readPosts(gh, TOKEN, REPO, SINCE);
    assert.equal(read.kind, 'failed');
    assert.match(read.kind === 'failed' ? read.reason : '', /issue comments of acme\/web/);
  });

  it('fails when gh prints no list', async () => {
    const gh = new FakeGh().answers(REPO, { end: { kind: 'exited', code: 0 }, stdout: '{"message":"x"}', stderr: '' });
    const read = await readPosts(gh, TOKEN, REPO, SINCE);
    assert.deepEqual(read, { kind: 'failed', reason: 'gh printed no list of the issue comments of acme/web' });
  });

  it('counts an item that does not read as a post and leaves it out', async () => {
    const gh = new FakeGh().holdsPosts(REPO, 'issues/comments', [{ id: 1, updated_at: LATER }, restComment(REPO, 2, 3, { updatedAt: LATER })]);
    const read = await readPosts(gh, TOKEN, REPO, SINCE);
    assert.deepEqual(read.kind === 'read' ? [read.posts.length, read.unreadable] : [], [1, 1]);
  });
});

describe('postOf', () => {
  it('keys a post by its kind and id, stable across edits, and reads a deleted account as ghost and no body as empty', () => {
    assert.deepEqual(postOf('issues/comments', restComment(REPO, 7, 99, { author: null, body: null })), {
      key: 'comment:99',
      number: 7,
      url: 'https://github.com/acme/web/issues/7#issuecomment-99',
      author: 'ghost',
      text: '',
      updatedAt: '2030-01-10T00:00:00Z',
    });
    assert.equal(postOf('pulls/comments', restReviewComment(REPO, 8, 5))?.key, 'review-comment:5');
    assert.equal(postOf('issues', restIssue(REPO, 9))?.key, 'body:9');
  });

  it('is none without a number, a web link or a time', () => {
    assert.equal(postOf('issues/comments', { ...restComment(REPO, 7, 1), issue_url: 'https://api.github.com/repos/acme/web/issues/x' }), undefined);
    assert.equal(postOf('issues/comments', { ...restComment(REPO, 7, 1), html_url: 'javascript:alert(1)' }), undefined);
    assert.equal(postOf('issues', { ...restIssue(REPO, 7), updated_at: 'never' }), undefined);
    assert.equal(postOf('issues', 'text'), undefined);
  });
});

describe('reviewOf', () => {
  it('reads a submitted review by its submit time, a pending one as null', () => {
    assert.equal(reviewOf(4, restReview(REPO, 4, 1, { updatedAt: LATER }))?.updatedAt, LATER);
    assert.equal(reviewOf(4, restReview(REPO, 4, 1, { state: 'PENDING' })), null);
    assert.equal(reviewOf(4, 7), undefined);
  });
});
