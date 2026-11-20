import { errorCode, errorMessage, isRecord, recordField, stringField, type JsonRecord } from '../core/guards.ts';
import { plainLine } from '../core/printable.ts';
import { exitText } from '../open/processes.ts';
import { GH_TIMEOUT_MS, GhOutputCapError, type GhResult, type GhRunner } from './gh.ts';
import type { HostIssue, IssueComment, LabelEvent, ReadComment } from '../issues/issue.ts';
import { isClaim } from '../issues/claim.ts';
import { closedPageArgs, openPageArgs, type PageVariables } from './queries.ts';
import type { RepoAccess } from './tokens.ts';

/** The most issues one list reads before it stops asking for pages; a list stopped with more on GitHub says so. */
export const ISSUE_LIMIT = 500;

/** gh's exit code when it has no login to use. */
const GH_EXIT_NO_LOGIN = 4;
const NO_LOGIN = /gh auth login|not logged in|authentication required|HTTP 401|bad credentials/i;
const NOT_VISIBLE = /could not resolve to a repository|HTTP 404|not found/i;
/** A token that reaches the repository but was not given the Issues permission. */
const NO_PERMISSION = /resource not accessible by/i;
/** A web address as a host gives one for an issue or pull request. */
export const WEB_URL = /^https:\/\/\S+$/;

/** A known cause of a gh run that exited with an error: no login or a refused token, a missing permission, or nothing visible there. */
export type GhFailureKind = 'no-login' | 'no-permission' | 'not-visible';

/** The known cause of a gh run that exited with `code` and printed `stderr`, or undefined when it is none of them. */
export function ghFailureKind(code: number, stderr: string): GhFailureKind | undefined {
  if (code === GH_EXIT_NO_LOGIN || NO_LOGIN.test(stderr)) {
    return 'no-login';
  }
  if (NO_PERMISSION.test(stderr)) {
    return 'no-permission';
  }
  return NOT_VISIBLE.test(stderr) ? 'not-visible' : undefined;
}

/** One read of a repository's issues in one state, a page of a shipped query at a time (queries.ts). */
export type IssueListRequest =
  | {
      /** `owner/name`. */
      readonly repo: string;
      readonly state: 'open';
      readonly limit: number;
    }
  | {
      readonly repo: string;
      readonly state: 'closed';
      /** Only those closed on or after this day, `YYYY-MM-DD`, UTC. */
      readonly closedSince: string;
      readonly limit: number;
    };

/** A repository's issues in one state, or the one line saying why gh could not read them. */
export type IssueList =
  | {
      readonly kind: 'listed';
      readonly issues: readonly HostIssue[];
      /** Items GitHub sent that are not issues as this code reads them: left out and counted. */
      readonly unreadable: number;
      /** The read stopped at its limit while GitHub had more, so it left issues out. */
      readonly full: boolean;
    }
  | { readonly kind: 'failed'; readonly reason: string };

/** One page of a read: what it held, and the cursor of the page after it. */
export type IssuePage =
  | {
      readonly kind: 'page';
      readonly issues: readonly HostIssue[];
      readonly unreadable: number;
      /** Every item the page held, issue or not: what counts toward the limit. */
      readonly items: number;
      /** Where the next page starts; undefined on the last page. */
      readonly next: string | undefined;
    }
  | { readonly kind: 'failed'; readonly reason: string };

/** The arguments for one page of `request`, starting after the cursor `after`; null when the repository is not `owner/name`. */
export function issuePageArgs(request: IssueListRequest, after: string | undefined): string[] | null {
  const page = repoPage(request.repo, after);
  if (page === null) {
    return null;
  }
  return request.state === 'open' ? openPageArgs(page) : closedPageArgs(page, sinceTime(request.closedSince));
}

/** The page of `repo` (`owner/name`) that starts after the cursor `after`; null when the repository is not `owner/name`. */
export function repoPage(repo: string, after: string | undefined): PageVariables | null {
  const [owner, name, ...rest] = repo.split('/');
  if (owner === undefined || owner === '' || name === undefined || name === '' || rest.length > 0) {
    return null;
  }
  return { owner, name, after };
}

