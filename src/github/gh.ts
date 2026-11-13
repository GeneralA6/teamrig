import { spawn } from 'node:child_process';
import type { Env } from '../core/home.ts';
import { endOf, type ShellEnd } from '../test-run/shell.ts';
import { QUERY_VARIABLES, RAW_FIELD } from './queries.ts';

/**
 * The five kinds of `gh` command line teamrig runs: a page of a shipped issue query (the import, which never writes
 * to GitHub), the creation of one issue (gh migrate, which opens an issue for a team task), one comment on or the
 * close of one issue or pull request (issue comment and issue close), and the read of one pull request (whose branch
 * it is, which decides whether a session may write on it). The runner refuses any other command line before it
 * starts: no issue edit, reopen, label, assignee change, merge or delete.
 *
 * isIssueQuery is true for `gh api graphql -f query=<a text of queries.ts> -f <variable>=<value> ...` and nothing more: the query
 * word for word, each variable one it declares and given once, every field raw (`-f`). Any other flag (`-F`,
 * `--paginate`, `-X`, `--input`, `--hostname`) is refused, so the run cannot read a file or send another request.
 */
export function isIssueQuery(args: readonly string[]): boolean {
  if (args[0] !== 'api' || args[1] !== 'graphql') {
    return false;
  }
  const pairs = rawPairs(args.slice(2));
  const keys = pairs?.map(([key]) => key) ?? [];
  if (pairs === null || new Set(keys).size !== keys.length) {
    return false;
  }
  const query = new Map(pairs).get('query');
  const variables = query === undefined ? undefined : QUERY_VARIABLES.get(query);
  return variables !== undefined && keys.every((key) => key === 'query' || variables.has(key));
}

/**
 * A repository as GitHub names it, `owner/name`: an owner of letters, digits and `-`, a name of those and `.`
 * and `_` but never `.` or `..` alone, so the path can step to no other API.
 */
const REPO_NAME = /^[A-Za-z0-9-]+\/(?!\.\.?$)[A-Za-z0-9_.-]+$/;

/** The field gh sends as one item of the issue's label list. */
const LABEL_FIELD = 'labels[]';

/** One issue to open: its repository (`owner/name`), title, body and labels. */
export interface IssueDraft {
  readonly repo: string;
  readonly title: string;
  readonly body: string;
  readonly labels: readonly string[];
}

/** The command line that opens one issue: the REST create, every field raw, so no value is read as a file or a number. */
export function issueCreateArgs(draft: IssueDraft): string[] {
  return ['api', `repos/${draft.repo}/issues`, '-X', 'POST', RAW_FIELD, `title=${draft.title}`, RAW_FIELD, `body=${draft.body}`, ...draft.labels.flatMap((label) => [RAW_FIELD, `${LABEL_FIELD}=${label}`])];
}

/**
 * True for `gh api repos/<owner>/<name>/issues -X POST -f title=<t> -f body=<b> [-f labels[]=<l>]...`: one
 * issue created, its title and body given once each and any labels after them. A path past `issues` (an issue
 * number, comments, labels), another method, or any other flag or field is refused, so the run can create one
 * issue and change nothing else.
 */
export function isIssueCreate(args: readonly string[]): boolean {
  const path = args[1] ?? '';
  if (args[0] !== 'api' || !path.startsWith('repos/') || !path.endsWith('/issues') || args[2] !== '-X' || args[3] !== 'POST') {
    return false;
  }
  const pairs = rawPairs(args.slice(4));
  if (!REPO_NAME.test(path.slice('repos/'.length, -'/issues'.length)) || pairs === null || pairs.length < 2) {
    return false;
  }
  const [title, body, ...labels] = pairs;
  return title?.[0] === 'title' && body?.[0] === 'body' && labels.every(([key]) => key === LABEL_FIELD);
}

/** One issue or pull request of a repository (`owner/name`): GitHub numbers both in one sequence, and its issues API reaches either. */
export interface IssueNumber {
  readonly repo: string;
  readonly number: number;
}

/** The command line that posts one comment on an issue or pull request, its body a raw field so it stays text. */
export function issueCommentArgs(target: IssueNumber, body: string): string[] {
  return ['api', `repos/${target.repo}/issues/${target.number}/comments`, '-X', 'POST', RAW_FIELD, `body=${body}`];
}

/** The command line that closes one issue or pull request: the issues API closes a pull request too. */
export function issueCloseArgs(target: IssueNumber): string[] {
  return ['api', `repos/${target.repo}/issues/${target.number}`, '-X', 'PATCH', RAW_FIELD, 'state=closed'];
}

/** `repos/<owner>/<name>/issues/<number>`, then `/comments` or nothing: the paths of a comment and a close. */
const ISSUE_PATH = /^repos\/([^/]+\/[^/]+)\/issues\/([1-9][0-9]{0,9})(\/comments)?$/;

/** The method of `gh api <path> -X <method>`, and whether the path is the comments', when it is one issue's; else undefined. */
function issueCall(args: readonly string[]): { readonly method: string; readonly comments: boolean } | undefined {
  const match = ISSUE_PATH.exec(args[1] ?? '');
  const repo = match?.[1];
  const method = args[3];
  if (args[0] !== 'api' || match === null || repo === undefined || !REPO_NAME.test(repo) || args[2] !== '-X' || method === undefined) {
    return undefined;
  }
  return { method, comments: match[3] !== undefined };
}

