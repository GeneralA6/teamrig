import { isRecord, recordField, stringField, type JsonRecord } from '../core/guards.ts';
import type { IssueComment } from '../issues/issue.ts';
import type { FailedJob, HostPull, PullChecks, PullMergeable, PullReview, PullState } from '../issues/pull.ts';
import type { GhRunner } from './gh.ts';
import { connectionPage, kindOf, loginOf, nodesOf, plainLine, postOf, repoPage, runRead, timeField, WEB_URL, type ReadKind } from './issues.ts';
import { pullPageArgs, type PullRead } from './queries.ts';
import type { RepoAccess } from './tokens.ts';

/** How a failed pull request read is worded, and the permission a fine-grained token needs for it. */
export const PULL_READ: ReadKind = { noun: 'pull requests', permission: 'Pull requests', command: 'gh api graphql' };

/** The most pull requests one read takes before it stops asking for pages; a read stopped with more on GitHub says so. */
export const PULL_LIMIT = 200;

/** One read of a repository's pull requests, the open ones or those in any state, changed at or after `since` (an ISO time), at most `limit`. */
export interface PullListRequest {
  /** `owner/name`. */
  readonly repo: string;
  readonly read: PullRead;
  /** Undefined reads from the newest change on until `limit`. */
  readonly since: string | undefined;
  readonly limit: number;
}

/** A repository's pull requests changed since a time, newest change first, or the one line saying why gh could not read them. */
export type PullList =
  | {
      readonly kind: 'listed';
      readonly pulls: readonly HostPull[];
      /** Items GitHub sent that are not pull requests as this code reads them: left out and counted. */
      readonly unreadable: number;
      /** The read stopped at its limit while GitHub had more changed since `since`, so it left some out. */
      readonly full: boolean;
    }
  | { readonly kind: 'failed'; readonly reason: string };

/**
 * Reads the pull requests of a repository through gh, as `access` reads it, the most recently changed first: page after
 * page until one changed before `since`, the end, or `limit` items. Any page failing fails the read, as one line.
 */
export async function listPulls(gh: GhRunner, access: RepoAccess, request: PullListRequest): Promise<PullList> {
  const pulls: HostPull[] = [];
  let unreadable = 0;
  let items = 0;
  let next: string | undefined;
  do {
    const page = repoPage(request.repo, next);
    if (page === null) {
      return { kind: 'failed', reason: `${plainLine(request.repo)} is not owner/name: check github.repos` };
    }
    const ran = await runRead(gh, access, request.repo, pullPageArgs(page, request.read), PULL_READ);
    if (ran.kind === 'failed') {
      return ran;
    }
    const read = connectionPage(ran.stdout, 'pullRequests');
    if (read === undefined) {
      return { kind: 'failed', reason: `gh printed no page of the pull requests of ${request.repo}` };
    }
    for (const item of read.nodes) {
      const pull = pullOf(item, request.repo);
      if (pull === null) {
        unreadable += 1;
      } else if (request.since !== undefined && Date.parse(pull.updatedAt) < Date.parse(request.since)) {
        // Newest change first: every item after this one changed before `since` too.
        return { kind: 'listed', pulls, unreadable, full: false };
      } else {
        pulls.push(pull);
      }
    }
    items += read.nodes.length;
    next = read.next;
    // A page with nothing on it ends the read even when GitHub says more follow, so a bad answer cannot loop.
    if (read.nodes.length === 0) {
      break;
    }
  } while (next !== undefined && items < request.limit);
  return { kind: 'listed', pulls, unreadable, full: next !== undefined };
}

const STATES: Readonly<Record<string, PullState>> = { OPEN: 'open', MERGED: 'merged', CLOSED: 'closed' };
const MERGEABLE: Readonly<Record<string, PullMergeable>> = { MERGEABLE: 'mergeable', CONFLICTING: 'conflicting', UNKNOWN: 'unknown' };
const REVIEWS: Readonly<Record<string, PullReview>> = { APPROVED: 'approved', CHANGES_REQUESTED: 'changes-requested', REVIEW_REQUIRED: 'review-required' };
/** GitHub's rollup of a commit's checks; a cancelled check run rolls up as FAILURE. */
const CHECKS: Readonly<Record<string, PullChecks>> = { SUCCESS: 'passing', FAILURE: 'failing', ERROR: 'failing', PENDING: 'pending', EXPECTED: 'pending' };

