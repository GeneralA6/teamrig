import { recordField, stringField, type JsonRecord } from '../core/guards.ts';
import {
  isAssigneeRead,
  isCommentsRead,
  COMMENTS_PAGE,
  isUserRead,
  isIssueAssign,
  isIssueUnassign,
  isIssueBodyEdit,
  isIssueClose,
  isIssueComment,
  isIssueCreate,
  isIssueRead,
  isLabelAdd,
  isLabelCreate,
  isLabelRead,
  isLabelRemove,
  isLinkAdd,
  isWatchProbe,
  WATCH_PATHS,
  type GhRequest,
  type GhResult,
  type GhRunner,
  type WatchPath,
} from '../github/gh.ts';
import { nodesOf } from '../github/issues.ts';
import { CLOSED_ISSUES_QUERY, ISSUE_LINKS_QUERY, ISSUE_PAGE_SIZE, OPEN_ISSUES_QUERY, OPEN_PULLS_QUERY, PULL_PAGE_SIZE, PULL_REQUESTS_QUERY, RAW_FIELD } from '../github/queries.ts';

/** What a test sets on an issue; the rest takes a plain default. */
export interface IssueSpec {
  readonly title?: string;
  readonly body?: string;
  readonly state?: 'OPEN' | 'CLOSED';
  readonly stateReason?: string;
  readonly labels?: readonly string[];
  readonly assignees?: readonly string[];
  readonly updatedAt?: string;
  /** For a closed issue; it closed at its last change unless set. */
  readonly closedAt?: string;
  readonly lastEditedAt?: string;
  /** The author's tie to the repository; the repository's owner unless set. */
  readonly authorAssociation?: string;
  /** The author's login, `maintainer` unless set; null for an account GitHub no longer has. */
  readonly author?: string | null;
  /** The author's account kind, `User` unless set; `Bot` for an app such as GitHub Actions. */
  readonly authorKind?: string;
  /** Timeline items, as labeledEvent and renamedEvent build them, oldest first. */
  readonly timeline?: readonly JsonRecord[];
  /** When it was opened; null unless set. */
  readonly createdAt?: string;
  /** Comments, as commentNode builds them, oldest first. */
  readonly comments?: readonly JsonRecord[];
  /** GitHub's own id for it, which a link write names; 1000 plus its number unless set. */
  readonly hostId?: number;
  /** The open pull requests that close it; none unless set. */
  readonly linkedPulls?: number;
  /** Its parent issue; none unless set. */
  readonly parent?: IssueAt;
  /** The issues it is blocked by, in this repository or another. */
  readonly blockedBy?: readonly IssueAt[];
}

/** An issue of a repository (`owner/name`), as a link names it. */
export interface IssueAt {
  readonly repo: string;
  readonly number: number;
}

/** An issue as the links query names a parent or a blocker. */
function issueNode(at: IssueAt): JsonRecord {
  return { number: at.number, repository: { nameWithOwner: at.repo } };
}

/**
 * An issue as the shipped issue queries (queries.ts) get it from GitHub: an empty body as '', null for a time it does
 * not have, and changed last on 2030-01-01, before any task a test makes.
 */
export function ghIssue(repo: string, number: number, spec: IssueSpec = {}): JsonRecord {
  const state = spec.state ?? 'OPEN';
  const updatedAt = spec.updatedAt ?? '2030-01-01T00:00:00Z';
  return {
    number,
    title: spec.title ?? `Issue ${number}`,
    body: spec.body ?? '',
    state,
    stateReason: spec.stateReason ?? null,
    url: `https://github.com/${repo}/issues/${number}`,
    createdAt: spec.createdAt ?? null,
    updatedAt,
    closedAt: state === 'CLOSED' ? (spec.closedAt ?? updatedAt) : null,
    lastEditedAt: spec.lastEditedAt ?? null,
    authorAssociation: spec.authorAssociation ?? 'OWNER',
    author: spec.author === null ? null : { __typename: spec.authorKind ?? 'User', login: spec.author ?? 'maintainer' },
    labels: { nodes: (spec.labels ?? []).map((name) => ({ name })) },
    assignees: { nodes: (spec.assignees ?? []).map((login) => ({ login })) },
    timelineItems: { nodes: spec.timeline ?? [] },
    fullDatabaseId: String(spec.hostId ?? 1000 + number),
    parent: spec.parent === undefined ? null : issueNode(spec.parent),
    blockedBy: { nodes: (spec.blockedBy ?? []).map(issueNode) },
    comments: { nodes: spec.comments ?? [] },
    closedByPullRequestsReferences: { totalCount: spec.linkedPulls ?? 0 },
  };
}

