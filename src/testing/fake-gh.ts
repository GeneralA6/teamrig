import { stringField, type JsonRecord } from '../core/guards.ts';
import type { GhRequest, GhResult, GhRunner } from '../github/gh.ts';
import { CLOSED_ISSUES_QUERY, ISSUE_PAGE_SIZE, OPEN_ISSUES_QUERY, RAW_FIELD } from '../github/queries.ts';

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
  /** Timeline items, as labeledEvent and renamedEvent build them, oldest first. */
  readonly timeline?: readonly JsonRecord[];
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
    author: spec.author === null ? null : { login: spec.author ?? 'maintainer' },
    labels: { nodes: (spec.labels ?? []).map((name) => ({ name })) },
    assignees: { nodes: (spec.assignees ?? []).map((login) => ({ login })) },
    timelineItems: { nodes: spec.timeline ?? [] },
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
  private failure: Error | undefined;
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

  async run(request: GhRequest): Promise<GhResult> {
    this.ran.push(request);
    if (this.failure !== undefined) {
      throw this.failure;
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
          : undefined;
    if (held === undefined) {
      return { end: { kind: 'exited', code: 1 }, stdout: '', stderr: 'gh: the fake gh answers only the shipped issue queries\n' };
    }
    const offset = Number(fieldOf(request.args, 'after') ?? '0');
    const nodes = held.slice(offset, offset + this.pageSize);
    const pageInfo = { hasNextPage: offset + nodes.length < held.length, endCursor: nodes.length === 0 ? null : String(offset + nodes.length) };
    return { end: { kind: 'exited', code: 0 }, stdout: JSON.stringify({ data: { repository: { issues: { pageInfo, nodes } } } }), stderr: '' };
  }
}
