import { recordField, stringField, type JsonRecord } from '../core/guards.ts';
import { isIssueClose, isIssueComment, isIssueCreate, isLabelAdd, isLabelRead, isLabelRemove, isLinkAdd, type GhRequest, type GhResult, type GhRunner } from '../github/gh.ts';
import { nodesOf } from '../github/issues.ts';
import { CLOSED_ISSUES_QUERY, ISSUE_LINKS_QUERY, ISSUE_PAGE_SIZE, OPEN_ISSUES_QUERY, RAW_FIELD } from '../github/queries.ts';

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
  /** GitHub's own id for it, which a link write names; 1000 plus its number unless set. */
  readonly hostId?: number;
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
  };
}

/** A timeline item: `actor`, an account of `kind`, put `label` on the issue at `at`. */
export function labeledEvent(label: string, actor: string, at: string, kind = 'User'): JsonRecord {
  return { __typename: 'LabeledEvent', createdAt: at, actor: { __typename: kind, login: actor }, label: { name: label } };
}

/** A timeline item: the issue's title was changed at `at`. */
export function renamedEvent(at: string): JsonRecord {
  return { __typename: 'RenamedTitleEvent', createdAt: at };
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
 * since `since`, `pages` at a time with the offset as the cursor; a repository it holds nothing for answers as
 * GitHub does for one the reader cannot see.
 */
export class FakeGh implements GhRunner {
  readonly ran: GhRequest[] = [];
  private readonly issues = new Map<string, readonly JsonRecord[]>();
  private readonly canned = new Map<string, GhResult>();
  private readonly createFailures = new Map<string, GhResult>();
  private failure: Error | undefined;
  private writeFailure: GhResult | undefined;
  private readonly labels = new Map<string, readonly string[]>();
  private pageSize = ISSUE_PAGE_SIZE;

  /** From now on, `repo` holds these issues (as ghIssue builds them). */
  holds(repo: string, issues: readonly JsonRecord[]): this {
    this.issues.set(repo, issues);
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

  /** From now on, a page holds at most `size` issues, so a test can read several pages of a few. */
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

  /** From now on, a comment on, the close of, a label added to or taken off, or a link added to an issue ends as given. */
  failsWrite(result: GhResult): this {
    this.writeFailure = result;
    return this;
  }

  async run(request: GhRequest): Promise<GhResult> {
    this.ran.push(request);
    if (this.failure !== undefined) {
      throw this.failure;
    }
    if (isIssueCreate(request.args)) {
      return this.create(request.args);
    }
    if (isLabelRead(request.args)) {
      return this.labelRead(request.args[1] ?? '');
    }
    if (isIssueComment(request.args) || isIssueClose(request.args) || isLabelAdd(request.args) || isLabelRemove(request.args)) {
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
    if (issues === undefined) {
      return notVisible(repo);
    }
    const query = fieldOf(request.args, 'query');
    const since = Date.parse(fieldOf(request.args, 'since') ?? '');
    const held =
      query === OPEN_ISSUES_QUERY
        ? issues.filter((issue) => issue['state'] === 'OPEN')
        : query === CLOSED_ISSUES_QUERY
          ? issues.filter((issue) => issue['state'] === 'CLOSED' && !(Date.parse(stringField(issue, 'updatedAt') ?? '') < since))
          : query === ISSUE_LINKS_QUERY
            ? issues
            : undefined;
    if (held === undefined) {
      return { end: { kind: 'exited', code: 1 }, stdout: '', stderr: 'gh: the fake gh answers only the shipped issue queries\n' };
    }
    const offset = Number(fieldOf(request.args, 'after') ?? '0');
    const nodes = held.slice(offset, offset + this.pageSize);
    const pageInfo = { hasNextPage: offset + nodes.length < held.length, endCursor: nodes.length === 0 ? null : String(offset + nodes.length) };
    return { end: { kind: 'exited', code: 0 }, stdout: JSON.stringify({ data: { repository: { issues: { pageInfo, nodes } } } }), stderr: '' };
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