/** One pull request as the shipped query gives it; null when a field the monitor needs is missing or not what GitHub sends. */
export function pullOf(item: unknown, repo: string): HostPull | null {
  if (!isRecord(item)) {
    return null;
  }
  const number = item['number'];
  const title = stringField(item, 'title');
  const url = stringField(item, 'url');
  const state = STATES[stringField(item, 'state') ?? ''];
  const createdAt = timeField(item, 'createdAt');
  const updatedAt = timeField(item, 'updatedAt');
  const head = stringField(item, 'headRefName');
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 1 || title === undefined || url === undefined || !WEB_URL.test(url)) {
    return null;
  }
  if (state === undefined || createdAt === undefined || updatedAt === undefined || head === undefined) {
    return null;
  }
  return {
    repo,
    number,
    title,
    url,
    state,
    draft: item['isDraft'] === true,
    createdAt,
    updatedAt,
    mergedAt: timeField(item, 'mergedAt'),
    closedAt: timeField(item, 'closedAt'),
    authorAssociation: stringField(item, 'authorAssociation') ?? '',
    author: loginOf(recordField(item, 'author')),
    authorKind: kindOf(recordField(item, 'author')),
    posts: postsOf(item),
    head,
    fork: item['isCrossRepository'] === true,
    mergeable: MERGEABLE[stringField(item, 'mergeable') ?? ''] ?? 'unknown',
    checks: CHECKS[rollupStateOf(item) ?? ''] ?? 'none',
    review: REVIEWS[stringField(item, 'reviewDecision') ?? ''] ?? 'none',
    failedJobs: failedJobsOf(rollupOf(item)),
    closes: closedIssuesOf(recordField(item, 'closingIssuesReferences'), repo),
  };
}

/** The numbers of the issues of `repo` a closing-references read names; another repository's or an unreadable node is left out. */
function closedIssuesOf(references: JsonRecord | undefined, repo: string): number[] {
  const nodes = references?.['nodes'];
  const numbers: number[] = [];
  for (const node of Array.isArray(nodes) ? nodes : []) {
    const number = isRecord(node) ? node['number'] : undefined;
    const home = isRecord(node) ? stringField(recordField(node, 'repository') ?? {}, 'nameWithOwner') : undefined;
    if (typeof number === 'number' && Number.isSafeInteger(number) && number > 0 && home?.toLowerCase() === repo.toLowerCase() && !numbers.includes(number)) {
      numbers.push(number);
    }
  }
  return numbers;
}

/** Its comments and submitted reviews, oldest first; a review still pending has no time and is left out. */
function postsOf(item: JsonRecord): IssueComment[] {
  const comments = nodesOf(item['comments']).flatMap((post) => postOf(post, 'createdAt'));
  const reviews = nodesOf(item['reviews']).flatMap((post) => postOf(post, 'submittedAt'));
  return [...comments, ...reviews].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

/** How a check run ends that counts as failed: each makes the rollup fail, and each may leave a log to read. */
const FAILED_CONCLUSIONS: ReadonlySet<string> = new Set(['FAILURE', 'TIMED_OUT', 'CANCELLED', 'STARTUP_FAILURE']);

/** The failed check runs of a rollup's contexts; a status context (no id, no log) or an unreadable node is left out. */
function failedJobsOf(rollup: JsonRecord | undefined): FailedJob[] {
  const contexts = rollup === undefined ? undefined : recordField(rollup, 'contexts');
  const nodes = contexts?.['nodes'];
  const jobs: FailedJob[] = [];
  for (const node of Array.isArray(nodes) ? nodes : []) {
    if (!isRecord(node) || node['__typename'] !== 'CheckRun' || !FAILED_CONCLUSIONS.has(stringField(node, 'conclusion') ?? '')) {
      continue;
    }
    const name = stringField(node, 'name');
    const id = node['databaseId'];
    if (name !== undefined && typeof id === 'number' && Number.isSafeInteger(id) && id > 0) {
      jobs.push({ name, id });
    }
  }
  return jobs;
}

/** The check rollup state of the last commit; undefined when it has no checks. */
function rollupStateOf(item: JsonRecord): string | undefined {
  const rollup = rollupOf(item);
  return rollup === undefined ? undefined : stringField(rollup, 'state');
}

/** The check rollup of the last commit (`commits(last: 1)`); undefined when it has no checks. */
function rollupOf(item: JsonRecord): JsonRecord | undefined {
  const commits = recordField(item, 'commits');
  const nodes = commits?.['nodes'];
  const last: unknown = Array.isArray(nodes) ? nodes.at(-1) : undefined;
  const commit = isRecord(last) ? recordField(last, 'commit') : undefined;
  return commit === undefined ? undefined : recordField(commit, 'statusCheckRollup');
}
