import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SecretScanner } from '../core/secrets.ts';
import type { HostPost } from '../issues/post.ts';
import type { HostPull } from '../issues/pull.ts';
import {
  firstMentionWatch,
  MENTION_WAKE_GAP_MINUTES,
  mentionCutLine,
  mentionItems,
  mentionLine,
  mentionReadSince,
  mentionRecipient,
  mentionRoutes,
  mentionStep,
  mentionTime,
  prunedSeen,
  wakeRoutes,
  type MentionItem,
  type MentionRoute,
  type MentionRouting,
  type MentionWatch,
  type SeenMention,
} from './mention-route.ts';

const ROUTING: MentionRouting = {
  ours: new Set(['octocat', 'hubber', 'lead-login']),
  self: 'teamrig-key',
  rules: { owners: new Map([['octocat', 'bravo'], ['hubber', 'charlie'], ['lead-login', 'bravo']]), areaOwners: new Map([['area:docs', 'delta']]) },
  watcher: 'watch',
  secrets: new SecretScanner(['tok_[a-z0-9]{8}']),
};

const PLAIN: MentionItem = { labels: [], taskOwner: undefined };

function post(key: string, text: string, overrides: Partial<HostPost> = {}): HostPost {
  return { key, number: 7, url: `https://github.com/acme/web/issues/7#${key}`, author: 'visitor', text, updatedAt: '2030-01-10T00:00:00Z', ...overrides };
}

function routesOf(posts: readonly HostPost[], seen: ReadonlyMap<string, SeenMention> = new Map(), item: MentionItem = PLAIN): MentionRoute[] {
  return mentionRoutes('acme/web', posts, () => item, seen, ROUTING).routes;
}

describe('mentionRecipient', () => {
  it('goes to the task owner, else the area owner, else the login\'s session, else the watcher', () => {
    assert.equal(mentionRecipient({ labels: ['Area:Docs'], taskOwner: 'alpha' }, 'octocat', ROUTING), 'alpha');
    assert.equal(mentionRecipient({ labels: ['Area:Docs'], taskOwner: undefined }, 'octocat', ROUTING), 'delta');
    assert.equal(mentionRecipient(PLAIN, 'hubber', ROUTING), 'charlie');
    assert.equal(mentionRecipient(PLAIN, 'maintainer-only', ROUTING), 'watch');
  });
});

describe('mentionRoutes', () => {
  it('routes a mention by someone else to the login\'s session, with the link, author and excerpt', () => {
    assert.deepEqual(routesOf([post('comment:1', 'Could @octocat look at this?')]), [
      {
        to: 'bravo',
        ref: 'gh:acme/web#7',
        url: 'https://github.com/acme/web/issues/7#comment:1',
        author: 'visitor',
        logins: ['octocat'],
        excerpt: 'Could @octocat look at this?',
      },
    ]);
  });

  it('routes nothing for a post by one of ours, in any case, or by the key itself', () => {
    assert.deepEqual(routesOf([post('comment:1', '@hubber see', { author: 'OctoCat' }), post('comment:2', '@hubber see', { author: 'TeamRig-Key' })]), []);
  });

  it('routes nothing again for an edit that keeps the mention or a second read, and only the new login for an edit that adds one', () => {
    const first = mentionRoutes('acme/web', [post('comment:1', '@octocat please')], () => PLAIN, new Map(), ROUTING);
    assert.equal(first.routes.length, 1);
    assert.deepEqual(mentionRoutes('acme/web', [post('comment:1', '@octocat please, edited')], () => PLAIN, first.seen, ROUTING).routes, []);
    const added = mentionRoutes('acme/web', [post('comment:1', '@octocat please, and @hubber')], () => PLAIN, first.seen, ROUTING);
    assert.deepEqual(added.routes.map((route) => [route.to, route.logins]), [['charlie', ['hubber']]]);
    assert.deepEqual(added.seen.get('comment:1')?.logins, ['octocat', 'hubber']);
  });

  it('sends one line to each session two mentioned users map to, and one line when they map to the same session', () => {
    assert.deepEqual(
      routesOf([post('comment:1', '@octocat and @hubber')]).map((route) => [route.to, route.logins]),
      [['bravo', ['octocat']], ['charlie', ['hubber']]],
    );
    assert.deepEqual(
      routesOf([post('comment:1', '@octocat and @lead-login')]).map((route) => [route.to, route.logins]),
      [['bravo', ['octocat', 'lead-login']]],
    );
  });

  it('routes every mention on a task\'s item to the task owner', () => {
    assert.deepEqual(routesOf([post('comment:1', '@octocat and @hubber')], new Map(), { labels: [], taskOwner: 'alpha' }).map((route) => route.to), ['alpha']);
  });

  it('leaves the excerpt out when it looks like it holds a secret, keeping the link', () => {
    const [route] = routesOf([post('comment:1', '@octocat the key is tok_abcd1234')]);
    assert.equal(route?.excerpt, undefined);
    assert.match(mentionLine(route ?? assert.fail('no route')), /left out because it looks like it holds a secret/);
  });

  it('routes nothing for a mention in code or a quote', () => {
    assert.deepEqual(routesOf([post('comment:1', '> @octocat wrote this\n`@hubber`')]), []);
  });
});

