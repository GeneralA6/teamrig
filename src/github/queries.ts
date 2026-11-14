/**
 * The only GraphQL texts teamrig sends to GitHub: three reads of a repository's issues and two of its pull requests, a
 * page at a time. gh.ts refuses a `gh api graphql` run whose query is not one of these word for word, so a query never writes (no
 * mutation) and never reads past the fields below.
 */

/** Issues one page reads: GitHub's largest page. */
export const ISSUE_PAGE_SIZE = 100;

/** Label and title-change events kept per issue, newest last: enough to find who last put a label on. */
export const TIMELINE_EVENTS = 30;

/**
 * The flag for a raw string field. Never `-F`: gh reads a `-F` value starting with `@` from a file and turns
 * `true` or a number into JSON, so an outside value could change what gets sent.
 */
export const RAW_FIELD = '-f';

/** Comments kept per issue, newest last: enough to see who spoke last for the response clock (src/github/clock.ts). */
export const COMMENTS_READ = 20;

/**
 * One issue: what the task is made from, and who wrote it, labelled it and edited it, which decides trust; when it
 * was opened and when each newest comment was posted by whom, which runs the response clock and points the claim
 * pass at the issues to read; and how many open pull requests close it, which keeps a claim from running out. Never
 * a comment's text: only the claim pass reads it, one bounded page per issue (gh.ts commentsReadArgs).
 */
const ISSUE_FIELDS = `number title body state stateReason url createdAt updatedAt closedAt lastEditedAt authorAssociation
        author { __typename login }
        labels(first: 100) { nodes { name } }
        assignees(first: 100) { nodes { login } }
        timelineItems(itemTypes: [LABELED_EVENT, RENAMED_TITLE_EVENT], last: ${TIMELINE_EVENTS}) {
          nodes { __typename ... on LabeledEvent { createdAt actor { __typename login } label { name } } ... on RenamedTitleEvent { createdAt } }
        }
        comments(last: ${COMMENTS_READ}) { nodes { createdAt authorAssociation author { __typename login } } }
        closedByPullRequestsReferences(first: 1) { totalCount }`;

/** Every open issue, oldest first. */
export const OPEN_ISSUES_QUERY = `query($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    issues(states: [OPEN], first: ${ISSUE_PAGE_SIZE}, after: $after, orderBy: {field: CREATED_AT, direction: ASC}) {
      pageInfo { hasNextPage endCursor }
      nodes {
        ${ISSUE_FIELDS}
      }
    }
  }
}`;

/** Closed issues changed on or after `$since`, newest change first; the reader keeps those closed since then. */
export const CLOSED_ISSUES_QUERY = `query($owner: String!, $name: String!, $after: String, $since: DateTime) {
  repository(owner: $owner, name: $name) {
    issues(states: [CLOSED], first: ${ISSUE_PAGE_SIZE}, after: $after, filterBy: {since: $since}, orderBy: {field: UPDATED_AT, direction: DESC}) {
      pageInfo { hasNextPage endCursor }
      nodes {
        ${ISSUE_FIELDS}
      }
    }
  }
}`;

/** Blockers read per issue: past this many, a link already there may be added again, which GitHub refuses. */
export const BLOCKERS_PER_ISSUE = 50;

/**
 * Every issue in any state, oldest first, with what issue links need: its number, the id a link write names, its
 * parent and the issues it is blocked by, each with its repository. The id is `fullDatabaseId`, a string: issue ids
 * passed 2^31, past the 32-bit Int that GraphQL's `databaseId` is typed as.
 */
export const ISSUE_LINKS_QUERY = `query($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    issues(first: ${ISSUE_PAGE_SIZE}, after: $after, orderBy: {field: CREATED_AT, direction: ASC}) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number fullDatabaseId
        parent { number repository { nameWithOwner } }
        blockedBy(first: ${BLOCKERS_PER_ISSUE}) { nodes { number repository { nameWithOwner } } }
      }
    }
  }
}`;

/** Pull requests one page reads: fewer than issues, as each also reads its last commit's check rollup. */
export const PULL_PAGE_SIZE = 50;

/**
 * What both pull request reads get of one: no body and no comment text, only what tells a monitor that something
 * happened to it, and who opened it from where (`isCrossRepository`: a fork).
 */
const PULL_NODE = `nodes {
        number title url state isDraft createdAt updatedAt closedAt mergedAt authorAssociation
        author { __typename login }
        headRefName isCrossRepository mergeable reviewDecision
        commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
      }`;

/**
 * Pull requests in any state, the most recently changed first, so a reader stops at the first one changed before
 * the last read: what opened, merged or closed since then.
 */
export const PULL_REQUESTS_QUERY = `query($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(first: ${PULL_PAGE_SIZE}, after: $after, orderBy: {field: UPDATED_AT, direction: DESC}) {
      pageInfo { hasNextPage endCursor }
      ${PULL_NODE}
    }
  }
}`;

/**
 * Every open pull request, the most recently changed first. Read in full at each run: GitHub does not move
 * `updatedAt` when a pull request starts to conflict because its base moved, so only reading each open one again
 * sees that, and a finished check run with it.
 */
export const OPEN_PULLS_QUERY = `query($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(first: ${PULL_PAGE_SIZE}, after: $after, states: [OPEN], orderBy: {field: UPDATED_AT, direction: DESC}) {
      pageInfo { hasNextPage endCursor }
      ${PULL_NODE}
    }
  }
}`;

/** Each shipped text with the variables it declares: gh.ts runs a query only with these, each at most once. */
export const QUERY_VARIABLES: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  [OPEN_ISSUES_QUERY, new Set(['owner', 'name', 'after'])],
  [CLOSED_ISSUES_QUERY, new Set(['owner', 'name', 'after', 'since'])],
  [ISSUE_LINKS_QUERY, new Set(['owner', 'name', 'after'])],
  [PULL_REQUESTS_QUERY, new Set(['owner', 'name', 'after'])],
  [OPEN_PULLS_QUERY, new Set(['owner', 'name', 'after'])],
]);

/** Which page of which repository a read asks for: `after` is the cursor the page before ended on. */
export interface PageVariables {
  readonly owner: string;
  readonly name: string;
  readonly after: string | undefined;
}

/** The arguments for one page of open issues. */
export function openPageArgs(page: PageVariables): string[] {
  return pageArgs(OPEN_ISSUES_QUERY, page, []);
}

/** The arguments for one page of every issue's links. */
export function linksPageArgs(page: PageVariables): string[] {
  return pageArgs(ISSUE_LINKS_QUERY, page, []);
}

/** The arguments for one page of closed issues changed on or after `since`, an ISO time. */
export function closedPageArgs(page: PageVariables, since: string): string[] {
  return pageArgs(CLOSED_ISSUES_QUERY, page, field('since', since));
}

/** The arguments for one page of pull requests in any state (`changed`) or of the open ones, the most recently changed first. */
export function pullPageArgs(page: PageVariables, read: PullRead): string[] {
  return pageArgs(read === 'open' ? OPEN_PULLS_QUERY : PULL_REQUESTS_QUERY, page, []);
}

/** Which pull requests a read takes: the open ones, or those in any state changed since a time. */
export type PullRead = 'open' | 'changed';

function pageArgs(query: string, page: PageVariables, extra: readonly string[]): string[] {
  const after = page.after === undefined ? [] : field('after', page.after);
  return ['api', 'graphql', ...field('query', query), ...field('owner', page.owner), ...field('name', page.name), ...after, ...extra];
}

function field(key: string, value: string): string[] {
  return [RAW_FIELD, `${key}=${value}`];
}