/** A timeline item: `actor`, an account of `kind`, put `label` on the issue at `at`. */
export function labeledEvent(label: string, actor: string, at: string, kind = 'User'): JsonRecord {
  return { __typename: 'LabeledEvent', createdAt: at, actor: { __typename: kind, login: actor }, label: { name: label } };
}

/**
 * A comment as the issue queries read it: posted at `at` by an author of `association` and account `kind`, with the
 * login and text given (none and empty unless set).
 */
export function commentNode(at: string, association: string, kind = 'User', text: { readonly login?: string; readonly body?: string } = {}): JsonRecord {
  return { createdAt: at, authorAssociation: association, author: { __typename: kind, ...(text.login === undefined ? {} : { login: text.login }) }, body: text.body ?? '' };
}

/** A timeline item: the issue's title was changed at `at`. */
export function renamedEvent(at: string): JsonRecord {
  return { __typename: 'RenamedTitleEvent', createdAt: at };
}

/** What a test sets on a pull request; the rest takes a plain default. */
export interface PullSpec {
  readonly title?: string;
  readonly state?: 'OPEN' | 'MERGED' | 'CLOSED';
  readonly isDraft?: boolean;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  /** For a merged or closed one; it ended at its last change unless set. */
  readonly endedAt?: string;
  /** The author's tie to the repository; the repository's owner unless set. */
  readonly authorAssociation?: string;
  /** The author's login, `maintainer` unless set. */
  readonly author?: string;
  /** The head branch, `t1-change` unless set. */
  readonly head?: string;
  readonly fork?: boolean;
  readonly mergeable?: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
  readonly reviewDecision?: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null;
  /** The last commit's check rollup; null for a commit with no checks. */
  readonly checks?: 'SUCCESS' | 'FAILURE' | 'ERROR' | 'PENDING' | 'EXPECTED' | null;
}

/** A pull request as the shipped pull request query (queries.ts) gets it from GitHub, opened and changed on 2030-01-01. */
export function ghPull(repo: string, number: number, spec: PullSpec = {}): JsonRecord {
  const state = spec.state ?? 'OPEN';
  const updatedAt = spec.updatedAt ?? '2030-01-01T00:00:00Z';
  const endedAt = state === 'OPEN' ? null : (spec.endedAt ?? updatedAt);
  return {
    number,
    title: spec.title ?? `Change ${number}`,
    url: `https://github.com/${repo}/pull/${number}`,
    state,
    isDraft: spec.isDraft ?? false,
    createdAt: spec.createdAt ?? '2030-01-01T00:00:00Z',
    updatedAt,
    closedAt: endedAt,
    mergedAt: state === 'MERGED' ? endedAt : null,
    authorAssociation: spec.authorAssociation ?? 'OWNER',
    author: { __typename: 'User', login: spec.author ?? 'maintainer' },
    headRefName: spec.head ?? 't1-change',
    isCrossRepository: spec.fork ?? false,
    mergeable: spec.mergeable ?? 'MERGEABLE',
    reviewDecision: spec.reviewDecision ?? null,
    commits: { nodes: [{ commit: { statusCheckRollup: spec.checks === null || spec.checks === undefined ? null : { state: spec.checks } } }] },
  };
}

