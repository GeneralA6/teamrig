import { errorCode, errorMessage, isRecord, stringField, type JsonRecord } from '../core/guards.ts';
import { exitText } from '../open/processes.ts';
import { GH_TIMEOUT_MS, type GhResult, type GhRunner } from './gh.ts';
import type { RepoAccess } from './tokens.ts';

/** The issue fields read, and nothing more; the body becomes the task's description. */
export const ISSUE_FIELDS = ['number', 'title', 'body', 'state', 'stateReason', 'labels', 'assignees', 'url'] as const;

/** The most issues one list returns; a list this long may have left some out, and the sync says so. */
export const ISSUE_LIMIT = 500;

/** gh's exit code when it has no login to use. */
const GH_EXIT_NO_LOGIN = 4;
const NO_LOGIN = /gh auth login|not logged in|authentication required|HTTP 401|bad credentials/i;
const NOT_VISIBLE = /could not resolve to a repository|HTTP 404|not found/i;
/** A token that reaches the repository but was not given the Issues permission. */
const NO_PERMISSION = /resource not accessible by/i;
const URL = /^https:\/\/\S+$/;

export type IssueState = 'open' | 'closed';

/** One `gh issue list` read of a repository. */
export interface IssueListRequest {
  /** `owner/name`. */
  readonly repo: string;
  readonly state: IssueState;
  /** For closed issues: only those closed on or after this day, `YYYY-MM-DD`. */
  readonly closedSince?: string;
  readonly limit: number;
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
}

/** A repository's issues in one state, or the one line saying why gh could not list them. */
export type IssueList =
  | {
      readonly kind: 'listed';
      readonly issues: readonly GithubIssue[];
      /** Items gh printed that are not issues as this code reads them: left out and counted. */
      readonly unreadable: number;
      /** The list reached its limit, so it may have left issues out. */
      readonly full: boolean;
    }
  | { readonly kind: 'failed'; readonly reason: string };

/** The arguments for one read: a list as JSON with only ISSUE_FIELDS, never a command that writes. */
export function issueListArgs(request: IssueListRequest): string[] {
  const search = request.closedSince === undefined ? [] : ['--search', `closed:>=${request.closedSince}`];
  return ['issue', 'list', '-R', request.repo, '--state', request.state, ...search, '--limit', String(request.limit), '--json', ISSUE_FIELDS.join(',')];
}

/** Text from outside on one plain line: control and format characters (escapes, bidi overrides) become spaces. */
export function plainLine(text: string): string {
  return text.replace(/[\p{Cc}\p{Cf}]+/gu, ' ').replace(/\s+/g, ' ').trim();
}

/** Lists a repository's issues in one state through gh, as `access` reads it. Every failure comes back as one line, never thrown. */
export async function listIssues(gh: GhRunner, access: RepoAccess, request: IssueListRequest): Promise<IssueList> {
  let result: GhResult;
  try {
    result = await gh.run({ args: issueListArgs(request), env: access.env });
  } catch (error) {
    return { kind: 'failed', reason: startFailureText(error) };
  }
  if (result.end.kind !== 'exited' || result.end.code !== 0) {
    return { kind: 'failed', reason: failureText(request.repo, result, access) };
  }
  return parseIssueList(result.stdout, request);
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
  return plainLine(`gh issue list -R ${repo} ${exitText(result.end.code, result.stderr)}`);
}

/** gh's JSON list: each item that reads as an issue, and how many did not. */
export function parseIssueList(stdout: string, request: IssueListRequest): IssueList {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    parsed = undefined;
  }
  if (!Array.isArray(parsed)) {
    return { kind: 'failed', reason: `gh printed no JSON list of the issues of ${request.repo}` };
  }
  const items: readonly unknown[] = parsed;
  const issues = items.map((item) => issueOf(item, request.repo)).filter((issue) => issue !== null);
  return { kind: 'listed', issues, unreadable: items.length - issues.length, full: items.length >= request.limit };
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
  };
}

/** The `key` of each object in a list, such as each label's name; anything else is left out. */
function namesOf(value: unknown, key: string): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const items: readonly unknown[] = value;
  return items.filter(isRecord).flatMap((item: JsonRecord) => {
    const name = stringField(item, key);
    return name === undefined ? [] : [name];
  });
}
