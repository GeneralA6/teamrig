import { createSign } from 'node:crypto';
import { isRecord, type JsonRecord } from '../lib/guards.ts';

/**
 * The automatic merge of the release pull request (T4712), run by .github/workflows/release-merge.yml once ci passed
 * on the release branch. Two steps, so the App key reaches only the second:
 * - `releaseGate` reads GitHub with the job's read-only token and passes only the one open release pull request
 *   whose head is the head ci just passed, a single commit holding nothing but the version raises and the notes
 *   (`releaseRefusal`), with every check on that head green: a skipped check only when no rule requires it, and the
 *   summary check from GitHub Actions itself. Anything it cannot read, or reads in an unexpected shape, refuses.
 * - `mergeRelease` mints a short-lived token of the teamrig-release App for this repository alone, merges that head
 *   pinned by its sha, comments on the pull request, and revokes the token.
 * Refusals and comments name paths, checks and reasons in code spans and never echo pull request text.
 */

/** GitHub Actions' own App: the only one whose `every check passed` run counts (T4712 C7). */
export const ACTIONS_APP_ID = 15368;
/** Who the release workflow's token opens the release pull request as: a filter, never a control (C6). */
export const RELEASE_AUTHOR = 'github-actions[bot]';
/** The event release.yml starts ci with on the release branch, as its own token's pull request starts none. */
export const RELEASE_CI_EVENT = 'workflow_dispatch';
/** Pages of check runs read at most: 1000 runs, far past ci.yml's dozen, so a larger count is refused as odd. */
const MAX_CHECK_PAGES = 10;
const PAGE = 100;
const FULL_SHA = /^[0-9a-f]{40}$/;

export type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';

export interface ApiRequest {
  readonly method: Method;
  /** The path from the API root, with its query, such as `/repos/o/r/pulls?state=open`. */
  readonly path: string;
  readonly token: string;
  readonly body?: JsonRecord;
}

/** One GitHub REST call: resolves to the parsed JSON body (null for an empty one) and rejects on any status but 2xx. */
export type GitHubApi = (request: ApiRequest) => Promise<unknown>;

/** The fetch the real `GitHubApi` calls, narrowed to what it uses. */
export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/** The REST API over `fetch`; an error names the method, the path without its query and the status, nothing more. */
export function fetchGitHubApi(fetchFn: Fetch, root = 'https://api.github.com'): GitHubApi {
  return async ({ method, path, token, body }) => {
    const headers: Record<string, string> = {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'user-agent': 'teamrig-release-merge',
      'x-github-api-version': '2022-11-28',
    };
    const init: RequestInit = body === undefined ? { method, headers } : { method, headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) };
    const response = await fetchFn(`${root}${path}`, init);
    const text = await response.text();
    if (!response.ok) throw new Error(`GitHub answered ${method} ${path.split('?')[0] ?? path} with ${response.status}`);
    if (text === '') return null;
    const parsed: unknown = JSON.parse(text);
    return parsed;
  };
}