/** The value of the raw field `key` in a gh command line, or undefined. */
function fieldOf(args: readonly string[], key: string): string | undefined {
  for (let at = 0; at + 1 < args.length; at += 1) {
    const field = args[at + 1];
    if (args[at] === RAW_FIELD && field !== undefined && field.startsWith(`${key}=`)) {
      return field.slice(key.length + 1);
    }
  }
  return undefined;
}

/** The `owner/name` a page of an issue query reads, or empty when the command line names none. */
export function ghRepoOf(args: readonly string[]): string {
  const owner = fieldOf(args, 'owner');
  const name = fieldOf(args, 'name');
  return owner === undefined || name === undefined ? '' : `${owner}/${name}`;
}

/** What GitHub answers for a repository the reader cannot see, as gh prints it. */
function notVisible(repo: string): GhResult {
  const message = `Could not resolve to a Repository with the name '${repo}'.`;
  return {
    end: { kind: 'exited', code: 1 },
    stdout: JSON.stringify({ data: { repository: null }, errors: [{ type: 'NOT_FOUND', path: ['repository'], message }] }),
    stderr: `gh: ${message}\n`,
  };
}

/**
 * A gh that reaches no network: each request is recorded, so a test can hold every one to a read. A page of the
 * open or closed issue query gets the issues `holds` set for the repository in that state, closed ones changed
 * since `since`, and a page of a pull request query the pull requests `holdsPulls` set (the open ones for the open read), newest change first; each
 * `pages` at a time with the offset as the cursor. A repository it holds nothing for answers as GitHub does for one
 * the reader cannot see.
 */
export class FakeGh implements GhRunner {
  readonly ran: GhRequest[] = [];
  private readonly issues = new Map<string, readonly JsonRecord[]>();
  private readonly pulls = new Map<string, readonly JsonRecord[]>();
  private readonly canned = new Map<string, GhResult>();
  private readonly createFailures = new Map<string, GhResult>();
  private failure: Error | undefined;
  private writeFailure: GhResult | undefined;
  private readonly labels = new Map<string, readonly string[]>();
  private readonly unassignable = new Map<string, readonly string[]>();
  private readonly spellings = new Map<string, string>();
  private userAnswer: GhResult | undefined;
  private commentsAnswer: GhResult | undefined;
  /** Set by `pages`; else each query's own page size. */
  private pageSize: number | undefined;
  /** How often each `<repo> <probe path>` changed: its entity tag is `W/"v<count>"`. */
  private readonly versions = new Map<string, number>();
  private readonly probeFailures = new Map<string, GhResult>();

  /** From now on, `repo` holds these issues (as ghIssue builds them). */
  holds(repo: string, issues: readonly JsonRecord[]): this {
    this.issues.set(repo, issues);
    return this;
  }

  /** From now on, `repo` holds these pull requests (as ghPull builds them); a page gives them newest change first. */
  holdsPulls(repo: string, pulls: readonly JsonRecord[]): this {
    this.pulls.set(repo, [...pulls].sort((a, b) => Date.parse(stringField(b, 'updatedAt') ?? '') - Date.parse(stringField(a, 'updatedAt') ?? '')));
    return this;
  }

  /** From now on, every run for `repo` ends as given, whatever it holds. */
  answers(repo: string, result: GhResult): this {
    this.canned.set(repo, result);
    return this;
  }

  /** From now on, every run fails to start with `error`, as a gh that is not installed does. */
  failsWith(error: Error): this {
    this.failure = error;
    return this;
  }

  /** From now on, a page holds at most `size` issues or pull requests, so a test can read several pages of a few. */
  pages(size: number): this {
    this.pageSize = size;
    return this;
  }

  /** From now on, opening an issue in `repo` ends as given and opens nothing. */
  failsCreate(repo: string, result: GhResult): this {
    this.createFailures.set(repo, result);
    return this;
  }

  /** From now on, `repo` has these labels, and a read of any other label of it is Not Found. */
  hasLabels(repo: string, labels: readonly string[]): this {
    this.labels.set(repo, labels);
    return this;
  }

