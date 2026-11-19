import { spawn } from 'node:child_process';
import type { Env } from '../core/home.ts';
import { endOf, type ShellEnd } from '../core/shell-end.ts';
import type { CloseReason, IssueDraft, LabelSpec } from '../issues/host.ts';
import { LABEL_FILE, parseLabelFile } from '../issues/label-file.ts';
import { areaLabelSpec, MANAGED_LABEL_SPECS } from '../issues/managed-labels.ts';
import { labelRefusal } from '../issues/write.ts';
import { GH_PROGRAM } from './gh-program.ts';
import { QUERY_VARIABLES, RAW_FIELD } from './queries.ts';

/**
 * The kinds of `gh` command line teamrig runs: a page of a shipped query (the issue import, the links read and the
 * pull request monitor, which never write to GitHub), the creation of one issue (issue migrate, which opens an issue for a team task), one
 * comment on or the close of one issue or pull request (issue reply and issue close, a close with or without its
 * reason), its body replaced (issue edit), its labels: the read of one label of a repository, labels added to one
 * issue, one label taken off it (issue label), the read of one issue, for the id a duplicate close names (issue close
 * --duplicate-of), logins added to one issue's assignees, the read of one user, for the case GitHub spells its login
 * in, the read of whether one login may be assigned (the status push) or assigned to one issue (issue assign, which
 * also reads the issue for its labels), one login taken off one issue's
 * assignees (a claim the sync made that ran out), the creation of one of the labels teamrig makes (the status push
 * and issue label), one sub-issue or blocked-by link added (issue links), and `issue watch`'s two probes,
 * conditional reads that tell whether a repository changed (isWatchProbe), the read of one failed Actions job's log
 * (the pull request monitor names its failed step), and the reads of a repository's comments, review comments, issue
 * and pull request bodies changed since a time and of one pull request's reviews (the mention scan). The runner
 * refuses any other command line before it starts: no title or state edit besides the close, no reopen, removal of
 * more than one assignee at once, label create but teamrig's own, label edit or delete, link removal, merge, branch
 * delete, run rerun or cancel, or log download.
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

/** The field gh sends as one item of the issue's assignee list. */
const ASSIGNEE_FIELD = 'assignees[]';

/** A GitHub login: letters, digits and single inner hyphens, at most 39, so it can name no other path or field. */
const LOGIN = /^[A-Za-z0-9](?:-?[A-Za-z0-9]){0,38}$/u;

