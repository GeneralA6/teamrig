/**
 * The only GraphQL texts teamrig sends to GitHub: three reads of a repository's issues, a page at a time. gh.ts
 * refuses a `gh api graphql` run whose query is not one of these word for word, so a query never writes (no
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
/** One issue: what the task is made from, and who wrote it, labelled it and edited it, which decides trust. */
const ISSUE_FIELDS = `number title body state stateReason url updatedAt closedAt lastEditedAt authorAssociation
        author { __typename login }
        labels(first: 100) { nodes { name } }
        assignees(first: 100) { nodes { login } }
        timelineItems(itemTypes: [LABELED_EVENT, RENAMED_TITLE_EVENT], last: ${TIMELINE_EVENTS}) {
          nodes { __typename ... on LabeledEvent { createdAt actor { __typename login } label { name } } ... on RenamedTitleEvent { createdAt } }
        }`;
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
/** Each shipped text with the variables it declares: gh.ts runs a query only with these, each at most once. */
export const QUERY_VARIABLES = new Map([
    [OPEN_ISSUES_QUERY, new Set(['owner', 'name', 'after'])],
    [CLOSED_ISSUES_QUERY, new Set(['owner', 'name', 'after', 'since'])],
    [ISSUE_LINKS_QUERY, new Set(['owner', 'name', 'after'])],
]);
/** The arguments for one page of open issues. */
export function openPageArgs(page) {
    return pageArgs(OPEN_ISSUES_QUERY, page, []);
}
/** The arguments for one page of every issue's links. */
export function linksPageArgs(page) {
    return pageArgs(ISSUE_LINKS_QUERY, page, []);
}
/** The arguments for one page of closed issues changed on or after `since`, an ISO time. */
export function closedPageArgs(page, since) {
    return pageArgs(CLOSED_ISSUES_QUERY, page, field('since', since));
}
function pageArgs(query, page, extra) {
    const after = page.after === undefined ? [] : field('after', page.after);
    return ['api', 'graphql', ...field('query', query), ...field('owner', page.owner), ...field('name', page.name), ...after, ...extra];
}
function field(key, value) {
    return [RAW_FIELD, `${key}=${value}`];
}