  /** From now on, these logins may not be assigned in `repo` (a read of them is Not Found); every other login may. */
  cannotAssign(repo: string, logins: readonly string[]): this {
    this.unassignable.set(repo, logins);
    return this;
  }

  /**
   * From now on, GitHub spells each of these logins as given: a user read in any case prints it so, and an assignee
   * read matches it only in that case, as GitHub's does. A login not given is spelled as a read names it.
   */
  spells(...logins: string[]): this {
    logins.forEach((login) => this.spellings.set(login.toLowerCase(), login));
    return this;
  }

  /** From now on, every read of an issue's new comments ends as given. */
  answersCommentsRead(result: GhResult): this {
    this.commentsAnswer = result;
    return this;
  }

  /** From now on, every user read ends as given. */
  answersUserRead(result: GhResult): this {
    this.userAnswer = result;
    return this;
  }

  /** From now on, a comment on, a body edit or the close of, a label added to or taken off, an assignee or a link added to an issue, and a label made, end as given. */
  failsWrite(result: GhResult): this {
    this.writeFailure = result;
    return this;
  }

  /** From now on, the watch probes of `repo` (all, or the one `path`) see a change they were not told of yet. */
  changes(repo: string, path?: WatchPath): this {
    for (const probe of path === undefined ? WATCH_PATHS : [path]) {
      const key = `${repo} ${probe}`;
      this.versions.set(key, (this.versions.get(key) ?? 1) + 1);
    }
    return this;
  }

  /** From now on, every watch probe of `repo` ends as given. */
  failsProbe(repo: string, result: GhResult): this {
    this.probeFailures.set(repo, result);
    return this;
  }

  /** The watch probes run so far, each as the repository and path it read. */
  probes(): string[] {
    return this.ran.filter((request) => isWatchProbe(request.args)).map((request) => (request.args[request.args.length - 1] ?? '').slice('repos/'.length));
  }

  async run(request: GhRequest): Promise<GhResult> {
    this.ran.push(request);
    if (this.failure !== undefined) {
      throw this.failure;
    }
    if (isWatchProbe(request.args)) {
      return this.probe(request.args);
    }
    if (isIssueCreate(request.args)) {
      return this.create(request.args);
    }
    if (isLabelRead(request.args)) {
      return this.labelRead(request.args[1] ?? '');
    }
    if (isLabelCreate(request.args)) {
      return this.writeFailure ?? this.labelCreate(request.args);
    }
    if (isAssigneeRead(request.args)) {
      return this.assigneeRead(request.args[1] ?? '');
    }
    if (isUserRead(request.args)) {
      return this.userRead(request.args[1] ?? '');
    }
    if (isCommentsRead(request.args)) {
      return this.commentsAnswer ?? this.commentsRead(request.args);
    }
    if (isIssueRead(request.args)) {
      return this.issueRead(request.args[1] ?? '');
    }
    if (isIssueComment(request.args) || isIssueBodyEdit(request.args) || isIssueClose(request.args) || isLabelAdd(request.args) || isLabelRemove(request.args) || isIssueAssign(request.args) || isIssueUnassign(request.args)) {
      return this.writeFailure ?? { end: { kind: 'exited', code: 0 }, stdout: '{}', stderr: '' };
    }
    if (isLinkAdd(request.args)) {
      return this.writeFailure ?? this.link(request.args);
    }
    const repo = ghRepoOf(request.args);
    const canned = this.canned.get(repo);
    if (canned !== undefined) {
      return canned;
    }
    const issues = this.issues.get(repo);
    const pulls = this.pulls.get(repo);
    if (issues === undefined && pulls === undefined) {
      return notVisible(repo);
    }
    const query = fieldOf(request.args, 'query');
    const since = Date.parse(fieldOf(request.args, 'since') ?? '');
    const held =
      query === OPEN_ISSUES_QUERY
        ? (issues ?? []).filter((issue) => issue['state'] === 'OPEN')
        : query === CLOSED_ISSUES_QUERY
          ? (issues ?? []).filter((issue) => issue['state'] === 'CLOSED' && !(Date.parse(stringField(issue, 'updatedAt') ?? '') < since))
          : query === ISSUE_LINKS_QUERY
            ? (issues ?? [])
            : query === PULL_REQUESTS_QUERY
              ? (pulls ?? [])
              : query === OPEN_PULLS_QUERY
                ? (pulls ?? []).filter((pull) => pull['state'] === 'OPEN')
                : undefined;
    if (held === undefined) {
      return { end: { kind: 'exited', code: 1 }, stdout: '', stderr: 'gh: the fake gh answers only the shipped queries\n' };
    }
    const offset = Number(fieldOf(request.args, 'after') ?? '0');
    const pulled = query === PULL_REQUESTS_QUERY || query === OPEN_PULLS_QUERY;
    const nodes = held.slice(offset, offset + (this.pageSize ?? (pulled ? PULL_PAGE_SIZE : ISSUE_PAGE_SIZE)));
    const pageInfo = { hasNextPage: offset + nodes.length < held.length, endCursor: nodes.length === 0 ? null : String(offset + nodes.length) };
    const connection = pulled ? 'pullRequests' : 'issues';
    return { end: { kind: 'exited', code: 0 }, stdout: JSON.stringify({ data: { repository: { [connection]: { pageInfo, nodes } } } }), stderr: '' };
  }