/** Whether `login` has the shape of a GitHub login. */
export function isLogin(login: string): boolean {
  return LOGIN.test(login);
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

/** GitHub's word for each close reason, as its REST API takes it in `state_reason`. */
const GITHUB_CLOSE_REASON: Readonly<Record<CloseReason, string>> = { completed: 'completed', 'not-planned': 'not_planned', duplicate: 'duplicate' };

/** The `state_reason` values a close may send: never `reopened`, which is not a close. */
const CLOSE_REASON_VALUES: ReadonlySet<string> = new Set(Object.values(GITHUB_CLOSE_REASON));

/**
 * gh's flag for a typed field: GitHub takes a duplicate's or a link's issue id only as a number, not as the string
 * `-f` sends. gh reads a `-F` value starting with `@` from a file, so the close and isLinkAdd take digits alone there:
 * the value can only be the integer GitHub asks for.
 */
const TYPED_FIELD = '-F';

/** The field naming the issue a duplicate close duplicates, by its id (not its number). */
const DUPLICATE_FIELD = 'duplicate_issue_id';

/** `duplicate_issue_id=<id>`: a positive id of digits only, so no `@file` or other gh value form can ride on it. */
const DUPLICATE_PAIR = new RegExp(`^${DUPLICATE_FIELD}=[1-9][0-9]{0,15}$`, 'u');

/**
 * The command line that closes one issue or pull request, with the reason when one is given: the issues API closes a
 * pull request too, and GitHub keeps a reason only for an issue. A duplicate close names the issue it duplicates by
 * `duplicateId`, GitHub's id of it, which GitHub shows as the duplicate link; any other reason ignores it.
 */
export function issueCloseArgs(target: IssueNumber, reason?: CloseReason, duplicateId?: number): string[] {
  const why = reason === undefined ? [] : [RAW_FIELD, `state_reason=${GITHUB_CLOSE_REASON[reason]}`];
  const of = reason === 'duplicate' && duplicateId !== undefined ? [TYPED_FIELD, `${DUPLICATE_FIELD}=${duplicateId}`] : [];
  return ['api', `repos/${target.repo}/issues/${target.number}`, '-X', 'PATCH', RAW_FIELD, 'state=closed', ...why, ...of];
}

/** The command line that reads one issue or pull request, for its id or its labels. */
export function issueReadArgs(target: IssueNumber): string[] {
  return ['api', `repos/${target.repo}/issues/${target.number}`, '-X', 'GET'];
}

/** The comments one read of an issue's new comments gives at most, oldest first: the first claim among them wins. */
export const COMMENTS_PAGE = 30;

/**
 * The command line that reads the comments of one issue updated at or after `since` (an ISO time), oldest first, at
 * most COMMENTS_PAGE: the only read of comment text, which the claim pass matches and drops (src/github/host.ts).
 */
export function commentsReadArgs(target: IssueNumber, since: string): string[] {
  return ['api', `repos/${target.repo}/issues/${target.number}/comments`, '-X', 'GET', RAW_FIELD, `since=${since}`, RAW_FIELD, `per_page=${COMMENTS_PAGE}`];
}

/** A UTC time as Date.toISOString writes it. */
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** The command line that replaces the body of one issue or pull request, the body a raw field so it stays text. */
export function issueBodyArgs(target: IssueNumber, body: string): string[] {
  return ['api', `repos/${target.repo}/issues/${target.number}`, '-X', 'PATCH', RAW_FIELD, `body=${body}`];
}

/** The command line that adds `labels` to one issue or pull request, each a raw item of the label list. */
export function issueLabelAddArgs(target: IssueNumber, labels: readonly string[]): string[] {
  return ['api', `repos/${target.repo}/issues/${target.number}/labels`, '-X', 'POST', ...labels.flatMap((label) => [RAW_FIELD, `${LABEL_FIELD}=${label}`])];
}

/** The command line that takes `label` off one issue or pull request: the name goes in the path, encoded. */
export function issueLabelRemoveArgs(target: IssueNumber, label: string): string[] {
  return ['api', `repos/${target.repo}/issues/${target.number}/labels/${encodeURIComponent(label)}`, '-X', 'DELETE'];
}

/** The command line that adds `logins` to the assignees of one issue or pull request; those already on it stay. */
export function issueAssignArgs(target: IssueNumber, logins: readonly string[]): string[] {
  return ['api', `repos/${target.repo}/issues/${target.number}/assignees`, '-X', 'POST', ...logins.flatMap((login) => [RAW_FIELD, `${ASSIGNEE_FIELD}=${login}`])];
}

/** The command line that takes one `login` off the assignees of one issue or pull request; any others stay. */
export function issueUnassignArgs(target: IssueNumber, login: string): string[] {
  return ['api', `repos/${target.repo}/issues/${target.number}/assignees`, '-X', 'DELETE', RAW_FIELD, `${ASSIGNEE_FIELD}=${login}`];
}

/** The command line that reads whether `login` may be assigned in `repo`, which fails when it may not. */
export function assigneeReadArgs(repo: string, login: string): string[] {
  return ['api', `repos/${repo}/assignees/${login}`];
}

/**
 * The command line that reads whether `login` may be assigned to one issue or pull request, which fails when it may
 * not: GitHub takes one with access to the repository, and also one who took part in that item (issue assign).
 */
export function issueAssigneeReadArgs(target: IssueNumber, login: string): string[] {
  return ['api', `repos/${target.repo}/issues/${target.number}/assignees/${login}`];
}

/** The command line that reads one GitHub user, whose `login` is spelled in the case GitHub keeps; it fails when there is no such user. */
export function userReadArgs(login: string): string[] {
  return ['api', `users/${login}`];
}

/**
 * The command line that reads the user the token belongs to, the login the sync runs as: the status push assigns it
 * an issue whose session maps to no login (T4581). Only its `login` is read from the answer.
 */
export function viewerReadArgs(): string[] {
  return ['api', 'user'];
}

/** The command line that makes `label` in `repo`: its name, colour and description, each a raw field. */
export function labelCreateArgs(repo: string, label: LabelSpec): string[] {
  return ['api', `repos/${repo}/labels`, '-X', 'POST', '-f', `name=${label.name}`, '-f', `color=${label.color}`, '-f', `description=${label.description}`];
}

/** The command line that reads one label of a repository, which fails when the repository has no such label. */
export function labelReadArgs(repo: string, label: string): string[] {
  return ['api', `repos/${repo}/labels/${encodeURIComponent(label)}`];
}

/**
 * The characters encodeURIComponent leaves in a path segment, and its %XX escapes, so a `/`, `?` or `#` in a label
 * name stays inside the one segment.
 */
const LABEL_SEGMENT = /^(?:[A-Za-z0-9_.!~*'()-]|%[0-9A-F]{2})+$/;

/**
 * Whether `segment` is exactly what encodeURIComponent writes for a label name other than `.` or `..`, which would
 * step up the path. The shape alone would take an escape the encoder never writes, such as `%2E%2E`, which a server
 * may decode to `..`; requiring the encoder's one spelling closes that.
 */
function isLabelSegment(segment: string): boolean {
  if (!LABEL_SEGMENT.test(segment)) {
    return false;
  }
  let name: string;
  try {
    name = decodeURIComponent(segment);
  } catch {
    return false;
  }
  return name !== '.' && name !== '..' && encodeURIComponent(name) === segment;
}

/** `repos/<owner>/<name>/issues/<number>`, then `/comments`, `/labels`, `/labels/<label>`, `/assignees` or nothing. */
const ISSUE_PATH = /^repos\/([^/]+\/[^/]+)\/issues\/([1-9][0-9]{0,9})(\/comments|\/labels|\/labels\/[^/]+|\/assignees)?$/;

/** What follows the issue in its path: its comments, its labels, one label of it, its assignees, or nothing (the issue itself). */
type IssuePart = 'comments' | 'labels' | 'label' | 'assignees' | 'issue';

/** The parts a path names by a fixed tail. */
const LIST_PARTS: ReadonlyMap<string, IssuePart> = new Map([
  ['/comments', 'comments'],
  ['/labels', 'labels'],
  ['/assignees', 'assignees'],
]);

/** The method of `gh api <path> -X <method>`, and the part of the issue the path names, when it is one issue's; else undefined. */
function issueCall(args: readonly string[]): { readonly method: string; readonly part: IssuePart } | undefined {
  const match = ISSUE_PATH.exec(args[1] ?? '');
  const repo = match?.[1];
  const method = args[3];
  if (args[0] !== 'api' || match === null || repo === undefined || !REPO_NAME.test(repo) || args[2] !== '-X' || method === undefined) {
    return undefined;
  }
  const tail = match[3];
  if (tail === undefined) {
    return { method, part: 'issue' };
  }
  const part = LIST_PARTS.get(tail);
  if (part !== undefined) {
    return { method, part };
  }
  return isLabelSegment(tail.slice('/labels/'.length)) ? { method, part: 'label' } : undefined;
}

/**
 * True for `gh api repos/<owner>/<name>/issues/<number>/comments -X POST -f body=<text>` and nothing more: one
 * comment, its body the only field. Another path, method, flag or field is refused, so the run edits, labels or
 * assigns nothing.
 */
export function isIssueComment(args: readonly string[]): boolean {
  const call = issueCall(args);
  const pairs = rawPairs(args.slice(4));
  return call?.method === 'POST' && call.part === 'comments' && pairs?.length === 1 && pairs[0]?.[0] === 'body';
}

/**
 * True for `gh api repos/<owner>/<name>/issues/<number> -X PATCH -f state=closed [-f state_reason=<reason>]`, a
 * duplicate close also with `-F duplicate_issue_id=<digits>` last, and nothing more: the close of one issue or pull
 * request, with completed, not_planned or duplicate as its reason. Any other field (a title, a body, labels, a reopen),
 * or the duplicate's id with another reason, is refused.
 */
export function isIssueClose(args: readonly string[]): boolean {
  const call = issueCall(args);
  const fields = args.slice(4);
  const typed = fields.at(-2) === TYPED_FIELD ? fields.slice(-2) : [];
  const [state, reason, ...rest] = rawPairs(fields.slice(0, fields.length - typed.length)) ?? [];
  const closes = state?.[0] === 'state' && state[1] === 'closed';
  const why = reason === undefined || (reason[0] === 'state_reason' && CLOSE_REASON_VALUES.has(reason[1]));
  const of = typed.length === 0 || (reason?.[1] === GITHUB_CLOSE_REASON.duplicate && DUPLICATE_PAIR.test(typed[1] ?? ''));
  return call?.method === 'PATCH' && call.part === 'issue' && closes && why && of && rest.length === 0;
}

/**
 * True for `gh api repos/<owner>/<name>/issues/<number> -X GET` and nothing more: the read of one issue. A field
 * (which gh would send as a query, or turn the call into a write) is refused.
 */
export function isIssueRead(args: readonly string[]): boolean {
  const call = issueCall(args);
  return call?.method === 'GET' && call.part === 'issue' && args.length === 4;
}

/**
 * True for `gh api repos/<owner>/<name>/issues/<number>/comments -X GET -f since=<ISO time> -f per_page=30` and
 * nothing more: one page of one issue's newest comments. Another field (which gh sends as a query), page size,
 * `--paginate` or method is refused, so the read stays one bounded page.
 */
export function isCommentsRead(args: readonly string[]): boolean {
  const call = issueCall(args);
  const [since, page, ...rest] = rawPairs(args.slice(4)) ?? [];
  return (
    call?.method === 'GET' &&
    call.part === 'comments' &&
    since?.[0] === 'since' &&
    ISO_TIME.test(since[1]) &&
    page?.[0] === 'per_page' &&
    page[1] === String(COMMENTS_PAGE) &&
    rest.length === 0
  );
}

/**
 * True for `gh api repos/<owner>/<name>/issues/<number> -X PATCH -f body=<text>` and nothing more: the body of one
 * issue or pull request replaced, the body the only field. A title, state, assignee, label or milestone field, or
 * any field beside the body, is refused, so the edit changes the text and nothing else.
 */
export function isIssueBodyEdit(args: readonly string[]): boolean {
  const call = issueCall(args);
  const pairs = rawPairs(args.slice(4));
  return call?.method === 'PATCH' && call.part === 'issue' && pairs?.length === 1 && pairs[0]?.[0] === 'body';
}

/**
 * True for `gh api repos/<owner>/<name>/issues/<number>/labels -X POST -f labels[]=<label> ...` and nothing more:
 * one or more labels added to one issue or pull request. Another field, flag or method (PUT, which would replace
 * every label) is refused.
 */
export function isLabelAdd(args: readonly string[]): boolean {
  const call = issueCall(args);
  const pairs = rawPairs(args.slice(4));
  return call?.method === 'POST' && call.part === 'labels' && pairs !== null && pairs.length > 0 && pairs.every(([key]) => key === LABEL_FIELD);
}

/**
 * True for `gh api repos/<owner>/<name>/issues/<number>/labels/<label> -X DELETE` and nothing more: one label taken
 * off one issue or pull request. The repository's label itself stays; a field, a flag, or the DELETE of all labels
 * is refused.
 */
export function isLabelRemove(args: readonly string[]): boolean {
  const call = issueCall(args);
  return call?.method === 'DELETE' && call.part === 'label' && args.length === 4;
}

/**
 * True for `gh api repos/<owner>/<name>/issues/<number>/assignees -X POST -f assignees[]=<login> ...` and nothing
 * more: one or more logins added to the assignees of one issue or pull request. Another field, flag or method (DELETE
 * takes assignees off: isIssueUnassign) is refused, and each login must have a login's shape.
 */
export function isIssueAssign(args: readonly string[]): boolean {
  const call = issueCall(args);
  const pairs = rawPairs(args.slice(4));
  return call?.method === 'POST' && call.part === 'assignees' && pairs !== null && pairs.length > 0 && pairs.every(([key, login]) => key === ASSIGNEE_FIELD && isLogin(login));
}

/**
 * True for `gh api repos/<owner>/<name>/issues/<number>/assignees -X DELETE -f assignees[]=<login>` and nothing more:
 * exactly one login, of a login's shape, taken off one issue or pull request. The sync sends it only for a claim it
 * made itself whose login is still the assignee (issues/claim.ts), and issue assign once for each login a maintainer
 * names (issues/assign.ts); two logins, no login, another field or flag is refused, so no run can clear an issue's
 * assignees at once.
 */
export function isIssueUnassign(args: readonly string[]): boolean {
  const call = issueCall(args);
  const pairs = rawPairs(args.slice(4));
  const only = pairs?.length === 1 ? pairs[0] : undefined;
  return call?.method === 'DELETE' && call.part === 'assignees' && only !== undefined && only[0] === ASSIGNEE_FIELD && isLogin(only[1]);
}

/** `repos/<owner>/<name>/assignees/<login>`: whether one login may be assigned in a repository. */
const ASSIGNEE_PATH = /^repos\/([^/]+\/[^/]+)\/assignees\/([^/]+)$/;

/**
 * True for `gh api repos/<owner>/<name>/assignees/<login>` and nothing more: a read, gh's default GET, of whether the
 * login may be assigned there. A method or field is refused.
 */
export function isAssigneeRead(args: readonly string[]): boolean {
  const match = ASSIGNEE_PATH.exec(args[1] ?? '');
  return args[0] === 'api' && args.length === 2 && match !== null && REPO_NAME.test(match[1] ?? '') && isLogin(match[2] ?? '');
}

/** `repos/<owner>/<name>/issues/<number>/assignees/<login>`: whether one login may be assigned to one issue. */
const ISSUE_ASSIGNEE_PATH = /^repos\/([^/]+\/[^/]+)\/issues\/[1-9][0-9]{0,9}\/assignees\/([^/]+)$/u;

/**
 * True for `gh api repos/<owner>/<name>/issues/<number>/assignees/<login>` and nothing more: a read, gh's default
 * GET, of whether the login may be assigned to that issue or pull request. A method or field is refused.
 */
export function isIssueAssigneeRead(args: readonly string[]): boolean {
  const match = ISSUE_ASSIGNEE_PATH.exec(args[1] ?? '');
  return args[0] === 'api' && args.length === 2 && match !== null && REPO_NAME.test(match[1] ?? '') && isLogin(match[2] ?? '');
}

/** `users/<login>`: one GitHub user. */
const USER_PATH = /^users\/([^/]+)$/u;

/**
 * True for `gh api users/<login>` and nothing more: a read, gh's default GET, of one user's public profile, which
 * gives the login in the case GitHub keeps. A method, a field or a path below the user is refused.
 */
export function isUserRead(args: readonly string[]): boolean {
  const match = USER_PATH.exec(args[1] ?? '');
  return args[0] === 'api' && args.length === 2 && match !== null && isLogin(match[1] ?? '');
}

/**
 * True for `gh api user` and nothing more, as viewerReadArgs builds it: a read, gh's default GET, of the user the
 * token belongs to. A method, a field, a filter or a path below the user (such as its e-mails or keys) is refused.
 */
export function isViewerRead(args: readonly string[]): boolean {
  return args.length === 2 && args[0] === 'api' && args[1] === 'user';
}

/** `repos/<owner>/<name>/labels`: the labels of a repository, where a POST makes one. */
const LABELS_PATH = /^repos\/([^/]+\/[^/]+)\/labels$/u;

/** The labels a repository's own label file named, as the runner read it: none for a file it has not read. */
export type FileLabels = (repo: string) => readonly LabelSpec[];

/**
 * True for the command line labelCreateArgs builds for one of the labels teamrig makes (MANAGED_LABEL_SPECS: the
 * status push's own and the design label) and nothing more: its name, colour and description word for word, in that
 * order. So the runner makes no other label (beside one isAreaLabelCreate or isFileLabelCreate takes), and edits or
 * deletes none, whatever a caller passes.
 */
export function isLabelCreate(args: readonly string[]): boolean {
  return labelCreateIn(args, () => MANAGED_LABEL_SPECS);
}

/**
 * True for the command line labelCreateArgs builds for an area label (areaLabelSpec): a name a host takes, in the one
 * area colour and description, word for word. Which names are areas is the team's github.areaOwners, which issue label
 * checks before the create (issues/write.ts); the runner holds the create to that one look, so it makes no label in a
 * look of the caller's choosing.
 */
export function isAreaLabelCreate(args: readonly string[]): boolean {
  const field = args[5] ?? '';
  const name = field.startsWith('name=') ? field.slice('name='.length) : '';
  return labelRefusal(name) === undefined && labelCreateIn(args, () => [areaLabelSpec(name)]);
}

/**
 * True for the command line labelCreateArgs builds for a label the repository's own label file names, as the runner
 * read it (`fileLabels`), word for word as isLabelCreate takes a managed one. A file the runner has not read names none.
 */
export function isFileLabelCreate(args: readonly string[], fileLabels: FileLabels): boolean {
  return labelCreateIn(args, fileLabels);
}

/** True for labelCreateArgs's line for one of the labels `labelsOf` gives its repository, word for word. */
function labelCreateIn(args: readonly string[], labelsOf: FileLabels): boolean {
  const repo = LABELS_PATH.exec(args[1] ?? '')?.[1] ?? '';
  return args[0] === 'api' && REPO_NAME.test(repo) && labelsOf(repo).some((label) => sameArgs(args, labelCreateArgs(repo, label)));
}

/** The media type GitHub answers a file's raw bytes with, rather than JSON holding them in base64. */
const RAW_ACCEPT = 'Accept: application/vnd.github.raw+json';

/** The command line that reads `repo`'s label file (LABEL_FILE) as it stands on the default branch, raw. */
export function labelFileReadArgs(repo: string): string[] {
  return ['api', '-H', RAW_ACCEPT, `repos/${repo}/contents/${LABEL_FILE}`];
}

/** `repos/<owner>/<name>/contents/.github/labels.json`, the path of a repository's label file. */
const LABEL_FILE_PATH = new RegExp(`^repos/([^/]+/[^/]+)/contents/${LABEL_FILE.replace(/[.]/g, '\\.')}$`, 'u');

/** The repository whose label file the command line reads, or undefined when it is not labelFileReadArgs's line. */
export function labelFileRepoOf(args: readonly string[]): string | undefined {
  const repo = LABEL_FILE_PATH.exec(args[3] ?? '')?.[1];
  return args.length === 4 && args[0] === 'api' && args[1] === '-H' && args[2] === RAW_ACCEPT && repo !== undefined && REPO_NAME.test(repo) ? repo : undefined;
}

/**
 * True for labelFileReadArgs's line and nothing more: a read, gh's default GET, of the one file at LABEL_FILE, with
 * the one raw header. A method, a field, another header or another path is refused.
 */
export function isLabelFileRead(args: readonly string[]): boolean {
  return labelFileRepoOf(args) !== undefined;
}

/**
 * The labels each repository's label file named when this runner read it, so a create of one of them is allowed
 * (isLabelCreate). Only a read that ended well and printed a well-formed file counts; any other keeps nothing.
 */
export class LabelFileReads {
  private readonly byRepo = new Map<string, readonly LabelSpec[]>();

  /** Notes what one run printed, when it was a read of a label file: its labels if it ended well and parses, else none. */
  note(args: readonly string[], result: GhResult): void {
    const repo = labelFileRepoOf(args);
    if (repo === undefined) {
      return;
    }
    this.byRepo.delete(repo.toLowerCase());
    if (result.end.kind !== 'exited' || result.end.code !== 0) {
      return;
    }
    try {
      this.byRepo.set(repo.toLowerCase(), parseLabelFile(result.stdout));
    } catch {
      // A malformed file names no label to make; the host's own read of it says why.
    }
  }

  /** The labels `repo`'s file named at its last read; none before one, or after one that failed. */
  readonly of: FileLabels = (repo) => this.byRepo.get(repo.toLowerCase()) ?? [];
}

/** True when the two command lines are the same, word for word. */
function sameArgs(args: readonly string[], want: readonly string[]): boolean {
  return args.length === want.length && want.every((arg, at) => args[at] === arg);
}

/** `repos/<owner>/<name>/labels/<label>`: one label of a repository. */
const LABEL_PATH = /^repos\/([^/]+\/[^/]+)\/labels\/([^/]+)$/;

/**
 * True for `gh api repos/<owner>/<name>/labels/<label>` and nothing more: a read of one label, gh's default GET. A
 * method or field (which would create, edit or delete the label) is refused.
 */
export function isLabelRead(args: readonly string[]): boolean {
  const match = LABEL_PATH.exec(args[1] ?? '');
  return args[0] === 'api' && args.length === 2 && match !== null && REPO_NAME.test(match[1] ?? '') && isLabelSegment(match[2] ?? '');
}

/**
 * The REST reads `issue watch` probes each repository with: the issue or pull request changed last (a comment, a
 * review or a label moves it; pull requests are issues here) and the latest workflow runs. Each is one fixed GET.
 */
export const WATCH_PATHS = ['issues?state=all&sort=updated&per_page=1', 'actions/runs?per_page=5'] as const;
export type WatchPath = (typeof WATCH_PATHS)[number];

/** The header a probe sends to be told only whether the answer changed: GitHub answers 304, free, when it did not. */
const IF_NONE_MATCH = 'If-None-Match: ';

/**
 * An entity tag as GitHub sends one, strong or weak: quoted, of printable characters only (RFC 9110's etagc), at most
 * 200 of them, so a tag can never add a header line or a flag.
 */
export const ENTITY_TAG = /^(?:W\/)?"[\x21\x23-\x7E]{1,200}"$/;

/** The command line of one probe: `gh api -i [-H "If-None-Match: <tag>"] repos/<owner>/<name>/<path>`. */
export function watchProbeArgs(repo: string, path: WatchPath, tag: string | undefined): string[] {
  return ['api', '-i', ...(tag === undefined ? [] : ['-H', `${IF_NONE_MATCH}${tag}`]), `repos/${repo}/${path}`];
}

/**
 * True for `gh api -i [-H "If-None-Match: <tag>"] repos/<owner>/<name>/<path>`, a path of WATCH_PATHS, and nothing
 * more: one GET with its headers printed, and at most that one header, its tag an ENTITY_TAG. A method, a field,
 * another header or path, `--paginate` or `--hostname` is refused, so a probe can only read those two answers.
 */
export function isWatchProbe(args: readonly string[]): boolean {
  if (args[0] !== 'api' || args[1] !== '-i' || (args.length !== 3 && args.length !== 5)) {
    return false;
  }
  if (args.length === 5) {
    const header = args[3] ?? '';
    if (args[2] !== '-H' || !header.startsWith(IF_NONE_MATCH) || !ENTITY_TAG.test(header.slice(IF_NONE_MATCH.length))) {
      return false;
    }
  }
  const path = args[args.length - 1] ?? '';
  return path.startsWith('repos/') && WATCH_PATHS.some((probe) => path.endsWith(`/${probe}`) && REPO_NAME.test(path.slice('repos/'.length, -(probe.length + 1))));
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

/** The command line that reads the failed steps' log of one Actions job of `repo`, the job named by its id. */
export function jobLogArgs(repo: string, jobId: number): string[] {
  return ['run', 'view', '--job', String(jobId), '--log-failed', '--repo', repo];
}

/** An Actions job's id: a positive whole number, never a flag or a path. */
const JOB_ID = /^[1-9][0-9]{0,15}$/;

/**
 * True for `gh run view --job <id> --log-failed --repo <owner>/<name>` and nothing more: the failed steps' log of one
 * job printed, a read. Any other flag (`--web`, `--exit-status`, `--log`), order or subcommand (`rerun`, `cancel`,
 * `download`) is refused, so the run cannot change a run, open a browser or write a file.
 */
export function isJobLogRead(args: readonly string[]): boolean {
  return (
    args.length === 7 &&
    args[0] === 'run' &&
    args[1] === 'view' &&
    args[2] === '--job' &&
    JOB_ID.test(args[3] ?? '') &&
    args[4] === '--log-failed' &&
    args[5] === '--repo' &&
    REPO_NAME.test(args[6] ?? '')
  );
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

/**
 * The bytes one `gh` run may print, stdout and stderr together, before it is stopped. The largest answer teamrig
 * asks for is a page of a hundred issues, each body at most 65,536 characters (about 20 MB in the worst UTF-8); the
 * cap sits above it, so text people post can never grow one run's memory without bound.
 */
export const GH_OUTPUT_MAX_BYTES = 32 * 1024 * 1024;

/** A `gh` run stopped for printing more than its cap; nothing it printed is used. */
export class GhOutputCapError extends Error {
  override readonly name = 'GhOutputCapError';

  constructor(maxBytes: number) {
    super(`gh printed more than ${maxBytes} bytes, so teamrig stopped it and used none of it`);
  }
}

/** A host id as a link write sends it: 1 to 15 digits, so it stays an exact JavaScript number. */
export const HOST_ID = /^[1-9][0-9]{0,14}$/;

/** The id field of each link endpoint: a sub-issue's, and the blocking issue's. */
const LINK_FIELDS: ReadonlyMap<string, string> = new Map([
  ['sub_issues', 'sub_issue_id'],
  ['dependencies/blocked_by', 'issue_id'],
]);

/** `repos/<owner>/<name>/issues/<number>/` then a link endpoint. */
const LINK_PATH = /^repos\/([^/]+\/[^/]+)\/issues\/([1-9][0-9]{0,9})\/(sub_issues|dependencies\/blocked_by)$/;

/** The command line that puts the issue whose id is `childId` under `parent` as its sub-issue. */
export function subIssueAddArgs(parent: IssueNumber, childId: number): string[] {
  return ['api', `repos/${parent.repo}/issues/${parent.number}/sub_issues`, '-X', 'POST', TYPED_FIELD, `sub_issue_id=${childId}`];
}

/** The command line that marks `target` blocked by the issue whose id is `blockerId`. */
export function blockedByAddArgs(target: IssueNumber, blockerId: number): string[] {
  return ['api', `repos/${target.repo}/issues/${target.number}/dependencies/blocked_by`, '-X', 'POST', TYPED_FIELD, `issue_id=${blockerId}`];
}

/**
 * True for `gh api repos/<owner>/<name>/issues/<number>/sub_issues -X POST -F sub_issue_id=<id>` and for
 * `.../dependencies/blocked_by -X POST -F issue_id=<id>`, and nothing more: one link added, its id digits only.
 * Another path, method (a DELETE that removes a link, a PATCH that reorders), field or flag is refused.
 */
export function isLinkAdd(args: readonly string[]): boolean {
  const match = LINK_PATH.exec(args[1] ?? '');
  const repo = match?.[1];
  const key = match?.[3] === undefined ? undefined : LINK_FIELDS.get(match[3]);
  const field = args[5] ?? '';
  const equals = field.indexOf('=');
  return (
    args.length === 6 &&
    args[0] === 'api' &&
    repo !== undefined &&
    REPO_NAME.test(repo) &&
    args[2] === '-X' &&
    args[3] === 'POST' &&
    args[4] === TYPED_FIELD &&
    key !== undefined &&
    field.slice(0, equals) === key &&
    HOST_ID.test(field.slice(equals + 1))
  );
}

/** `repos/<owner>/<name>/issues/<number>/issue-field-values`: the values of one issue's fields. */
const FIELD_VALUES_PATH = /^repos\/([^/]+\/[^/]+)\/issues\/([1-9][0-9]{0,9})\/issue-field-values$/;

/** The id of the field a value is for. */
const FIELD_ID_KEY = 'issue_field_values[][field_id]';

/** The value itself: text, a day or an option's name as a raw field, a number as a typed one. */
const FIELD_VALUE_KEY = 'issue_field_values[][value]';

/** A number field's value as a typed field takes it: a whole number of digits only, so no `@file` or other gh form rides on it. */
const FIELD_NUMBER = /^-?(0|[1-9][0-9]{0,14})$/;

/** A field's text, day, option or type name: one bounded line, so nothing beside the value can be read into it. */
const FIELD_TEXT = /^[^\p{Cc}]{1,1024}$/u;

/**
 * The command line that sets one field of `target` to `value`: the field by its id, a number as a typed field, else
 * raw text (a day as `YYYY-MM-DD`, a single-select by its option's name). Only that field changes; the others stay.
 */
export function fieldValueSetArgs(target: IssueNumber, fieldId: number, value: string | number): string[] {
  const set = typeof value === 'number' ? [TYPED_FIELD, `${FIELD_VALUE_KEY}=${value}`] : [RAW_FIELD, `${FIELD_VALUE_KEY}=${value}`];
  return ['api', `repos/${target.repo}/issues/${target.number}/issue-field-values`, '-X', 'POST', TYPED_FIELD, `${FIELD_ID_KEY}=${fieldId}`, ...set];
}

/**
 * True for `gh api repos/<owner>/<name>/issues/<number>/issue-field-values -X POST -F <field_id>=<id>` then the value,
 * `-f <value>=<line>` or `-F <value>=<whole number>`, and nothing more: one field of one issue set, its id digits only.
 * A second value, another method (a PUT that replaces every value, a DELETE), field or flag is refused.
 */
export function isFieldValueSet(args: readonly string[]): boolean {
  const match = FIELD_VALUES_PATH.exec(args[1] ?? '');
  const repo = match?.[1];
  const id = args[5] ?? '';
  const value = args[7] ?? '';
  const valuePrefix = `${FIELD_VALUE_KEY}=`;
  const shown = value.slice(valuePrefix.length);
  const valueOk = value.startsWith(valuePrefix) && ((args[6] === RAW_FIELD && FIELD_TEXT.test(shown)) || (args[6] === TYPED_FIELD && FIELD_NUMBER.test(shown)));
  return (
    args.length === 8 &&
    args[0] === 'api' &&
    repo !== undefined &&
    REPO_NAME.test(repo) &&
    args[2] === '-X' &&
    args[3] === 'POST' &&
    args[4] === TYPED_FIELD &&
    id.startsWith(`${FIELD_ID_KEY}=`) &&
    HOST_ID.test(id.slice(FIELD_ID_KEY.length + 1)) &&
    valueOk
  );
}

/** The command line that sets the type of one issue to `type`, by its name, a raw field. */
export function issueTypeSetArgs(target: IssueNumber, type: string): string[] {
  return ['api', `repos/${target.repo}/issues/${target.number}`, '-X', 'PATCH', RAW_FIELD, `type=${type}`];
}

/**
 * True for `gh api repos/<owner>/<name>/issues/<number> -X PATCH -f type=<name>` and nothing more: the type of one
 * issue set, its name one line. Any other field beside it, or in its place, is refused.
 */
export function isIssueTypeSet(args: readonly string[]): boolean {
  const call = issueCall(args);
  const pairs = rawPairs(args.slice(4));
  const pair = pairs?.length === 1 ? pairs[0] : undefined;
  return call?.method === 'PATCH' && call.part === 'issue' && pair?.[0] === 'type' && FIELD_TEXT.test(pair[1]);
}

/** A command line the runner will not start: none of a shipped query's page, a watch probe, one issue's creation, comment, body, labels, close, link, type or field, a failed job's log, or a mention scan's read. */
export class GhRefusedError extends Error {
  override readonly name = 'GhRefusedError';

  constructor(args: readonly string[]) {
    super(`teamrig only runs gh for its shipped issue queries, its two watch probes, to open, read, comment on, edit the body of, label, assign, close, link, type or set a field of an issue, to read a failed job's log, and to read the posts that may mention a user: it refuses gh ${args.slice(0, 2).join(' ')} with these arguments`);
  }
}

/** True for each fixed command line the runner starts, an area label's create among them; it also makes a label a read label file named (isFileLabelCreate). */
export function isAllowedGh(args: readonly string[]): boolean {
  return (
    isIssueQuery(args) ||
    isIssueCreate(args) ||
    isIssueComment(args) ||
    isCommentsRead(args) ||
    isIssueClose(args) ||
    isIssueBodyEdit(args) ||
    isLabelAdd(args) ||
    isLabelRemove(args) ||
    isLabelRead(args) ||
    isLabelFileRead(args) ||
    isIssueRead(args) ||
    isIssueAssign(args) ||
    isIssueUnassign(args) ||
    isAssigneeRead(args) ||
    isIssueAssigneeRead(args) ||
    isUserRead(args) ||
    isViewerRead(args) ||
    isLabelCreate(args) ||
    isAreaLabelCreate(args) ||
    isLinkAdd(args) ||
    isFieldValueSet(args) ||
    isIssueTypeSet(args) ||
    isWatchProbe(args) ||
    isJobLogRead(args) ||
    isMentionRead(args) ||
    isReviewRead(args)
  );
}

/** The lists the mention scan pages through, each changed since a time: comments on issues and pull requests, inline review comments, and the issues and pull requests themselves for their bodies. */
export const MENTION_LISTS = ['issues/comments', 'pulls/comments', 'issues'] as const;
export type MentionList = (typeof MENTION_LISTS)[number];

/** The page size of a mention list and of a pull request's reviews: GitHub's largest. */
export const MENTION_PAGE_SIZE = 100;

/** The most pages of one list the scan reads in a run; past it, the rest is cut off and said so. */
export const MENTION_PAGES_MAX = 10;

/** A time as the scan sends it: whole seconds in UTC, which GitHub reads as ISO 8601. */
export const MENTION_SINCE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

/** `gh api repos/<owner>/<name>/<list>?since=<time>&sort=updated&direction=asc[&state=all]&per_page=100&page=<n>`: one page, oldest change first. */
export function mentionListArgs(repo: string, list: MentionList, since: string, page: number): string[] {
  const state = list === 'issues' ? '&state=all' : '';
  return ['api', `repos/${repo}/${list}?since=${since}&sort=updated&direction=asc${state}&per_page=${MENTION_PAGE_SIZE}&page=${page}`];
}

const MENTION_PATH = /^repos\/([^/]+\/[^/?]+)\/(issues\/comments|pulls\/comments|issues)\?since=([^&]+)&sort=updated&direction=asc(&state=all)?&per_page=100&page=([1-9][0-9]?)$/;

/**
 * True for a page of a mention list as mentionListArgs makes it and nothing more: one GET (no method, field, header
 * or other flag, so gh cannot write or read a file), a repository name, a since time of MENTION_SINCE, `state=all`
 * on the issues list only, and a page from 1 to MENTION_PAGES_MAX.
 */
export function isMentionRead(args: readonly string[]): boolean {
  const match = args.length === 2 && args[0] === 'api' ? MENTION_PATH.exec(args[1] ?? '') : null;
  if (match === null) {
    return false;
  }
  const page = Number(match[5]);
  return REPO_NAME.test(match[1] ?? '') && MENTION_SINCE.test(match[3] ?? '') && (match[4] !== undefined) === (match[2] === 'issues') && page <= MENTION_PAGES_MAX;
}

/** `gh api repos/<owner>/<name>/pulls/<number>/reviews?per_page=100`: one pull request's reviews, for their text. */
export function reviewListArgs(repo: string, number: number): string[] {
  return ['api', `repos/${repo}/pulls/${number}/reviews?per_page=${MENTION_PAGE_SIZE}`];
}

const REVIEW_PATH = /^repos\/([^/]+\/[^/?]+)\/pulls\/([1-9][0-9]{0,9})\/reviews\?per_page=100$/;

/** True for one pull request's reviews read as reviewListArgs makes it and nothing more: one GET, no method, field, header or flag. */
export function isReviewRead(args: readonly string[]): boolean {
  const match = args.length === 2 && args[0] === 'api' ? REVIEW_PATH.exec(args[1] ?? '') : null;
  return match !== null && REPO_NAME.test(match[1] ?? '');
}

/**
 * The real runner: `spawn` with no shell, so an issue title or a repository name can never become a
 * command. gh is told never to prompt, as nobody is there to answer. `program` and `leading` let a test
 * stand a Node script in for gh. A run that prints more than `maxBytes` is stopped and rejects with
 * GhOutputCapError. It keeps what each repository's label file named when it read one, so it makes only those
 * labels beside its own.
 */
export function nodeGhRunner(program: string = GH_PROGRAM, leading: readonly string[] = [], timeoutMs = GH_TIMEOUT_MS, maxBytes = GH_OUTPUT_MAX_BYTES): GhRunner {
  const labelFiles = new LabelFileReads();
  return {
    run: async (request) => {
      if (!isAllowedGh(request.args) && !isFileLabelCreate(request.args, labelFiles.of)) {
        throw new GhRefusedError(request.args);
      }
      const result = await spawnGh(program, leading, request, timeoutMs, maxBytes);
      labelFiles.note(request.args, result);
      return result;
    },
  };
}

/** One run of gh to its end, its output capped at `maxBytes`. */
function spawnGh(program: string, leading: readonly string[], request: GhRequest, timeoutMs: number, maxBytes: number): Promise<GhResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(program, [...leading, ...request.args], {
      env: { ...request.env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let printed = 0;
    let over = false;
    const keep =
      (into: Buffer[]) =>
      (chunk: Buffer): void => {
        if (over) {
          return;
        }
        printed += chunk.length;
        if (printed > maxBytes) {
          over = true;
          stdout.length = 0;
          stderr.length = 0;
          child.kill();
          return;
        }
        into.push(chunk);
      };
    child.stdout.on('data', keep(stdout));
    child.stderr.on('data', keep(stderr));
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (over) {
        reject(new GhOutputCapError(maxBytes));
        return;
      }
      // Joined before decoding, so a character split across two chunks reads whole.
      resolve({ end: endOf(code, signal), stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') });
    });
  });
}