/** A value in a code span, so no text from GitHub can open Markdown of its own: backticks and line ends are dropped. */
export function codeSpan(text: string): string {
  const flat = text.replace(/[`\r\n]/g, '').slice(0, 120);
  return `\`${flat === '' ? ' ' : flat}\``;
}

function recordOf(value: unknown, what: string): JsonRecord {
  if (!isRecord(value)) throw new Error(`GitHub's ${what} is not an object`);
  return value;
}

function fieldRecord(record: JsonRecord, key: string, what: string): JsonRecord {
  return recordOf(record[key], `${what}.${key}`);
}

function fieldString(record: JsonRecord, key: string, what: string): string {
  const value = record[key];
  if (typeof value !== 'string') throw new Error(`GitHub's ${what}.${key} is not a string`);
  return value;
}

function fieldNumber(record: JsonRecord, key: string, what: string): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new Error(`GitHub's ${what}.${key} is not a whole number`);
  return value;
}

function fieldList(record: JsonRecord, key: string, what: string): readonly JsonRecord[] {
  return listOf(record[key], `${what}.${key}`);
}

function listOf(value: unknown, what: string): readonly JsonRecord[] {
  if (!Array.isArray(value)) throw new Error(`GitHub's ${what} is not a list`);
  return value.map((item, index) => recordOf(item, `${what}[${index}]`));
}

/** What the gate reads: the repository, the ci run that ended, and the repo profile's release branch and checks. */
export interface GateTarget {
  /** `owner/name`, as GITHUB_REPOSITORY gives it. */
  readonly repo: string;
  /** The ci run whose end started the gate. */
  readonly runId: number;
  readonly main: string;
  /** The branch release-please keeps the release pull request on (repos.json `release.head`). */
  readonly head: string;
  /** The ci job every other check feeds (repos.json `summary`). */
  readonly summary: string;
}

export type GateOutcome =
  | { readonly kind: 'pass'; readonly pr: number; readonly sha: string; readonly checks: number }
  /** Nothing to merge from this run: the branch moved past its head, or no release pull request is open. */
  | { readonly kind: 'stale'; readonly reason: string }
  | { readonly kind: 'refused'; readonly reason: string };

export interface GateDeps {
  readonly api: GitHubApi;
  /** The job's read-only token. */
  readonly token: string;
  /** Why the release head's change may not merge, read from git's tree data (`releaseRefusal`), or null. */
  readonly filesRefusal: (sha: string) => string | null;
}

/** One check that a rule requires on main: its name, and the App that must report it when the rule names one. */
export interface RequiredCheck {
  readonly context: string;
  readonly integrationId: number | undefined;
}

export interface CheckRun {
  readonly name: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly appId: number;
}

/** Runs `releaseGate` and turns anything it could not read into a refusal, so the gate fails closed. */
export async function releaseGate(target: GateTarget, deps: GateDeps): Promise<GateOutcome> {
  try {
    return await gate(target, deps);
  } catch (error) {
    return { kind: 'refused', reason: `the gate could not finish: ${error instanceof Error ? error.message : String(error)}` };
  }
}

async function gate(target: GateTarget, deps: GateDeps): Promise<GateOutcome> {
  const get = async (path: string): Promise<unknown> => deps.api({ method: 'GET', path: `/repos/${target.repo}${path}`, token: deps.token });
  const run = recordOf(await get(`/actions/runs/${target.runId}`), 'run');
  const runRefusal = ciRunRefusal(run, target);
  if (runRefusal !== null) return { kind: 'refused', reason: runRefusal };
  const sha = fieldString(run, 'head_sha', 'run');
  if (!FULL_SHA.test(sha)) return { kind: 'refused', reason: 'the ci run names no full commit sha' };

  const owner = target.repo.split('/')[0] ?? '';
  const open = listOf(await get(`/pulls?state=open&base=${encodeURIComponent(target.main)}&head=${encodeURIComponent(`${owner}:${target.head}`)}&per_page=${PAGE}`), 'pull list');
  const [listed] = open;
  if (listed === undefined) return { kind: 'stale', reason: 'no release pull request is open' };
  if (open.length > 1) return { kind: 'refused', reason: `${open.length} open pull requests come from the release branch` };
  const pr = fieldNumber(listed, 'number', 'pull');
  const pull = recordOf(await get(`/pulls/${pr}`), 'pull');
  const pullHead = fieldRecord(pull, 'head', 'pull');
  if (fieldString(pullHead, 'sha', 'pull.head') !== sha) return { kind: 'stale', reason: `the release branch moved past ${codeSpan(sha)}: the ci run on its new head decides` };
  const pullRefusal = releasePullRefusal(pull, target);
  if (pullRefusal !== null) return { kind: 'refused', reason: pullRefusal };

  const files = deps.filesRefusal(sha);
  if (files !== null) return { kind: 'refused', reason: `the change is more than a release: ${codeSpan(files)}` };

  const required = requiredChecksOf(await get(`/rules/branches/${encodeURIComponent(target.main)}?per_page=${PAGE}`));
  const runs = await checkRunsOf(get, sha);
  const checks = checksRefusal(runs, required, target.summary);
  if (checks !== null) return { kind: 'refused', reason: checks };
  const status = recordOf(await get(`/commits/${sha}/status`), 'combined status');
  if (fieldNumber(status, 'total_count', 'combined status') > 0 && fieldString(status, 'state', 'combined status') !== 'success') {
    return { kind: 'refused', reason: `the head's commit status is ${codeSpan(fieldString(status, 'state', 'combined status'))}` };
  }
  return { kind: 'pass', pr, sha, checks: runs.filter((one) => one.conclusion === 'success').length };
}

/** Why the ci run is not a passed run of release.yml's dispatch on the release branch of this repository, or null. */
function ciRunRefusal(run: JsonRecord, target: GateTarget): string | null {
  const event = fieldString(run, 'event', 'run');
  if (event !== RELEASE_CI_EVENT) return `the ci run was started by ${codeSpan(event)}, not by the release workflow's ${codeSpan(RELEASE_CI_EVENT)}`;
  if (fieldString(run, 'status', 'run') !== 'completed' || run['conclusion'] !== 'success') return 'the ci run did not pass';
  if (fieldString(fieldRecord(run, 'head_repository', 'run'), 'full_name', 'run.head_repository') !== target.repo) return 'the ci run is on another repository';
  if (fieldString(run, 'head_branch', 'run') !== target.head) return 'the ci run is not on the release branch';
  return null;
}

/** Why the release pull request is not open into main from this repository's release branch as one commit, or null. */
function releasePullRefusal(pull: JsonRecord, target: GateTarget): string | null {
  const base = fieldRecord(pull, 'base', 'pull');
  const head = fieldRecord(pull, 'head', 'pull');
  if (fieldString(pull, 'state', 'pull') !== 'open' || pull['draft'] !== false) return 'the release pull request is not open and ready';
  if (fieldString(base, 'ref', 'pull.base') !== target.main || fieldString(fieldRecord(base, 'repo', 'pull.base'), 'full_name', 'pull.base.repo') !== target.repo) {
    return `the release pull request does not go into ${codeSpan(target.main)} of this repository`;
  }
  if (fieldString(head, 'ref', 'pull.head') !== target.head || fieldString(fieldRecord(head, 'repo', 'pull.head'), 'full_name', 'pull.head.repo') !== target.repo) {
    return "the release pull request's head is not this repository's release branch";
  }
  if (fieldString(fieldRecord(pull, 'user', 'pull'), 'login', 'pull.user') !== RELEASE_AUTHOR) return `the release pull request was not opened by ${codeSpan(RELEASE_AUTHOR)}`;
  const commits = fieldNumber(pull, 'commits', 'pull');
  return commits === 1 ? null : `the release pull request holds ${commits} commits, where release-please writes one`;
}

/** The checks main's rules require, from the branch's rules (any ruleset), each with the App the rule names if any. */
export function requiredChecksOf(rules: unknown): readonly RequiredCheck[] {
  const list = listOf(rules, 'rules');
  if (list.length >= PAGE) throw new Error(`main has ${list.length} rules, past one page`);
  return list
    .filter((rule) => rule['type'] === 'required_status_checks')
    .flatMap((rule) => fieldList(fieldRecord(rule, 'parameters', 'rule'), 'required_status_checks', 'rule.parameters'))
    .map((check) => {
      const integration = check['integration_id'];
      if (integration !== undefined && (typeof integration !== 'number' || !Number.isInteger(integration))) throw new Error("GitHub's required check integration_id is not a whole number");
      return { context: fieldString(check, 'context', 'required check'), integrationId: integration };
    });
}

/** Every latest check run on `sha`, paged until GitHub's own count, so no run hides on a page left unread. */
async function checkRunsOf(get: (path: string) => Promise<unknown>, sha: string): Promise<readonly CheckRun[]> {
  const runs: CheckRun[] = [];
  for (let page = 1; page <= MAX_CHECK_PAGES; page++) {
    const body = recordOf(await get(`/commits/${sha}/check-runs?filter=latest&per_page=${PAGE}&page=${page}`), 'check runs');
    const total = fieldNumber(body, 'total_count', 'check runs');
    const list = fieldList(body, 'check_runs', 'check runs');
    runs.push(...list.map(checkRunOf));
    if (runs.length === total) return runs;
    if (list.length === 0 || runs.length > total) throw new Error(`the check runs read ${runs.length} of GitHub's count ${total}`);
  }
  throw new Error(`the check runs page past ${MAX_CHECK_PAGES * PAGE}`);
}

function checkRunOf(run: JsonRecord): CheckRun {
  const conclusion = run['conclusion'];
  if (conclusion !== null && typeof conclusion !== 'string') throw new Error("GitHub's check run conclusion is not a string");
  return {
    name: fieldString(run, 'name', 'check run'),
    status: fieldString(run, 'status', 'check run'),
    conclusion,
    appId: fieldNumber(fieldRecord(run, 'app', 'check run'), 'id', 'check run.app'),
  };
}

const requires = (check: RequiredCheck, run: CheckRun): boolean => check.context === run.name && (check.integrationId === undefined || check.integrationId === run.appId);

/**
 * Why the head's checks do not let it merge, or null: every run completed with success, or skipped where no rule
 * requires it (GitHub counts a skipped required check as passing, so the gate is stricter); each required check has a
 * successful run from the App its rule names; and the summary check passed, reported by GitHub Actions alone.
 */
export function checksRefusal(runs: readonly CheckRun[], required: readonly RequiredCheck[], summary: string): string | null {
  for (const run of runs) {
    if (run.status !== 'completed') return `check ${codeSpan(run.name)} is ${codeSpan(run.status)}`;
    if (run.conclusion === 'success') continue;
    const isRequired = required.some((check) => requires(check, run));
    if (run.conclusion === 'skipped' && !isRequired) continue;
    return `check ${codeSpan(run.name)} ended ${codeSpan(run.conclusion ?? 'without a conclusion')}${isRequired ? ', and main requires it' : ''}`;
  }
  for (const check of required) {
    if (!runs.some((run) => requires(check, run) && run.conclusion === 'success')) return `main requires check ${codeSpan(check.context)}, which has no successful run on the head`;
  }
  const summaries = runs.filter((run) => run.name === summary);
  if (summaries.some((run) => run.appId !== ACTIONS_APP_ID)) return `a check named ${codeSpan(summary)} comes from an App other than GitHub Actions`;
  return summaries.some((run) => run.conclusion === 'success') ? null : `check ${codeSpan(summary)} did not pass on the head`;
}

/** A JWT the GitHub App signs for itself (RS256), valid from a minute ago, for nine minutes, under the ten GitHub allows. */
export function appJwt(appId: number, privateKey: string, nowSeconds: number): string {
  const part = (value: JsonRecord): string => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = `${part({ alg: 'RS256', typ: 'JWT' })}.${part({ iat: nowSeconds - 60, exp: nowSeconds + 540, iss: appId })}`;
  return `${unsigned}.${createSign('RSA-SHA256').update(unsigned).sign(privateKey, 'base64url')}`;
}

export interface MergeTarget {
  readonly repo: string;
  readonly pr: number;
  /** The head the gate passed, which GitHub refuses to merge once the branch moved. */
  readonly sha: string;
  readonly checks: number;
  /** The paths the gate allowed, named in the comment. */
  readonly paths: readonly string[];
  /** This gate run's page. */
  readonly runUrl: string;
}

export interface AppKey {
  readonly appId: number;
  readonly privateKey: string;
}

export type MergeOutcome =
  | { readonly kind: 'merged'; readonly sha: string; readonly commented: boolean; readonly revoked: boolean }
  | { readonly kind: 'refused'; readonly reason: string; readonly revoked: boolean };

export interface MergeDeps {
  readonly api: GitHubApi;
  readonly nowSeconds: () => number;
}

/** The comment the merge leaves, which teamrig's GitHub watch pairs with each merge the App makes (T4712 C9). */
export function mergeComment(target: MergeTarget): string {
  return `Merged automatically by teamrig-release at ${codeSpan(target.sha)}: only ${target.paths.map(codeSpan).join(', ')} changed, ${target.checks} checks passed. Gate run: ${target.runUrl}`;
}

/**
 * Merges the release pull request at the gate's sha with an installation token of the App narrowed to this repository
 * and to contents and pull requests, leaves the gate comment, then revokes the token. A merge GitHub refuses (the head
 * moved, a rule unmet) is a refusal; a comment that fails after the merge is reported, never retried as a merge.
 */
export async function mergeRelease(target: MergeTarget, key: AppKey, deps: MergeDeps): Promise<MergeOutcome> {
  const jwt = appJwt(key.appId, key.privateKey, deps.nowSeconds());
  const installation = recordOf(await deps.api({ method: 'GET', path: `/repos/${target.repo}/installation`, token: jwt }), 'installation');
  const minted = recordOf(
    await deps.api({
      method: 'POST',
      path: `/app/installations/${fieldNumber(installation, 'id', 'installation')}/access_tokens`,
      token: jwt,
      body: { repositories: [target.repo.split('/')[1] ?? target.repo], permissions: { contents: 'write', pull_requests: 'write' } },
    }),
    'access token',
  );
  const token = fieldString(minted, 'token', 'access token');
  const landed = await mergeWith(target, deps.api, token);
  const revoked = await deps.api({ method: 'DELETE', path: '/installation/token', token }).then(
    () => true,
    () => false,
  );
  return { ...landed, revoked };
}

type Landed = { readonly kind: 'merged'; readonly sha: string; readonly commented: boolean } | { readonly kind: 'refused'; readonly reason: string };

async function mergeWith(target: MergeTarget, api: GitHubApi, token: string): Promise<Landed> {
  let merged: JsonRecord;
  try {
    merged = recordOf(await api({ method: 'PUT', path: `/repos/${target.repo}/pulls/${target.pr}/merge`, token, body: { sha: target.sha, merge_method: 'rebase' } }), 'merge');
  } catch (error) {
    return { kind: 'refused', reason: `GitHub refused the merge: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (merged['merged'] !== true || typeof merged['sha'] !== 'string') return { kind: 'refused', reason: 'GitHub did not report the pull request merged' };
  const sha = merged['sha'];
  const commented = await api({ method: 'POST', path: `/repos/${target.repo}/issues/${target.pr}/comments`, token, body: { body: mergeComment(target) } }).then(
    () => true,
    () => false,
  );
  return { kind: 'merged', sha, commented };
}