  /**
   * A probe as `gh api -i` prints GitHub's answer: 304, gh exiting 1, when the tag sent is the current one, else 200
   * with the current tag; a repository it holds nothing for answers 404.
   */
  private probe(args: readonly string[]): GhResult {
    const target = (args[args.length - 1] ?? '').slice('repos/'.length);
    const path = WATCH_PATHS.find((probe) => target.endsWith(`/${probe}`)) ?? '';
    const repo = target.slice(0, target.length - path.length - 1);
    const failure = this.probeFailures.get(repo);
    if (failure !== undefined) {
      return failure;
    }
    if (!this.issues.has(repo)) {
      return { end: { kind: 'exited', code: 1 }, stdout: 'HTTP/2.0 404 Not Found\r\n\r\n{"message":"Not Found"}', stderr: 'gh: Not Found (HTTP 404)\n' };
    }
    const tag = `W/"v${this.versions.get(`${repo} ${path}`) ?? 1}"`;
    if (args[3] === `If-None-Match: ${tag}`) {
      return { end: { kind: 'exited', code: 1 }, stdout: `HTTP/2.0 304 Not Modified\r\nEtag: ${tag.slice(2)}\r\n\r\n`, stderr: 'gh: HTTP 304\n' };
    }
    return { end: { kind: 'exited', code: 0 }, stdout: `HTTP/2.0 200 OK\r\nEtag: ${tag}\r\n\r\n[]`, stderr: '' };
  }

  /** A label read as GitHub answers it: what a test set for the repository, else the label when the repository has it, else Not Found. */
  private labelRead(path: string): GhResult {
    const [, owner = '', name = '', , label = ''] = path.split('/');
    const canned = this.canned.get(`${owner}/${name}`);
    if (canned !== undefined) {
      return canned;
    }
    if ((this.labels.get(`${owner}/${name}`) ?? []).includes(decodeURIComponent(label))) {
      return { end: { kind: 'exited', code: 0 }, stdout: JSON.stringify({ name: decodeURIComponent(label) }), stderr: '' };
    }
    return { end: { kind: 'exited', code: 1 }, stdout: '', stderr: 'gh: Not Found (HTTP 404)\n' };
  }

  /** A label made as GitHub makes it: the repository has it from now on, and the answer is the new label. */
  private labelCreate(args: readonly string[]): GhResult {
    const repo = (args[1] ?? '').slice('repos/'.length, -'/labels'.length);
    const name = (args[5] ?? '').slice('name='.length);
    this.labels.set(repo, [...(this.labels.get(repo) ?? []), name]);
    return { end: { kind: 'exited', code: 0 }, stdout: JSON.stringify({ name }), stderr: '' };
  }

