import { isRecord, recordField, stringField } from "../core/guards.js";
import { connectionPage, loginOf, plainLine, repoPage, runRead, timeField, WEB_URL } from "./issues.js";
import { pullPageArgs } from "./queries.js";
/** How a failed pull request read is worded, and the permission a fine-grained token needs for it. */
export const PULL_READ = { noun: 'pull requests', permission: 'Pull requests', command: 'gh api graphql' };
/** The most pull requests one read takes before it stops asking for pages; a read stopped with more on GitHub says so. */
export const PULL_LIMIT = 200;
/**
 * Reads the pull requests of a repository through gh, as `access` reads it, the most recently changed first: page after
 * page until one changed before `since`, the end, or `limit` items. Any page failing fails the read, as one line.
 */
export async function listPulls(gh, access, request) {
    const pulls = [];
    let unreadable = 0;
    let items = 0;
    let next;
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
            }
            else if (request.since !== undefined && Date.parse(pull.updatedAt) < Date.parse(request.since)) {
                // Newest change first: every item after this one changed before `since` too.
                return { kind: 'listed', pulls, unreadable, full: false };
            }
            else {
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
const STATES = { OPEN: 'open', MERGED: 'merged', CLOSED: 'closed' };
const MERGEABLE = { MERGEABLE: 'mergeable', CONFLICTING: 'conflicting', UNKNOWN: 'unknown' };
const REVIEWS = { APPROVED: 'approved', CHANGES_REQUESTED: 'changes-requested', REVIEW_REQUIRED: 'review-required' };
/** GitHub's rollup of a commit's checks; a cancelled check run rolls up as FAILURE. */
const CHECKS = { SUCCESS: 'passing', FAILURE: 'failing', ERROR: 'failing', PENDING: 'pending', EXPECTED: 'pending' };
/** One pull request as the shipped query gives it; null when a field the monitor needs is missing or not what GitHub sends. */
export function pullOf(item, repo) {
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
function closedIssuesOf(references, repo) {
    const nodes = references?.['nodes'];
    const numbers = [];
    for (const node of Array.isArray(nodes) ? nodes : []) {
        const number = isRecord(node) ? node['number'] : undefined;
        const home = isRecord(node) ? stringField(recordField(node, 'repository') ?? {}, 'nameWithOwner') : undefined;
        if (typeof number === 'number' && Number.isSafeInteger(number) && number > 0 && home?.toLowerCase() === repo.toLowerCase() && !numbers.includes(number)) {
            numbers.push(number);
        }
    }
    return numbers;
}
/** How a check run ends that counts as failed: each makes the rollup fail, and each may leave a log to read. */
const FAILED_CONCLUSIONS = new Set(['FAILURE', 'TIMED_OUT', 'CANCELLED', 'STARTUP_FAILURE']);
/** The failed check runs of a rollup's contexts; a status context (no id, no log) or an unreadable node is left out. */
function failedJobsOf(rollup) {
    const contexts = rollup === undefined ? undefined : recordField(rollup, 'contexts');
    const nodes = contexts?.['nodes'];
    const jobs = [];
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
function rollupStateOf(item) {
    const rollup = rollupOf(item);
    return rollup === undefined ? undefined : stringField(rollup, 'state');
}
/** The check rollup of the last commit (`commits(last: 1)`); undefined when it has no checks. */
function rollupOf(item) {
    const commits = recordField(item, 'commits');
    const nodes = commits?.['nodes'];
    const last = Array.isArray(nodes) ? nodes.at(-1) : undefined;
    const commit = isRecord(last) ? recordField(last, 'commit') : undefined;
    return commit === undefined ? undefined : recordField(commit, 'statusCheckRollup');
}