/**
 * Reads a repository's issues in one state through gh, as `access` reads it: page after page until GitHub has no
 * more or `limit` items are read. Any page failing fails the whole read, so nothing is judged on half of it. Every
 * failure comes back as one line, never thrown.
 */
export async function listIssues(gh: GhRunner, access: RepoAccess, request: IssueListRequest): Promise<IssueList> {
  const issues: HostIssue[] = [];
  let unreadable = 0;
  let items = 0;
  let next: string | undefined;
  do {
    const args = issuePageArgs(request, next);
    if (args === null) {
      return { kind: 'failed', reason: `${plainLine(request.repo)} is not owner/name: check github.repos` };
    }
    const page = await readPage(gh, access, request, args);
    if (page.kind === 'failed') {
      return page;
    }
    issues.push(...page.issues);
    unreadable += page.unreadable;
    items += page.items;
    next = page.next;
    // A page with nothing on it ends the read even when GitHub says more follow, so a bad answer cannot loop.
    if (page.items === 0) {
      break;
    }
  } while (next !== undefined && items < request.limit);
  return { kind: 'listed', issues, unreadable, full: next !== undefined };
}

async function readPage(gh: GhRunner, access: RepoAccess, request: IssueListRequest, args: readonly string[]): Promise<IssuePage> {
  const ran = await runRead(gh, access, request.repo, args, ISSUE_READ);
  return ran.kind === 'failed' ? ran : parseIssuePage(ran.stdout, request);
}

/** What a read lists, as its failure lines name it: the noun, and the token permission that lets it read. */
export interface ReadKind {
  readonly noun: string;
  readonly permission: string;
  /** The gh command the read runs, as a failure line names it. */
  readonly command: string;
}

export const ISSUE_READ: ReadKind = { noun: 'issues', permission: 'Issues', command: 'gh api graphql' };

/** What one gh run of a read printed, or the one line saying why it failed. */
export type ReadRun = { readonly kind: 'read'; readonly stdout: string } | { readonly kind: 'failed'; readonly reason: string };

/** Runs one page of a read of `repo` as `access` reads it; a run that did not start or end well is one line, never thrown. */
export async function runRead(gh: GhRunner, access: RepoAccess, repo: string, args: readonly string[], kind: ReadKind): Promise<ReadRun> {
  let result: GhResult;
  try {
    result = await gh.run({ args, env: access.env });
  } catch (error) {
    return { kind: 'failed', reason: startFailureText(error) };
  }
  if (result.end.kind !== 'exited' || result.end.code !== 0) {
    return { kind: 'failed', reason: failureText(repo, result, access, kind) };
  }
  return { kind: 'read', stdout: result.stdout };
}

/** Why gh did not start (most often it is not installed), or why it was stopped for printing too much. */
export function startFailureText(error: unknown): string {
  if (error instanceof GhOutputCapError) {
    return error.message;
  }
  return errorCode(error) === 'ENOENT'
    ? 'gh, the GitHub CLI, is not installed or not on PATH: install it from https://cli.github.com'
    : plainLine(`gh could not start: ${errorMessage(error)}`);
}

/**
 * Why a gh run failed, with the fix when it is a known one: the owner's token GitHub refused, a repository it
 * cannot see, or issues (or pull requests: `kind`) it may not read.
 */
export function failureText(repo: string, result: GhResult, access: RepoAccess, kind: ReadKind): string {
  const { noun, permission, command } = kind;
  if (result.end.kind === 'signal') {
    return `gh was stopped (${result.end.signal}) before it listed the ${noun} of ${repo}; it gets ${GH_TIMEOUT_MS / 1000} s`;
  }
  const token = `the token saved as ${access.credential}`;
  switch (ghFailureKind(result.end.code, result.stderr)) {
    case 'no-login':
      return `GitHub refused ${token} (expired or revoked?): create a new one and save it again with: ${access.save}`;
    case 'no-permission':
      return `${token} may not read the ${noun} of ${repo}: on GitHub, edit that token and set ${permission} to Read-only; its text stays the same, so nothing needs saving again`;
    case 'not-visible':
      return `${repo} is not visible to ${token}: check github.repos, and on GitHub give that token this repository`;
    case undefined:
      return plainLine(`${command} for the ${noun} of ${repo} ${exitText(result.end.code, result.stderr)}`);
  }
}

