import { errorCode, errorMessage, isRecord, recordField, stringField, type JsonRecord } from '../core/guards.ts';
import { exitText } from '../open/processes.ts';
import { GH_TIMEOUT_MS, type GhResult, type GhRunner } from './gh.ts';
import { closedPageArgs, openPageArgs, type IssueState, type PageVariables } from './queries.ts';
import type { RepoAccess } from './tokens.ts';

/** The most issues one list reads before it stops asking for pages; a list stopped with more on GitHub says so. */
export const ISSUE_LIMIT = 500;

/** gh's exit code when it has no login to use. */
const GH_EXIT_NO_LOGIN = 4;
const NO_LOGIN = /gh auth login|not logged in|authentication required|HTTP 401|bad credentials/i;
const NOT_VISIBLE = /could not resolve to a repository|HTTP 404|not found/i;
/** A token that reaches the repository but was not given the Issues permission. */
const NO_PERMISSION = /resource not accessible by/i;
const URL = /^https:\/\/\S+$/;

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

/** A label put on an issue, as its timeline has it. */
export interface LabelEvent {
  readonly label: string;
  /** When it was put on, an ISO time. */
  readonly at: string;
  /** Who put it on: a login, empty when GitHub no longer has that account. */
  readonly actor: string;
  /** What kind of account that is, as GitHub names it (`User`, `Bot`, `Organization`); empty when it gives none. */
  readonly actorKind: string;
}

/** An issue as the import reads it. Its title, body and labels are outside input: data, never instructions. */
export interface GithubIssue {
  readonly repo: string;
  readonly number: number;
  /** As GitHub has it; map.ts cleans it before it becomes a task title. */
  readonly title: string;
  /** As GitHub has it, empty when the issue has none; map.ts cleans it before it becomes the task's description. */
  readonly body: string;
  readonly state: IssueState;
  /** Why a closed issue closed, as GitHub names it (`COMPLETED`, `NOT_PLANNED`, `DUPLICATE`); empty when it gives none. */
  readonly stateReason: string;
  readonly labels: readonly string[];
  /** The assignees' logins, in GitHub's order. */
  readonly assignees: readonly string[];
  readonly url: string;
  /** When GitHub last changed the issue (reopened, edited, commented on), an ISO time; undefined when it gave none. */
  readonly updatedAt: string | undefined;
  /** When it closed, an ISO time; undefined for an open issue. */
  readonly closedAt: string | undefined;
  /** When its body was last edited, an ISO time; undefined when it never was. */
  readonly lastEditedAt: string | undefined;
  /** The author's tie to the repository, as GitHub names it (`OWNER`, `MEMBER`, `COLLABORATOR`, `NONE`); empty when it gives none. */
  readonly authorAssociation: string;
  /** The author's login, empty when GitHub no longer has that account. */
  readonly author: string;
  /** The labels put on it, in GitHub's order (oldest first), among the last timeline events the query reads. */
  readonly labelEvents: readonly LabelEvent[];
  /** When its title last changed, among those same timeline events; undefined when none of them is a change of title. */
  readonly renamedAt: string | undefined;
}

/** A repository's issues in one state, or the one line saying why gh could not read them. */
export type IssueList =
  | {
      readonly kind: 'listed';
      readonly issues: readonly GithubIssue[];
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
      readonly issues: readonly GithubIssue[];
      readonly unreadable: number;
      /** Every item the page held, issue or not: what counts toward the limit. */
      readonly items: number;
      /** Where the next page starts; undefined on the last page. */
      readonly next: string | undefined;
    }
  | { readonly kind: 'failed'; readonly reason: string };

/** The arguments for one page of `request`, starting after the cursor `after`; null when the repository is not `owner/name`. */
export function issuePageArgs(request: IssueListRequest, after: string | undefined): string[] | null {
  const [owner, name, ...rest] = request.repo.split('/');
  if (owner === undefined || owner === '' || name === undefined || name === '' || rest.length > 0) {
    return null;
  }
  const page: PageVariables = { owner, name, after };
  return request.state === 'open' ? openPageArgs(page) : closedPageArgs(page, sinceTime(request.closedSince));
}

