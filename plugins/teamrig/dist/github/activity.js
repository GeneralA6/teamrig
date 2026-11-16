import { issueRef } from "./map.js";
import { visibleText } from "./mentions.js";
/** The post key prefixes the activity tells, and what each is; an item's own body (`body:<n>`) is no activity. */
const KIND_OF_PREFIX = new Map([
    ['comment:', 'comment'],
    ['review-comment:', 'review comment'],
    ['review:', 'review'],
]);
/** What a post with `key` is, or undefined for an item's body. */
export function activityKind(key) {
    return [...KIND_OF_PREFIX].find(([prefix]) => key.startsWith(prefix))?.[1];
}
/**
 * The routes of a repository's posts read this run, and the marks to add to its seen marks. A post seen before (in
 * `seen`, as a mention or as activity), an item's body, and a post by one of ours or the key itself route nothing;
 * nor does a post to a session its mention already reached this run (`mentioned`). The task owner of an item who
 * follows it too hears it once, as its owner.
 */
export function activityRoutes(repo, posts, seen, audienceOf, mentioned, routing) {
    const told = new Set(mentioned.map((route) => `${route.to} ${route.url}`));
    const self = routing.self?.toLowerCase();
    const routes = [];
    const marks = new Map();
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
export function isQuestion(text) {
    return visibleText(text).includes('?');
}
/** The posts one inbox line names; the rest are counted. */
const NAMED_POSTS = 8;
/** Each session's routes, in the order first seen. */
export function routesBySession(routes) {
    const bySession = new Map();
    for (const route of routes) {
        bySession.set(route.to, [...(bySession.get(route.to) ?? []), route]);
    }
    return bySession;
}
/**
 * One session's line for its routes: each post's item, what it is, who wrote it and its link, at most NAMED_POSTS
 * named and the rest counted. The text of a post never goes in it, only the link: a session reads it there.
 */
export function activityLine(routes) {
    const named = routes.slice(0, NAMED_POSTS).map((route) => `${route.ref} ${route.kind} by ${route.author === '' ? 'a deleted account' : route.author}${route.wake ? ' (asks a question)' : ''} at ${route.url}`);
    const more = routes.length - named.length;
    return `GitHub activity: ${named.join('; ')}${more > 0 ? `; and ${more} more` : ''}`;
}