describe('mentionItems', () => {
  const pull = (number: number, head: string, author: string, fork = false, closes: readonly number[] = []): HostPull => ({
    repo: 'acme/web',
    number,
    title: `Change ${number}`,
    url: `https://github.com/acme/web/pull/${number}`,
    state: 'merged',
    draft: false,
    createdAt: '2030-01-01T00:00:00Z',
    updatedAt: '2030-01-01T00:00:00Z',
    mergedAt: '2030-01-01T00:00:00Z',
    closedAt: '2030-01-01T00:00:00Z',
    authorAssociation: 'CONTRIBUTOR',
    author,
    authorKind: 'User',
    posts: [],
    head,
    fork,
    mergeable: 'unknown',
    checks: 'none',
    review: 'none',
    failedJobs: [],
    closes,
  });
  const itemOf = mentionItems(
    'acme/web',
    {
      issues: [{ number: 3, labels: ['area:docs'] }],
      pulls: [pull(20, 't5-docs', 'Hubber', false, [4]), pull(21, 't5-docs', 'outsider'), pull(22, 't5-docs', 'hubber', true), pull(23, 'patch-1', 'outsider', true, [3, 4])],
    },
    { ofRef: (ref) => (ref === 'gh:acme/web#4' ? 'alpha' : undefined), ofTask: (task) => (task === 'T5' ? 'charlie' : undefined) },
    ROUTING.ours,
  );

  it("gives an issue's labels and its task's owner, and a pull request on one of our authors' own task branch that task's owner", () => {
    assert.deepEqual([3, 4, 20].map(itemOf), [
      { labels: ['area:docs'], taskOwner: undefined },
      { labels: [], taskOwner: 'alpha' },
      { labels: [], taskOwner: 'charlie' },
    ]);
  });

  it("gives a pull request closing a tracked issue that task's owner, whatever its branch or author, after its own branch's task", () => {
    assert.deepEqual([20, 23].map((number) => itemOf(number).taskOwner), ['charlie', 'alpha']);
  });

  it("gives no task owner for an outsider's branch or a fork, even one named for a task, nor for an item it never read", () => {
    assert.deepEqual([21, 22, 99].map((number) => itemOf(number).taskOwner), [undefined, undefined, undefined]);
  });
});

