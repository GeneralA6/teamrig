import {
  isRecord,
  MENTION_PAGE_SIZE,
  MENTION_PAGES_MAX,
  numberField,
  recordField,
  REVIEW_READS_MAX,
  stringField,
  type HostPost,
  type JsonRecord,
} from '../../../plugin-api/index.ts';
import { MENTION_LISTS, mentionListArgs, reviewListArgs, type GhRunner, type MentionList } from './gh.ts';
import { loginOf, runRead, timeField, WEB_URL, type ReadKind } from './issues.ts';
import type { RepoAccess } from './tokens.ts';

/**
 * The mention scan's read of a repository: every comment, inline review comment, issue and pull request body written
 * or edited since a time, and the reviews of the pull requests among them, through gh's REST reads (gh.ts allows each
 * shape exactly). Unlike the shipped GraphQL reads, this one reads post text, which is outside input: it is kept as
 * data for the match (mentions.ts) and never run.
 */

const POST_READ: Readonly<Record<MentionList | 'reviews', ReadKind>> = {
  'issues/comments': { noun: 'issue comments', permission: 'Issues', command: 'gh api' },
  'pulls/comments': { noun: 'pull request review comments', permission: 'Pull requests', command: 'gh api' },
  issues: { noun: 'issues', permission: 'Issues', command: 'gh api' },
  reviews: { noun: 'pull request reviews', permission: 'Pull requests', command: 'gh api' },
};

/** The posts of a repository changed since a time, oldest change first in each list, or the line saying why gh could not read them. */
export type PostRead =
  | {
      readonly kind: 'read';
      readonly posts: readonly HostPost[];
      /**
       * Undefined when every list was read to its end. Else the time every list is read through: a list that stopped at
       * MENTION_PAGES_MAX pages, or the reviews past REVIEW_READS_MAX pull requests, leave the rest from it on unread.
       */
      readonly cutAt: string | undefined;
      /** Items GitHub sent that do not read as posts (no number, link or time): left out and counted. */
      readonly unreadable: number;
    }
  | { readonly kind: 'failed'; readonly reason: string };

/**
 * Reads the posts of `repo` changed at or after `since` (MENTION_SINCE's whole-second UTC form) as `access` reads it.
 * Any page failing fails the whole read, as one line, so the cursor never moves past what was not read.
 */
export async function readPosts(gh: GhRunner, access: RepoAccess, repo: string, since: string): Promise<PostRead> {
  const posts: HostPost[] = [];
  const cuts: string[] = [];
  const moved: { readonly number: number; readonly updatedAt: string }[] = [];
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
      } else if (review !== null && Date.parse(review.updatedAt) >= Date.parse(since)) {
        posts.push(review);
      }
    }
  }
  const cutAt = cuts.sort()[0];
  return { kind: 'read', posts, cutAt, unreadable };
}

/** The items of a REST list answer, or undefined when gh printed something else. */
function itemsIn(stdout: string): unknown[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  return Array.isArray(parsed) ? parsed : undefined;
}

/** The number at the end of an `.../issues/<n>` or `.../pulls/<n>` API link. */
const ITEM_LINK = /\/(?:issues|pulls)\/([1-9][0-9]{0,9})$/;

/** One list item as a post, or undefined when it lacks its id, number, link or time. An empty body has no mention, but is kept as a post. */
export function postOf(list: MentionList, item: unknown): HostPost | undefined {
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
export function reviewOf(number: number, item: unknown): HostPost | null | undefined {
  if (!isRecord(item)) {
    return undefined;
  }
  if (stringField(item, 'state') === 'PENDING') {
    return null;
  }
  const id = numberField(item, 'id');
  return withPost(item, number, id === undefined ? undefined : `review:${id}`, timeField(item, 'submitted_at'));
}

function withPost(item: JsonRecord, number: number | undefined, key: string | undefined, updatedAt: string | undefined): HostPost | undefined {
  const url = stringField(item, 'html_url');
  if (number === undefined || key === undefined || updatedAt === undefined || url === undefined || !WEB_URL.test(url)) {
    return undefined;
  }
  return { key, number, url, author: loginOf(recordField(item, 'user')) || 'ghost', text: stringField(item, 'body') ?? '', updatedAt };
}

function linkNumber(item: JsonRecord, field: string): number | undefined {
  const match = ITEM_LINK.exec(stringField(item, field) ?? '');
  return match === null ? undefined : Number(match[1]);
}