  /** A user read as GitHub answers it: the user with its login as GitHub spells it, whatever case the path names. */
  private userRead(path: string): GhResult {
    if (this.userAnswer !== undefined) {
      return this.userAnswer;
    }
    const login = path.slice('users/'.length);
    return { end: { kind: 'exited', code: 0 }, stdout: JSON.stringify({ login: this.spellings.get(login.toLowerCase()) ?? login, type: 'User' }), stderr: '' };
  }

  /**
   * An assignee read as GitHub answers it: what a test set for the repository, else 204 unless the login may not be
   * assigned there or is not in the case GitHub spells it.
   */
  private assigneeRead(path: string): GhResult {
    const [, owner = '', name = '', , login = ''] = path.split('/');
    const canned = this.canned.get(`${owner}/${name}`);
    if (canned !== undefined) {
      return canned;
    }
    const spelled = this.spellings.get(login.toLowerCase()) ?? login;
    return spelled !== login || (this.unassignable.get(`${owner}/${name}`) ?? []).includes(login)
      ? { end: { kind: 'exited', code: 1 }, stdout: '', stderr: 'gh: Not Found (HTTP 404)\n' }
      : { end: { kind: 'exited', code: 0 }, stdout: '', stderr: '' };
  }

  /**
   * An issue read as GitHub's REST API answers it: what a test set for the repository, else the issue's number and
   * its id, 1000 + the number, when the repository holds it, else Not Found.
   */
  /**
   * A read of one issue's new comments as GitHub's REST API answers it: the comments the issue holds posted at or
   * after the read's time, oldest first and at most one page, in REST's shape; Not Found for an issue it does not hold.
   */
  private commentsRead(args: readonly string[]): GhResult {
    const [, owner = '', name = '', , number = ''] = (args[1] ?? '').split('/');
    const canned = this.canned.get(`${owner}/${name}`);
    if (canned !== undefined) {
      return canned;
    }
    const issue = (this.issues.get(`${owner}/${name}`) ?? []).find((held) => String(held['number']) === number);
    if (issue === undefined) {
      return { end: { kind: 'exited', code: 1 }, stdout: '', stderr: 'gh: Not Found (HTTP 404)\n' };
    }
    const since = Date.parse(fieldOf(args, 'since') ?? '');
    const comments = nodesOf(issue['comments'])
      .filter((comment) => Date.parse(stringField(comment, 'createdAt') ?? '') >= since)
      .sort((a, b) => Date.parse(stringField(a, 'createdAt') ?? '') - Date.parse(stringField(b, 'createdAt') ?? ''))
      .slice(0, COMMENTS_PAGE)
      .map(restComment);
    return { end: { kind: 'exited', code: 0 }, stdout: JSON.stringify(comments), stderr: '' };
  }

  private issueRead(path: string): GhResult {
    const [, owner = '', name = '', , number = ''] = path.split('/');
    const canned = this.canned.get(`${owner}/${name}`);
    if (canned !== undefined) {
      return canned;
    }
    const held = (this.issues.get(`${owner}/${name}`) ?? []).some((issue) => String(issue['number']) === number);
    return held
      ? { end: { kind: 'exited', code: 0 }, stdout: JSON.stringify({ id: 1000 + Number(number), number: Number(number) }), stderr: '' }
      : { end: { kind: 'exited', code: 1 }, stdout: '', stderr: 'gh: Not Found (HTTP 404)\n' };
  }

  /**
   * An issue create as GitHub's REST API answers it: the new issue, numbered after the last one the repository
   * holds, is added to it open, so a later sync reads it back.
   */
  private create(args: readonly string[]): GhResult {
    const repo = (args[1] ?? '').slice('repos/'.length, -'/issues'.length);
    const failure = this.createFailures.get(repo);
    if (failure !== undefined) {
      return failure;
    }
    const held = this.issues.get(repo) ?? [];
    const number = Math.max(0, ...held.map((issue) => (typeof issue['number'] === 'number' ? issue['number'] : 0))) + 1;
    const labels = args.flatMap((arg, at) => (args[at - 1] === RAW_FIELD && arg.startsWith(LABEL_PREFIX) ? [arg.slice(LABEL_PREFIX.length)] : []));
    this.issues.set(repo, [...held, ghIssue(repo, number, { title: fieldOf(args, 'title') ?? '', body: fieldOf(args, 'body') ?? '', labels })]);
    return { end: { kind: 'exited', code: 0 }, stdout: JSON.stringify({ number, html_url: `https://github.com/${repo}/issues/${number}` }), stderr: '' };
  }