/**
 * One page as `gh api graphql` prints it (`data.repository.issues`): each item that reads as an issue, how many did
 * not, and the next page's cursor. A closed read leaves out an issue closed before its day: the query can only ask
 * for issues changed since then.
 */
export function parseIssuePage(stdout: string, request: IssueListRequest): IssuePage {
  const page = connectionPage(stdout, 'issues');
  if (page === undefined) {
    return { kind: 'failed', reason: `gh printed no page of the issues of ${request.repo}` };
  }
  const read = page.nodes.map((item) => issueOf(item, request.repo));
  const issues = read.filter((issue) => issue !== null).filter((issue) => wanted(issue, request));
  return { kind: 'page', issues, unreadable: read.filter((issue) => issue === null).length, items: page.nodes.length, next: page.next };
}

/** One page of a connection: its items, read or not, and where the next page starts (undefined on the last). */
export interface ConnectionPage {
  readonly nodes: readonly unknown[];
  readonly next: string | undefined;
}

/**
 * The `data.repository.<key>` connection of a page `gh api graphql` printed; undefined when it is not one, or says
 * more pages follow without saying where.
 */
export function connectionPage(stdout: string, key: string): ConnectionPage | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  const data = isRecord(parsed) ? recordField(parsed, 'data') : undefined;
  const repository = data === undefined ? undefined : recordField(data, 'repository');
  const connection = repository === undefined ? undefined : recordField(repository, key);
  const pageInfo = connection === undefined ? undefined : recordField(connection, 'pageInfo');
  const nodes = connection?.['nodes'];
  if (pageInfo === undefined || !Array.isArray(nodes)) {
    return undefined;
  }
  const more = pageInfo['hasNextPage'] === true;
  const cursor = stringField(pageInfo, 'endCursor');
  if (more && (cursor === undefined || cursor === '')) {
    return undefined;
  }
  const items: readonly unknown[] = nodes;
  return { nodes: items, next: more ? cursor : undefined };
}

/** False only for an issue a closed read asked about that closed before its day. */
function wanted(issue: HostIssue, request: IssueListRequest): boolean {
  return request.state === 'open' || issue.closedAt === undefined || Date.parse(issue.closedAt) >= Date.parse(sinceTime(request.closedSince));
}

/** The first moment of a `YYYY-MM-DD` day, UTC. */
function sinceTime(day: string): string {
  return `${day}T00:00:00Z`;
}

function issueOf(item: unknown, repo: string): HostIssue | null {
  if (!isRecord(item)) {
    return null;
  }
  const number = item['number'];
  const title = stringField(item, 'title');
  const state = stringField(item, 'state')?.toLowerCase();
  const url = stringField(item, 'url');
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 1 || title === undefined || url === undefined || !WEB_URL.test(url)) {
    return null;
  }
  if (state !== 'open' && state !== 'closed') {
    return null;
  }
  const events = nodesOf(item['timelineItems']);
  return {
    repo,
    number,
    title,
    body: stringField(item, 'body') ?? '',
    state,
    stateReason: stringField(item, 'stateReason') ?? '',
    labels: namesOf(item['labels'], 'name'),
    assignees: namesOf(item['assignees'], 'login'),
    url,
    updatedAt: timeField(item, 'updatedAt'),
    closedAt: timeField(item, 'closedAt'),
    lastEditedAt: timeField(item, 'lastEditedAt'),
    authorAssociation: stringField(item, 'authorAssociation') ?? '',
    author: loginOf(recordField(item, 'author')),
    authorKind: kindOf(recordField(item, 'author')),
    labelEvents: events.flatMap(labelEventOf),
    renamedAt: latestRename(events),
    createdAt: timeField(item, 'createdAt'),
    comments: nodesOf(item['comments']).flatMap((comment) => postOf(comment, 'createdAt')),
    linkedPulls: countOf(recordField(item, 'closedByPullRequestsReferences')),
  };
}

