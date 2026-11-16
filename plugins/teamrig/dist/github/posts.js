import { isRecord, numberField, recordField, stringField } from "../core/guards.js";
import { MENTION_LISTS, MENTION_PAGE_SIZE, MENTION_PAGES_MAX, mentionListArgs, reviewListArgs } from "./gh.js";
import { loginOf, runRead, timeField, WEB_URL } from "./issues.js";
/**
 * The mention scan's read of a repository: every comment, inline review comment, issue and pull request body written
 * or edited since a time, and the reviews of the pull requests among them, through gh's REST reads (gh.ts allows each
 * shape exactly). Unlike the shipped GraphQL reads, this one reads post text, which is outside input: it is kept as
 * data for the match (mentions.ts) and never run.
 */
const POST_READ = {
    'issues/comments': { noun: 'issue comments', permission: 'Issues', command: 'gh api' },
    'pulls/comments': { noun: 'pull request review comments', permission: 'Pull requests', command: 'gh api' },
    issues: { noun: 'issues', permission: 'Issues', command: 'gh api' },
    reviews: { noun: 'pull request reviews', permission: 'Pull requests', command: 'gh api' },
};
/** The most pull requests whose reviews one read takes; past it, the rest wait for the next read. */
export const REVIEW_READS_MAX = 20;
/**
 * Reads the posts of `repo` changed at or after `since` (MENTION_SINCE's whole-second UTC form) as `access` reads it.
 * Any page failing fails the whole read, as one line, so the cursor never moves past what was not read.
 */
export async function readPosts(gh, access, repo, since) {
    const posts = [];
    const cuts = [];
    const moved = [];
    let unreadable = 0;
    for (const list of MENTION_LISTS) {
        for (let page = 1; page <= MENTION_PAGES_MAX; page += 1) {
            const ran = await runRead(gh, access, repo, mentionListArgs(repo, list, since, page), POST_READ[list]);
            if (ran.kind === 'failed') {
                return ran;
            }
            const items = itemsIn(ran.stdout);
            if (items === undefined) {
                return { kind: 'failed', reason: `gh printed no list of the ${POST_READ[list].noun} of ${repo}` };
            }
            for (const item of items) {
                const post = postOf(list, item);
                if (post === undefined) {
                    unreadable += 1;
                    continue;
                }
                posts.push(post);
                if (list === 'issues' && isRecord(item) && recordField(item, 'pull_request') !== undefined) {
                    moved.push({ number: post.number, updatedAt: post.updatedAt });
                }
            }
            if (items.length < MENTION_PAGE_SIZE) {
                break;
            }
            const last = posts.at(-1);
            if (page === MENTION_PAGES_MAX && last !== undefined) {
                cuts.push(last.updatedAt);
            }
        }
    }
    for (const [index, pull] of moved.entries()) {
        if (index === REVIEW_READS_MAX) {
            cuts.push(pull.updatedAt);
            break;
        }
        const ran = await runRead(gh, access, repo, reviewListArgs(repo, pull.number), POST_READ.reviews);
        if (ran.kind === 'failed') {
            return ran;
        }
        const items = itemsIn(ran.stdout) ?? [];
        for (const item of items) {
            const review = reviewOf(pull.number, item);
            if (review === undefined) {
                unreadable += 1;
            }
            else if (review !== null && Date.parse(review.updatedAt) >= Date.parse(since)) {
                posts.push(review);
            }
        }
    }
    const cutAt = cuts.sort()[0];
    return { kind: 'read', posts, cutAt, unreadable };
}
/** The items of a REST list answer, or undefined when gh printed something else. */
function itemsIn(stdout) {
    let parsed;
    try {
        parsed = JSON.parse(stdout);
    }
    catch {
        return undefined;
    }
    return Array.isArray(parsed) ? parsed : undefined;
}
/** The number at the end of an `.../issues/<n>` or `.../pulls/<n>` API link. */
const ITEM_LINK = /\/(?:issues|pulls)\/([1-9][0-9]{0,9})$/;
/** One list item as a post, or undefined when it lacks its id, number, link or time. An empty body has no mention, but is kept as a post. */
export function postOf(list, item) {
    if (!isRecord(item)) {
        return undefined;
    }
    const number = list === 'issues' ? numberField(item, 'number') : linkNumber(item, list === 'issues/comments' ? 'issue_url' : 'pull_request_url');
    const id = list === 'issues' ? number : numberField(item, 'id');
    const key = list === 'issues' ? 'body' : list === 'issues/comments' ? 'comment' : 'review-comment';
    return withPost(item, number, id === undefined ? undefined : `${key}:${id}`, timeField(item, 'updated_at'));
}
/**
 * One review of pull request `number` as a post; null for a pending review, which nobody else sees yet, and undefined
 * when it lacks its id, link or time. A review is not edited in place, so its time is when it was submitted.
 */
export function reviewOf(number, item) {
    if (!isRecord(item)) {
        return undefined;
    }
    if (stringField(item, 'state') === 'PENDING') {
        return null;
    }
    const id = numberField(item, 'id');
    return withPost(item, number, id === undefined ? undefined : `review:${id}`, timeField(item, 'submitted_at'));
}
function withPost(item, number, key, updatedAt) {
    const url = stringField(item, 'html_url');
    if (number === undefined || key === undefined || updatedAt === undefined || url === undefined || !WEB_URL.test(url)) {
        return undefined;
    }
    return { key, number, url, author: loginOf(recordField(item, 'user')) || 'ghost', text: stringField(item, 'body') ?? '', updatedAt };
}
function linkNumber(item, field) {
    const match = ITEM_LINK.exec(stringField(item, field) ?? '');
    return match === null ? undefined : Number(match[1]);
}