  /**
   * A link write as GitHub's REST API answers it: the issue the id names, in any repository held, goes under the
   * issue of the path as its sub-issue, or onto its blockers, so a later links read sees it; LINK_REFUSED for an id
   * it does not hold, a sub-issue that has a parent already, or a link it has already.
   */
  private link(args: readonly string[]): GhResult {
    const match = LINK_WRITE.exec(args[1] ?? '');
    const id = (args[5] ?? '').split('=')[1] ?? '';
    const at = { repo: match?.[1] ?? '', number: Number(match?.[2]) };
    const named = [...this.issues].flatMap(([holder, issues]) => issues.filter((issue) => issue['fullDatabaseId'] === id).map((issue) => ({ holder, issue })));
    const other = named[0];
    if (other === undefined || !this.holdsIssue(at)) {
      return LINK_REFUSED;
    }
    const otherAt = { repo: other.holder, number: Number(other.issue['number']) };
    if (match?.[3] === 'sub_issues') {
      return other.issue['parent'] !== null ? LINK_REFUSED : this.change(otherAt, (issue) => ({ ...issue, parent: issueNode(at) }));
    }
    return this.change(at, (issue) => {
      const blockers = nodesOf(issue['blockedBy']);
      return blockers.some((node) => issueNodeIs(node, otherAt)) ? undefined : { ...issue, blockedBy: { nodes: [...blockers, issueNode(otherAt)] } };
    });
  }

  private holdsIssue(at: IssueAt): boolean {
    return (this.issues.get(at.repo) ?? []).some((issue) => issue['number'] === at.number);
  }

  /** Replaces the held issue `at` by what `edit` makes of it; LINK_REFUSED when `edit` gives nothing, a link already there. */
  private change(at: IssueAt, edit: (issue: JsonRecord) => JsonRecord | undefined): GhResult {
    const held = this.issues.get(at.repo) ?? [];
    const issue = held.find((item) => item['number'] === at.number);
    const changed = issue === undefined ? undefined : edit(issue);
    if (changed === undefined) {
      return LINK_REFUSED;
    }
    this.issues.set(at.repo, held.map((item) => (item === issue ? changed : item)));
    return { end: { kind: 'exited', code: 0 }, stdout: '{}', stderr: '' };
  }
}

/** GitHub's answer to a link write it refuses: an id it does not hold, a second parent, a link it has already. */
const LINK_REFUSED: GhResult = { end: { kind: 'exited', code: 1 }, stdout: '', stderr: 'gh: Validation Failed (HTTP 422)\n' };

function issueNodeIs(node: JsonRecord, at: IssueAt): boolean {
  const repository = recordField(node, 'repository');
  return node['number'] === at.number && repository !== undefined && repository['nameWithOwner'] === at.repo;
}

/** The issue path of a link write, the endpoint, and its typed id field. */
const LINK_WRITE = /^repos\/([^/]+\/[^/]+)\/issues\/(\d+)\/(sub_issues|dependencies\/blocked_by)$/;

/** How a label field of an issue create starts. */
const LABEL_PREFIX = 'labels[]=';

/** A comment node of the issue queries' shape, as GitHub's REST API spells it. */
function restComment(comment: JsonRecord): JsonRecord {
  const author = recordField(comment, 'author');
  return {
    created_at: comment['createdAt'] ?? null,
    author_association: comment['authorAssociation'] ?? null,
    user: author === undefined ? null : { login: author['login'] ?? null, type: author['__typename'] ?? null },
    body: comment['body'] ?? '',
  };
}