/** Text from outside on one plain line: control and format characters (escapes, bidi overrides) become spaces. */
export function plainLine(text: string): string {
  return text.replace(/[\p{Cc}\p{Cf}]+/gu, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Reads a repository's issues in one state through gh, as `access` reads it: page after page until GitHub has no
 * more or `limit` items are read. Any page failing fails the whole read, so nothing is judged on half of it. Every
 * failure comes back as one line, never thrown.
 */
export async function listIssues(gh: GhRunner, access: RepoAccess, request: IssueListRequest): Promise<IssueList> {
  const issues: GithubIssue[] = [];
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
  let result: GhResult;
  try {
    result = await gh.run({ args, env: access.env });
  } catch (error) {
    return { kind: 'failed', reason: startFailureText(error) };
  }
  if (result.end.kind !== 'exited' || result.end.code !== 0) {
    return { kind: 'failed', reason: failureText(request.repo, result, access) };
  }
  return parseIssuePage(result.stdout, request);
}

/** Why gh did not start: most often it is not installed. */
export function startFailureText(error: unknown): string {
  return errorCode(error) === 'ENOENT'
    ? 'gh, the GitHub CLI, is not installed or not on PATH: install it from https://cli.github.com, then run gh auth login'
    : plainLine(`gh could not start: ${errorMessage(error)}`);
}

/**
 * Why a gh run failed, with the fix when it is a known one, worded for what read the repository: a login
 * or token GitHub refused, a repository it cannot see, or issues it may not read.
 */
export function failureText(repo: string, result: GhResult, access: RepoAccess): string {
  if (result.end.kind === 'signal') {
    return `gh was stopped (${result.end.signal}) before it listed the issues of ${repo}; it gets ${GH_TIMEOUT_MS / 1000} s`;
  }
  const token = `the token saved as ${access.credential}`;
  const saveOne = `save a read-only token for ${access.owner} with: ${access.save}`;
  if (result.end.code === GH_EXIT_NO_LOGIN || NO_LOGIN.test(result.stderr)) {
    return access.via === 'token'
      ? `GitHub refused ${token} (expired or revoked?): create a new one and save it again with: ${access.save}`
      : `gh is not logged in to GitHub: run gh auth login, or ${saveOne}`;
  }
  if (NO_PERMISSION.test(result.stderr)) {
    return access.via === 'token'
      ? `${token} may not read the issues of ${repo}: on GitHub, edit that token and set Issues to Read-only; its text stays the same, so nothing needs saving again`
      : `the gh login may not read the issues of ${repo}: ${saveOne}`;
  }
  if (NOT_VISIBLE.test(result.stderr)) {
    return access.via === 'token'
      ? `${repo} is not visible to ${token}: check github.repos, and on GitHub give that token this repository`
      : `${repo} is not visible to the gh login: check github.repos, or ${saveOne}`;
  }
  return plainLine(`gh api graphql for the issues of ${repo} ${exitText(result.end.code, result.stderr)}`);
}

/**
 * One page as `gh api graphql` prints it (`data.repository.issues`): each item that reads as an issue, how many did
 * not, and the next page's cursor. A closed read leaves out an issue closed before its day: the query can only ask
 * for issues changed since then.
 */
export function parseIssuePage(stdout: string, request: IssueListRequest): IssuePage {
  const failed: IssuePage = { kind: 'failed', reason: `gh printed no page of the issues of ${request.repo}` };
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return failed;
  }
  const data = isRecord(parsed) ? recordField(parsed, 'data') : undefined;
  const repository = data === undefined ? undefined : recordField(data, 'repository');
  const connection = repository === undefined ? undefined : recordField(repository, 'issues');
  const pageInfo = connection === undefined ? undefined : recordField(connection, 'pageInfo');
  const nodes = connection?.['nodes'];
  if (pageInfo === undefined || !Array.isArray(nodes)) {
    return failed;
  }
  const more = pageInfo['hasNextPage'] === true;
  const cursor = stringField(pageInfo, 'endCursor');
  if (more && (cursor === undefined || cursor === '')) {
    return failed;
  }
  const items: readonly unknown[] = nodes;
  const read = items.map((item) => issueOf(item, request.repo));
  const issues = read.filter((issue) => issue !== null).filter((issue) => wanted(issue, request));
  return { kind: 'page', issues, unreadable: read.filter((issue) => issue === null).length, items: items.length, next: more ? cursor : undefined };
}

/** False only for an issue a closed read asked about that closed before its day. */
function wanted(issue: GithubIssue, request: IssueListRequest): boolean {
  return request.state === 'open' || issue.closedAt === undefined || Date.parse(issue.closedAt) >= Date.parse(sinceTime(request.closedSince));
}

/** The first moment of a `YYYY-MM-DD` day, UTC. */
function sinceTime(day: string): string {
  return `${day}T00:00:00Z`;
}

function issueOf(item: unknown, repo: string): GithubIssue | null {
  if (!isRecord(item)) {
    return null;
  }
  const number = item['number'];
  const title = stringField(item, 'title');
  const state = stringField(item, 'state')?.toLowerCase();
  const url = stringField(item, 'url');
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 1 || title === undefined || url === undefined || !URL.test(url)) {
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
    labelEvents: events.flatMap(labelEventOf),
    renamedAt: latestRename(events),
  };
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
  return [{ label: name, at, actor: loginOf(actor), actorKind: actor === undefined ? '' : (stringField(actor, '__typename') ?? '') }];
}

/** The time of the newest change of title among the timeline events. */
function latestRename(events: readonly JsonRecord[]): string | undefined {
  const times = events.filter((event) => event['__typename'] === 'RenamedTitleEvent').flatMap((event) => timeField(event, 'createdAt') ?? []);
  return times.reduce<string | undefined>((latest, at) => (latest === undefined || Date.parse(at) > Date.parse(latest) ? at : latest), undefined);
}

function loginOf(account: JsonRecord | undefined): string {
  return account === undefined ? '' : (stringField(account, 'login') ?? '');
}

/** A time GitHub sends (`2030-01-07T09:00:00Z`); undefined when missing or not a time. */
function timeField(item: JsonRecord, key: string): string | undefined {
  const text = stringField(item, key);
  return text !== undefined && Number.isFinite(Date.parse(text)) ? text : undefined;
}

/** The objects of a connection's `nodes`, such as an issue's labels; anything else is left out. */
function nodesOf(connection: unknown): JsonRecord[] {
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
