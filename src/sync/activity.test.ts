import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { HostPost } from '../issues/post.ts';
import { activityKind, activityLine, activityRoutes, isQuestion, routesBySession, type ActivityAudience, type ActivityRoute, type ActivityRouting } from './activity.ts';

const ROUTING: ActivityRouting = { ours: new Set(['octocat']), self: 'teamrig-key' };
const HELD: ActivityAudience = { owner: 'alpha', followers: [] };
const NOBODY: ActivityAudience = { owner: undefined, followers: [] };

function post(key: string, text: string, overrides: Partial<HostPost> = {}): HostPost {
  return { key, number: 7, url: `https://github.com/acme/web/issues/7#${key}`, author: 'visitor', text, updatedAt: '2030-01-10T00:00:00Z', ...overrides };
}

function route(to: string, key: string, overrides: Partial<ActivityRoute> = {}): ActivityRoute {
  return { to, ref: 'gh:acme/web#7', url: `https://github.com/acme/web/issues/7#${key}`, author: 'visitor', kind: 'comment', wake: false, ...overrides };
}

describe('activityKind', () => {
  it('names a comment, a review comment and a review, and no item body', () => {
    assert.equal(activityKind('comment:1'), 'comment');
    assert.equal(activityKind('review-comment:2'), 'review comment');
    assert.equal(activityKind('review:3'), 'review');
    assert.equal(activityKind('body:7'), undefined);
  });
});

describe('isQuestion', () => {
  it('reads a question mark in the text, not one in code', () => {
    assert.equal(isQuestion('Is this ready?'), true);
    assert.equal(isQuestion('Looks good.'), false);
    assert.equal(isQuestion('Run it:\n```\nwhy?\n```\nDone.'), false);
  });
});

describe('activityRoutes', () => {
  it('tells a new post on a held item to its owner, waking it for a question, and marks it seen', () => {
    const { routes, marks } = activityRoutes('acme/web', [post('comment:1', 'Is this ready?'), post('review:2', 'Fine.')], new Map(), () => HELD, [], ROUTING);
    assert.deepEqual(routes, [route('alpha', 'comment:1', { wake: true }), route('alpha', 'review:2', { kind: 'review' })]);
    assert.deepEqual(marks, new Map([
      ['comment:1', { logins: [], updatedAt: '2030-01-10T00:00:00Z' }],
      ['review:2', { logins: [], updatedAt: '2030-01-10T00:00:00Z' }],
    ]));
  });

  it('tells followers without waking them, and an owner who follows too once', () => {
    const audience: ActivityAudience = { owner: 'alpha', followers: ['alpha', 'bravo'] };
    const { routes } = activityRoutes('acme/web', [post('comment:1', 'Why?')], new Map(), () => audience, [], ROUTING);
    assert.deepEqual(routes, [route('alpha', 'comment:1', { wake: true }), route('bravo', 'comment:1')]);
  });

  it('tells nothing seen before, an item body, a post by one of ours or the key, or of an item nobody holds or follows', () => {
    const seen = new Map([['comment:1', { logins: ['octocat'], updatedAt: '2030-01-10T00:00:00Z' }]]);
    const posts = [post('comment:1', 'edited'), post('body:7', 'the issue'), post('comment:2', 'ours', { author: 'OctoCat' }), post('comment:3', 'key', { author: 'teamrig-key' })];
    assert.deepEqual(activityRoutes('acme/web', posts, seen, () => HELD, [], ROUTING), { routes: [], marks: new Map() });
    assert.deepEqual(activityRoutes('acme/web', [post('comment:4', 'hello')], new Map(), () => NOBODY, [], ROUTING), { routes: [], marks: new Map() });
  });

  it('skips a session the post\'s mention already reached this run, and still tells the others', () => {
    const audience: ActivityAudience = { owner: 'alpha', followers: ['bravo'] };
    const comment = post('comment:1', '@octocat can you look?');
    const { routes, marks } = activityRoutes('acme/web', [comment], new Map(), () => audience, [{ to: 'alpha', url: comment.url }], ROUTING);
    assert.deepEqual(routes, [route('bravo', 'comment:1')]);
    assert.equal(marks.has('comment:1'), true);
    assert.deepEqual(activityRoutes('acme/web', [comment], new Map(), () => HELD, [{ to: 'alpha', url: comment.url }], ROUTING), { routes: [], marks: new Map() });
  });
});

describe('activityLine and routesBySession', () => {
  it('groups by session in the order first seen', () => {
    const routes = [route('alpha', 'comment:1'), route('bravo', 'comment:1'), route('alpha', 'review:2', { kind: 'review' })];
    assert.deepEqual([...routesBySession(routes).keys()], ['alpha', 'bravo']);
    assert.deepEqual(routesBySession(routes).get('alpha'), [routes[0], routes[2]]);
  });

  it('names each post with its link and counts those past the eighth', () => {
    assert.equal(
      activityLine([route('alpha', 'comment:1', { wake: true }), route('alpha', 'review:2', { kind: 'review', author: '' })]),
      'GitHub activity: gh:acme/web#7 comment by visitor (asks a question) at https://github.com/acme/web/issues/7#comment:1; gh:acme/web#7 review by a deleted account at https://github.com/acme/web/issues/7#review:2',
    );
    const many = Array.from({ length: 10 }, (_, index) => route('alpha', `comment:${index}`));
    assert.match(activityLine(many), /comment:7; and 2 more$/);
  });
});
