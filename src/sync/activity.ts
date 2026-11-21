import type { HostPost } from '../issues/post.ts';
import { issueRef } from './map.ts';
import type { MentionRoute, SeenMention } from './mention-route.ts';
import { visibleText } from './mentions.ts';
import type { OurLogins } from './trust.ts';

/**
 * Where the activity on an issue or pull request goes, kept pure: every new comment, inline review comment or review
 * on an item a task holds goes to the task's owner, and on an item a session follows (follows.ts) to that session
 * (`activityRoutes`), one inbox line per session per run (`activityLines`). A question on a task's item wakes its
 * owner; the rest, and everything a follower hears, wait for the session's next turn. Posts are told once: the seen
 * marks the mention scan keeps (mention-route.ts) hold them, a mark with no logins standing for a post only told.
 */

/** What a post is, in the line that tells it. */
export type ActivityKind = 'comment' | 'review comment' | 'review';

/** The post key prefixes the activity tells, and what each is; an item's own body (`body:<n>`) is no activity. */
const KIND_OF_PREFIX: ReadonlyMap<string, ActivityKind> = new Map([
  ['comment:', 'comment'],
  ['review-comment:', 'review comment'],
  ['review:', 'review'],
]);

/** What a post with `key` is, or undefined for an item's body. */
export function activityKind(key: string): ActivityKind | undefined {
  return [...KIND_OF_PREFIX].find(([prefix]) => key.startsWith(prefix))?.[1];
}

/** Who hears of an item's activity: the owner of the task holding it, and the sessions following it. */
export interface ActivityAudience {
  readonly owner: string | undefined;
  readonly followers: readonly string[];
}

/** The logins whose posts are never told back: ours and the GitHub key's own (mention-route.ts). */
export interface ActivityRouting {
  readonly ours: OurLogins;
  readonly self: string | undefined;
}

/** One post told to one session. */
export interface ActivityRoute {
  readonly to: string;
  readonly ref: string;
  readonly url: string;
  readonly author: string;
  readonly kind: ActivityKind;
  /** It wakes its session: a question on the item of a task the session owns. */
  readonly wake: boolean;
}

/**
 * The routes of a repository's posts read this run, and the marks to add to its seen marks. A post seen before (in
 * `seen`, as a mention or as activity), an item's body, and a post by one of ours or the key itself route nothing;
 * nor does a post to a session its mention already reached this run (`mentioned`). The task owner of an item who
 * follows it too hears it once, as its owner.
 */
export function activityRoutes(
  repo: string,
  posts: readonly HostPost[],
  seen: ReadonlyMap<string, SeenMention>,
  audienceOf: (number: number) => ActivityAudience,
  mentioned: readonly Pick<MentionRoute, 'to' | 'url'>[],
  routing: ActivityRouting,
): { readonly routes: ActivityRoute[]; readonly marks: Map<string, SeenMention> } {
  const told = new Set(mentioned.map((route) => `${route.to} ${route.url}`));
  const self = routing.self?.toLowerCase();
  const routes: ActivityRoute[] = [];
  const marks = new Map<string, SeenMention>();
  for (const post of posts) {
    const kind = activityKind(post.key);
    const author = post.author.toLowerCase();
    if (kind === undefined || seen.has(post.key) || routing.ours.has(author) || author === self) {
      continue;
    }
    const { owner, followers } = audienceOf(post.number);
    const sessions = [...new Set([...(owner === undefined ? [] : [owner]), ...followers])].filter((to) => !told.has(`${to} ${post.url}`));
    if (sessions.length === 0) {
      continue;
    }
    marks.set(post.key, { logins: [], updatedAt: post.updatedAt });
    const question = isQuestion(post.text);
    const ref = issueRef(repo, post.number);
    routes.push(...sessions.map((to) => ({ to, ref, url: post.url, author: post.author, kind, wake: question && to === owner })));
  }
  return { routes, marks };
}

/** Whether a post asks something: a question mark in its text outside quotes and code (mentions.ts). */
export function isQuestion(text: string): boolean {
  return visibleText(text).includes('?');
}

/** The posts one inbox line names; the rest are counted. */
const NAMED_POSTS = 8;

/** Each session's routes, in the order first seen. */
export function routesBySession(routes: readonly ActivityRoute[]): Map<string, ActivityRoute[]> {
  const bySession = new Map<string, ActivityRoute[]>();
  for (const route of routes) {
    bySession.set(route.to, [...(bySession.get(route.to) ?? []), route]);
  }
  return bySession;
}

/**
 * One session's line for its routes: each post's item, what it is, who wrote it and its link, at most NAMED_POSTS
 * named and the rest counted. The text of a post never goes in it, only the link: a session reads it there.
 */
export function activityLine(routes: readonly ActivityRoute[]): string {
  const named = routes.slice(0, NAMED_POSTS).map((route) => `${route.ref} ${route.kind} by ${route.author === '' ? 'a deleted account' : route.author}${route.wake ? ' (asks a question)' : ''} at ${route.url}`);
  const more = routes.length - named.length;
  return `GitHub activity: ${named.join('; ')}${more > 0 ? `; and ${more} more` : ''}`;
}