/** A connection's `totalCount`, 0 when GitHub gives none or not a count. */
function countOf(connection: JsonRecord | undefined): number {
  const count = connection?.['totalCount'];
  return typeof count === 'number' && Number.isSafeInteger(count) && count > 0 ? count : 0;
}

/** A label event of the timeline, or nothing when the item is another kind or lacks its label or time. */
function labelEventOf(event: JsonRecord): LabelEvent[] {
  const label = recordField(event, 'label');
  const name = label === undefined ? undefined : stringField(label, 'name');
  const at = timeField(event, 'createdAt');
  if (event['__typename'] !== 'LabeledEvent' || name === undefined || at === undefined) {
    return [];
  }
  const actor = recordField(event, 'actor');
  return [{ label: name, at, actor: loginOf(actor), actorKind: kindOf(actor) }];
}

/**
 * A post's time (its `timeKey` field: a comment's `createdAt`, a review's `submittedAt`) and author, or nothing when it
 * lacks its time, as a review not yet submitted does; a deleted author reads as an empty login and kind.
 */
export function postOf(post: JsonRecord, timeKey: 'createdAt' | 'submittedAt'): IssueComment[] {
  const at = timeField(post, timeKey);
  const author = recordField(post, 'author');
  return at === undefined ? [] : [{ at, login: loginOf(author), authorAssociation: stringField(post, 'authorAssociation') ?? '', authorKind: kindOf(author) }];
}

/** The time of the newest change of title among the timeline events. */
function latestRename(events: readonly JsonRecord[]): string | undefined {
  const times = events.filter((event) => event['__typename'] === 'RenamedTitleEvent').flatMap((event) => timeField(event, 'createdAt') ?? []);
  return times.reduce<string | undefined>((latest, at) => (latest === undefined || Date.parse(at) > Date.parse(latest) ? at : latest), undefined);
}

export function loginOf(account: JsonRecord | undefined): string {
  return account === undefined ? '' : (stringField(account, 'login') ?? '');
}

/** The account's kind (`User`, `Bot`, `Organization`), empty when GitHub gives none. */
export function kindOf(account: JsonRecord | undefined): string {
  return account === undefined ? '' : (stringField(account, '__typename') ?? '');
}

/** A time GitHub sends (`2030-01-07T09:00:00Z`); undefined when missing or not a time. */
export function timeField(item: JsonRecord, key: string): string | undefined {
  const text = stringField(item, key);
  return text !== undefined && Number.isFinite(Date.parse(text)) ? text : undefined;
}

/** The objects of a connection's `nodes`, such as an issue's labels; anything else is left out. */
export function nodesOf(connection: unknown): JsonRecord[] {
  const nodes = isRecord(connection) ? connection['nodes'] : undefined;
  if (!Array.isArray(nodes)) {
    return [];
  }
  const items: readonly unknown[] = nodes;
  return items.filter(isRecord);
}

/** The `key` of each node of a connection, such as each label's name; anything else is left out. */
function namesOf(connection: unknown, key: string): string[] {
  return nodesOf(connection).flatMap((item) => {
    const name = stringField(item, key);
    return name === undefined ? [] : [name];
  });
}

/**
 * The comments one REST read of an issue's comments printed (gh.ts commentsReadArgs), each with its text matched for
 * a claim line and dropped, so no outsider's words leave this function; undefined when gh printed no list. A comment
 * lacking its time is left out, and a deleted author reads as an empty login and kind.
 */
export function readCommentsIn(stdout: string): ReadComment[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) {
    return undefined;
  }
  const items: readonly unknown[] = parsed;
  return items.flatMap((item): ReadComment[] => {
    if (!isRecord(item)) {
      return [];
    }
    const at = timeField(item, 'created_at');
    const user = recordField(item, 'user');
    return at === undefined
      ? []
      : [
          {
            at,
            login: user === undefined ? '' : (stringField(user, 'login') ?? ''),
            authorAssociation: stringField(item, 'author_association') ?? '',
            authorKind: user === undefined ? '' : (stringField(user, 'type') ?? ''),
            claims: isClaim(stringField(item, 'body') ?? ''),
          },
        ];
  });
}