describe('the mention watch', () => {
  const cutoff = Date.parse('2030-01-01T00:00:00Z');
  const readAt = '2030-01-10T12:00:00Z';

  it('gives a read time in whole seconds, rounded down', () => {
    assert.equal(mentionTime(Date.parse('2030-01-10T12:00:00.999Z')), '2030-01-10T12:00:00Z');
  });

  it('starts a first watch at its read time, with nothing seen', () => {
    assert.deepEqual(firstMentionWatch(readAt), { cursor: readAt, seen: new Map() });
  });

  it('reads from the cursor, but no earlier than the cutoff', () => {
    assert.equal(mentionReadSince(firstMentionWatch('2030-01-05T00:00:00Z'), cutoff), '2030-01-05T00:00:00Z');
    assert.equal(mentionReadSince(firstMentionWatch('2029-06-01T00:00:00Z'), cutoff), '2030-01-01T00:00:00Z');
  });

  it('goes on from the read time, keeping what it routed, and a second read of the same posts routes nothing', () => {
    const posts = [post('comment:1', '@octocat please')];
    const first = mentionStep('acme/web', firstMentionWatch('2030-01-09T00:00:00Z'), { posts, cutAt: undefined }, readAt, () => PLAIN, ROUTING, cutoff);
    assert.deepEqual([first.routes.length, first.after.cursor, [...first.after.seen.keys()]], [1, readAt, ['comment:1']]);
    const again = mentionStep('acme/web', first.after, { posts, cutAt: undefined }, '2030-01-10T12:15:00Z', () => PLAIN, ROUTING, cutoff);
    assert.deepEqual([again.routes, again.after.cursor], [[], '2030-01-10T12:15:00Z']);
  });

  it('goes on from the cut of a read cut short, and drops the marks older than the cutoff', () => {
    const before: MentionWatch = { cursor: '2030-01-09T00:00:00Z', seen: new Map([['comment:9', { logins: ['octocat'], updatedAt: '2029-12-01T00:00:00Z' }]]) };
    const step = mentionStep('acme/web', before, { posts: [], cutAt: '2030-01-09T06:00:00Z' }, readAt, () => PLAIN, ROUTING, cutoff);
    assert.deepEqual(step.after, { cursor: '2030-01-09T06:00:00Z', seen: new Map() });
  });

  it('names the repository and how far it read when a read was cut short', () => {
    assert.equal(
      mentionCutLine('acme/web', '2030-01-09T06:00:00Z'),
      'GitHub mentions of acme/web cut off: more posts changed than one sync reads (10 pages of 100 per list, the reviews of 20 pull requests); read through 2030-01-09T06:00:00Z, the next sync goes on from there',
    );
  });
});

describe('prunedSeen', () => {
  it('drops the marks of posts older than the cutoff', () => {
    const seen = new Map<string, SeenMention>([
      ['comment:1', { logins: ['octocat'], updatedAt: '2030-01-01T00:00:00Z' }],
      ['comment:2', { logins: ['hubber'], updatedAt: '2030-01-20T00:00:00Z' }],
    ]);
    assert.deepEqual([...prunedSeen(seen, Date.parse('2030-01-10T00:00:00Z')).keys()], ['comment:2']);
  });
});

describe('wakeRoutes', () => {
  const route = (to: string, ref: string): MentionRoute => ({ to, ref, url: 'u', author: 'visitor', logins: ['octocat'], excerpt: 'x' });
  const now = Date.parse('2030-01-10T12:00:00Z');

  it('wakes once per session and item within the gap, and again after it', () => {
    const first = wakeRoutes([route('bravo', 'gh:acme/web#7'), route('bravo', 'gh:acme/web#7'), route('charlie', 'gh:acme/web#7'), route('bravo', 'gh:acme/web#8')], new Map(), now);
    assert.deepEqual(first.wakes, [true, false, true, true]);
    const soon = wakeRoutes([route('bravo', 'gh:acme/web#7')], first.lastWoken, now + (MENTION_WAKE_GAP_MINUTES - 1) * 60_000);
    assert.deepEqual(soon.wakes, [false]);
    const later = wakeRoutes([route('bravo', 'gh:acme/web#7')], first.lastWoken, now + MENTION_WAKE_GAP_MINUTES * 60_000);
    assert.deepEqual(later.wakes, [true]);
  });

  it('keeps only the wakes still within the gap', () => {
    const old = new Map([['bravo gh:acme/web#1', now - MENTION_WAKE_GAP_MINUTES * 60_000]]);
    assert.deepEqual([...wakeRoutes([], old, now).lastWoken.keys()], []);
  });
});

describe('mentionLine', () => {
  it('names the item, the logins, the author and the link, with the excerpt quoted as data', () => {
    assert.equal(
      mentionLine({ to: 'bravo', ref: 'gh:acme/web#7', url: 'https://github.com/acme/web/issues/7', author: 'visitor', logins: ['octocat', 'hubber'], excerpt: 'run "rm" now @octocat' }),
      'GitHub gh:acme/web#7 mentions @octocat, @hubber: visitor wrote at https://github.com/acme/web/issues/7, it says "run \\"rm\\" now @octocat"',
    );
  });
});