/**
 * True for `gh api repos/<owner>/<name>/issues/<number>/comments -X POST -f body=<text>` and nothing more: one
 * comment, its body the only field. Another path, method, flag or field is refused, so the run edits, labels or
 * assigns nothing.
 */
export function isIssueComment(args: readonly string[]): boolean {
  const call = issueCall(args);
  const pairs = rawPairs(args.slice(4));
  return call?.method === 'POST' && call.comments && pairs?.length === 1 && pairs[0]?.[0] === 'body';
}

/** The command line that reads one pull request: a plain GET, so it changes nothing. */
export function pullReadArgs(target: IssueNumber): string[] {
  return ['api', `repos/${target.repo}/pulls/${target.number}`];
}

/** `repos/<owner>/<name>/pulls/<number>`: one pull request, nothing past it. */
const PULL_PATH = /^repos\/([^/]+\/[^/]+)\/pulls\/[1-9][0-9]{0,9}$/;

/**
 * True for `gh api repos/<owner>/<name>/pulls/<number>` and nothing more: the GET of one pull request. A method, a
 * field or any other flag is refused, since gh turns a field into a POST.
 */
export function isPullRead(args: readonly string[]): boolean {
  const repo = PULL_PATH.exec(args[1] ?? '')?.[1];
  return args.length === 2 && args[0] === 'api' && repo !== undefined && REPO_NAME.test(repo);
}

/**
 * True for `gh api repos/<owner>/<name>/issues/<number> -X PATCH -f state=closed` and nothing more: the close of
 * one issue or pull request. Any other field (a title, a body, labels, a reopen) is refused.
 */
export function isIssueClose(args: readonly string[]): boolean {
  const call = issueCall(args);
  const pairs = rawPairs(args.slice(4));
  return call?.method === 'PATCH' && !call.comments && pairs?.length === 1 && pairs[0]?.[0] === 'state' && pairs[0][1] === 'closed';
}

/** `-f key=value` pairs in order; null when anything else is there. */
function rawPairs(args: readonly string[]): Array<[string, string]> | null {
  const pairs: Array<[string, string]> = [];
  for (let at = 0; at < args.length; at += 2) {
    const flag = args[at];
    const field = args[at + 1];
    const equals = field?.indexOf('=') ?? -1;
    if (flag !== RAW_FIELD || field === undefined || equals < 1) {
      return null;
    }
    pairs.push([field.slice(0, equals), field.slice(equals + 1)]);
  }
  return pairs;
}

/** One `gh` run: its arguments, passed as a list and never read by a shell, and the environment. */
export interface GhRequest {
  readonly args: readonly string[];
  readonly env: Env;
}

export interface GhResult {
  readonly end: ShellEnd;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs the GitHub CLI to its end with no stdin. It rejects when `gh` cannot start, such as when it is not installed. */
export interface GhRunner {
  run(request: GhRequest): Promise<GhResult>;
}

/** How long one `gh` run may take before it is stopped: a page of a hundred issues takes seconds. */
export const GH_TIMEOUT_MS = 60_000;

/** A command line the runner will not start: none of a shipped issue query's page, one issue's creation, comment or close, one pull request's read. */
export class GhRefusedError extends Error {
  override readonly name = 'GhRefusedError';

  constructor(args: readonly string[]) {
    super(`teamrig only runs gh for its shipped issue queries, to open, comment on or close an issue and to read a pull request: it refuses gh ${args.slice(0, 2).join(' ')} with these arguments`);
  }
}

/** True for each command line the runner starts. */
export function isAllowedGh(args: readonly string[]): boolean {
  return isIssueQuery(args) || isIssueCreate(args) || isIssueComment(args) || isIssueClose(args) || isPullRead(args);
}

/**
 * The real runner: `spawn` with no shell, so an issue title or a repository name can never become a
 * command. gh is told never to prompt, as nobody is there to answer. `program` and `leading` let a test
 * stand a Node script in for gh.
 */
export function nodeGhRunner(program = 'gh', leading: readonly string[] = [], timeoutMs = GH_TIMEOUT_MS): GhRunner {
  return {
    run: (request) => {
      if (!isAllowedGh(request.args)) {
        return Promise.reject(new GhRefusedError(request.args));
      }
      return new Promise((resolve, reject) => {
        const child = spawn(program, [...leading, ...request.args], {
          env: { ...request.env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' },
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: timeoutMs,
          windowsHide: true,
        });
        const stdout: string[] = [];
        const stderr: string[] = [];
        child.stdout.setEncoding('utf8').on('data', (chunk: string) => stdout.push(chunk));
        child.stderr.setEncoding('utf8').on('data', (chunk: string) => stderr.push(chunk));
        child.once('error', reject);
        child.once('close', (code, signal) => resolve({ end: endOf(code, signal), stdout: stdout.join(''), stderr: stderr.join('') }));
      });
    },
  };
}
