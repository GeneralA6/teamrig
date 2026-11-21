/**
 * The issue host port: where a team's issues and pull requests live, behind names that hold for any host. teamrig
 * writes to a host only through this port, split by kind (Tracker, CodeHost) into small capabilities, and each host
 * (GitHub is the only one so far, src/adapters/connectors/github/host.ts, and it is both kinds) is an adapter that keeps its own access
 * rules. A repository reaches a host only when the team config lists it there.
 */

import type { IssueFields } from './fields.ts';
import type { HostIssue, IssueThread, LinkedIssue, ReadComment } from './issue.ts';
import type { HostPosts } from './post.ts';
import type { HostPull } from './pull.ts';

/** One issue or pull request: its repository (`owner/name`, in lowercase) and its number. */
export interface IssueTarget {
  readonly repo: string;
  readonly number: number;
}

/** `owner/name#number`, as a command takes and prints it: a name is never `.` or `..` alone. */
const TARGET_TEXT = /^([A-Za-z0-9-]+\/(?!\.\.?#)[A-Za-z0-9_.-]+)#([1-9][0-9]{0,9})$/u;

/** The issue or pull request `text` names as `owner/name#number`, or undefined when it names none. */
export function parseIssueTarget(text: string): IssueTarget | undefined {
  const match = TARGET_TEXT.exec(text.trim());
  const repo = match?.[1];
  const number = match?.[2];
  return repo === undefined || number === undefined ? undefined : { repo: repo.toLowerCase(), number: Number(number) };
}

/** `owner/name#number`. */
export function targetText(target: IssueTarget): string {
  return `${target.repo}#${target.number}`;
}

/**
 * An issue's page on GitHub, built from its repository and number. Every address teamrig keeps or serves for an
 * issue is this one, never the string GitHub's API sent: that string is outside text, and a kept field is served
 * as the team's own. The sync writes it as a closed issue's evidence, and the GitHub adapter serves it as a ref's
 * page, so it sits beside the issue ref both read.
 */
export function issuePage(repo: string, number: number): string {
  return `https://github.com/${repo}/issues/${number}`;
}

/** Why an issue was closed, as the host shows it: done, not to be done, or a duplicate of another. */
export const CLOSE_REASONS = ['completed', 'not-planned', 'duplicate'] as const;
export type CloseReason = (typeof CLOSE_REASONS)[number];

/** What a run does on a host, for the line saying how it reaches it: lists issues, opens them, or writes on one. */
export type HostUse = 'read' | 'open' | 'write';

/**
 * How a host is reached for a repository, or why it cannot be, which stops the run for it. `scope` names the
 * repositories one access reaches alike (on GitHub, one owner's), so a run says each access once.
 */
export type HostReach =
  | { readonly kind: 'reached'; readonly access: string; readonly scope: string }
  | { readonly kind: 'unreachable'; readonly reason: string };

/** How one write to a host ended: done, or one plain line saying why not. */
export type HostEnd = { readonly kind: 'done' } | { readonly kind: 'failed'; readonly reason: string };

/** The host's own id of one issue, which a link to it names; missing when the host has no such issue. */
export type HostIssueId = { readonly kind: 'found'; readonly id: number } | { readonly kind: 'missing' } | { readonly kind: 'failed'; readonly reason: string };

/** One read of an issue or pull request: read, missing (none the access can see), or the read failed. */
export type HostThread = { readonly kind: 'read'; readonly thread: IssueThread } | { readonly kind: 'missing' } | { readonly kind: 'failed'; readonly reason: string };

/** A label to make on a host: its name, its colour as six hex digits with no `#`, and the line describing it. */
export interface LabelSpec {
  readonly name: string;
  readonly color: string;
  readonly description: string;
}

/** Whether a repository has a label: it has, it has not, or the read failed, with one plain line saying why. */
export type HostLabel = { readonly kind: 'found' } | { readonly kind: 'missing' } | { readonly kind: 'failed'; readonly reason: string };

/**
 * A repository's own label file (issues/label-file.ts) as the host read it: the labels it names; missing when the
 * repository has no such file; or failed, with one plain line saying why (a read refused, a file that is malformed).
 */
export type HostLabelFile = { readonly kind: 'read'; readonly labels: readonly LabelSpec[] } | { readonly kind: 'missing' } | { readonly kind: 'failed'; readonly reason: string };

/**
 * Whether a login may be assigned in a repository: found, with the login as the host spells it (GitHub keeps a login's
 * case, and its assignee check matches that case only), missing (no such user, or it may not be assigned), or the read failed.
 */
export type HostAssignee = { readonly kind: 'found'; readonly login: string } | { readonly kind: 'missing' } | { readonly kind: 'failed'; readonly reason: string };

/** The login the host's access for a repository belongs to, as the host spells it, or why it could not be read. */
export type HostViewer = { readonly kind: 'found'; readonly login: string } | { readonly kind: 'failed'; readonly reason: string };

/** The labels one issue or pull request carries as one read found them; missing when the host shows no such item; or the read failed. */
export type HostIssueLabels = { readonly kind: 'read'; readonly labels: readonly string[] } | { readonly kind: 'missing' } | { readonly kind: 'failed'; readonly reason: string };

/** The comments one read of an issue's new comments gave, oldest first, each with its text matched and dropped; or the read failed. */
export type HostComments = { readonly kind: 'read'; readonly comments: readonly ReadComment[] } | { readonly kind: 'failed'; readonly reason: string };

/**
 * A repository's issues as one list read them, the open ones and those closed since the day it was given, with what
 * a reader should know about the read; or why it could not be read, in which case nothing of it was.
 */
export type HostList =
  | { readonly kind: 'listed'; readonly issues: readonly HostIssue[]; readonly notes: readonly string[] }
  | { readonly kind: 'failed'; readonly reason: string };

/**
 * Every issue of a repository, in any state, with its links, and what a reader should know about the read (it stopped
 * at its limit, or left out items it could not read). Or why it could not be read, in which case nothing of it was.
 */
export type HostLinks =
  | { readonly kind: 'listed'; readonly issues: readonly LinkedIssue[]; readonly notes: readonly string[] }
  | { readonly kind: 'failed'; readonly reason: string };

/**
 * A repository's pull requests as one read found them: every open one, and those in any state changed at or after the
 * time the read was given, each newest change first, with what a reader should know about the read; or why it could
 * not be read, in which case nothing of it was.
 */
export type HostPulls =
  | { readonly kind: 'listed'; readonly open: readonly HostPull[]; readonly changed: readonly HostPull[]; readonly notes: readonly string[] }
  | { readonly kind: 'failed'; readonly reason: string };

/**
 * The end of one failed CI job's log as a read found it: the step that failed last and its last lines, each one plain
 * line with any secret shape redacted, outside input to show as data; or why it could not be read.
 */
export type HostJobLog =
  | { readonly kind: 'read'; readonly step: string | undefined; readonly lines: readonly string[] }
  | { readonly kind: 'failed'; readonly reason: string };

/** One issue to open: its repository (`owner/name`), title, body and labels. */
export interface IssueDraft {
  readonly repo: string;
  readonly title: string;
  readonly body: string;
  readonly labels: readonly string[];
}

/** How opening an issue ended: the issue opened, or one plain line saying why there is none. */
export type HostOpen = { readonly kind: 'opened'; readonly target: IssueTarget } | { readonly kind: 'failed'; readonly reason: string };

/**
 * The capabilities of a host, each a small interface so a caller asks only for what it calls and a host of one kind
 * gives only its own: a tracker holds issues, a code host holds pull requests, their checks and a repository's files.
 * Every method ends in a result and never throws.
 */

/** What every host has, of either kind: its name and how it is reached. */
export interface HostAccess {
  /** The host's name, for a message. */
  readonly name: string;
  /** How the host is reached for `repo` to `use` it. Asked before any read or write, so a key that cannot be read does nothing. */
  reach(repo: string, use: HostUse): Promise<HostReach>;
}

/** A tracker's issues: listed, opened, their body replaced, closed, named by the host's own id, and one read as it is now. */
export interface IssueStore {
  /** The open issues of `repo` and those closed on or after `closedSince` (`YYYY-MM-DD`, UTC), the newest state of each. */
  list(repo: string, closedSince: string): Promise<HostList>;
  /** Opens one issue. */
  open(draft: IssueDraft): Promise<HostOpen>;
  /** Replaces the body (the description) of the issue or pull request with `body`; its title, state and the rest stay. */
  editBody(target: IssueTarget, body: string): Promise<HostEnd>;
  /**
   * Closes the issue or pull request, giving `reason` when there is one; a duplicate also names the issue it
   * duplicates by its host id (issueId), which the host links. `duplicateId` is used only with the duplicate reason.
   */
  close(target: IssueTarget, reason?: CloseReason, duplicateId?: number): Promise<HostEnd>;
  /** The host's id of one issue, read so a link can name it. */
  issueId(target: IssueTarget): Promise<HostIssueId>;
  /** One issue or pull request as it is now: its state, labels, assignees, kind and body. */
  thread(target: IssueTarget): Promise<HostThread>;
}

/** A tracker's comments: one posted, and an issue's new ones read. */
export interface Comments {
  /** Posts `body` as one comment. */
  comment(target: IssueTarget, body: string): Promise<HostEnd>;
  /**
   * The comments of the issue posted or edited at or after `since` (ms since the epoch), oldest first and at most one
   * bounded page: the claim pass's only read of comment text, which it matches for a claim line and drops.
   */
  newComments(target: IssueTarget, since: number): Promise<HostComments>;
}

/** A tracker's Labels.labelName, handed to code that plans or looks a label up with no tracker of its own. */
export type LabelNaming = (label: string) => string;

/** A tracker's labels: named as it holds them, a repository's read and made, an item's read, added and taken off. */
export interface Labels {
  /**
   * The name this tracker holds `label` under: the label itself where a label takes any name, else the nearest name
   * the tracker takes (a tracker whose labels hold no space gives one without). Every read gives a label back under
   * that name, so a label teamrig knows by its own name (a status label, one a person typed) is named through this
   * before it is looked for, made, added or taken off. Naming a name gives it back.
   */
  labelName(label: string): string;
  /** Whether `repo` has the label `label`, so a label is only added once the repository has it. */
  labelExists(repo: string, label: string): Promise<HostLabel>;
  /**
   * Makes `label` in the repository; only for a label teamrig makes (MANAGED_LABEL_SPECS), by the push or issue label,
   * or one the repository's label file names, as LabelFiles.labelFile read it this run.
   */
  createLabel(repo: string, label: LabelSpec): Promise<HostEnd>;
  /** Adds `labels` to the issue or pull request. */
  addLabels(target: IssueTarget, labels: readonly string[]): Promise<HostEnd>;
  /** Takes `label` off the issue or pull request; the repository keeps the label. */
  removeLabel(target: IssueTarget, label: string): Promise<HostEnd>;
  /** The labels the issue or pull request carries now, read so a write its labels rule out is refused (issue assign on a design issue). */
  issueLabels(target: IssueTarget): Promise<HostIssueLabels>;
}

/** A tracker's assignees: who may be one, read, and an item's added and taken off. */
export interface Assignees {
  /** Whether `login` may be assigned in `repo`, so an assign is only sent for one the host would not drop. */
  assigneeExists(repo: string, login: string): Promise<HostAssignee>;
  /** The login the access used for `repo` belongs to: the one the sync runs as, which the status push assigns when a session maps to none. */
  viewer(repo: string): Promise<HostViewer>;
  /**
   * Whether `login` may be assigned to the issue or pull request: one with access to the repository, or one who took
   * part in that item, such as a commenter asking to take it (issue assign).
   */
  assignableOn(target: IssueTarget, login: string): Promise<HostAssignee>;
  /** Adds `logins` to the assignees of the issue or pull request; those already on it stay. */
  assign(target: IssueTarget, logins: readonly string[]): Promise<HostEnd>;
  /** Takes `login` off the assignees of the issue or pull request; any others stay. Only for a claim the sync made. */
  unassign(target: IssueTarget, login: string): Promise<HostEnd>;
}

/** A tracker's links between issues: read, and a parent or a blocker added. */
export interface IssueLinks {
  /** Every issue of `repo` with its host id, its parent and its blockers. */
  links(repo: string): Promise<HostLinks>;
  /** Puts the issue whose host id is `childId` under `parent` as its sub-issue. */
  addSubIssue(parent: IssueTarget, childId: number): Promise<HostEnd>;
  /** Marks `target` blocked by the issue whose host id is `blockerId`. */
  addBlockedBy(target: IssueTarget, blockerId: number): Promise<HostEnd>;
}

/** A tracker's cheap look for a change, so a list is read only when something moved. */
export interface IssueEvents {
  /**
   * Whether `repo` changed since the host gave `marks`, cheaply enough to ask every minute: no list is read. Empty
   * marks always read as changed.
   */
  watch(repo: string, marks: WatchMarks): Promise<HostWatch>;
}

/** A tracker's issue fields and types, when it has any. */
export interface StatusFields {
  /**
   * The issue fields and types of a repository, read and set: a capability, so a host with none leaves it out and
   * the field push skips it, saying so.
   */
  readonly fields?: IssueFields;
}

/** A tracker: where a team's issues live, with every capability over them. */
export interface Tracker extends HostAccess, IssueStore, Comments, Labels, Assignees, IssueLinks, IssueEvents, StatusFields {}

/** A code host's pull requests, read. */
export interface PullRequests {
  /**
   * The open pull requests of `repo`, and those changed at or after `since` (an ISO time); with no `since`, the most
   * recently changed ones, a page of them.
   */
  pulls(repo: string, since: string | undefined): Promise<HostPulls>;
}

/** A code host's CI checks: a failed job's log, read. */
export interface Checks {
  /** The end of the log of the failed CI job `jobId` of `repo` (a pull request's FailedJob id). */
  jobLog(repo: string, jobId: number): Promise<HostJobLog>;
}

/** A code host's posts: what was written on its pull requests and issues, read. */
export interface ReviewPosts {
  /**
   * The comments, review comments, reviews and issue and pull request bodies of `repo` written or edited at or after
   * `since` (an ISO time in whole seconds, UTC), for the mention scan. Their text is outside input.
   */
  posts(repo: string, since: string): Promise<HostPosts>;
}

/** A code host's read of a repository's own label file: a file of the repository, so the code host holds it. */
export interface LabelFiles {
  /** The labels `repo`'s own label file names, as it stands on the default branch, so issue label can make one it lacks. */
  labelFile(repo: string): Promise<HostLabelFile>;
}

/** A code host: where a team's pull requests live, with every capability over them and the repository's files. */
export interface CodeHost extends HostAccess, PullRequests, Checks, ReviewPosts, LabelFiles {}

/** A host of both kinds, as GitHub is: one adapter that is the tracker and the code host of its repositories. */
export interface IssueHost extends Tracker, CodeHost {}

/** What a host gave for its last answers about one repository: the caller keeps them between looks and never reads them. */
export type WatchMarks = ReadonlyMap<string, string>;

/**
 * Whether a repository changed since its marks were given: changed, with the marks to keep once the change is read;
 * unchanged; or the look failed, with one plain line saying why.
 */
export type HostWatch =
  | { readonly kind: 'changed'; readonly marks: WatchMarks }
  | { readonly kind: 'unchanged' }
  | { readonly kind: 'failed'; readonly reason: string };

/**
 * The hosts teamrig has an adapter for, by the team config list that names their repositories. A kind is the id of
 * the host's connector adapter (src/adapters/connectors), which is what it is loaded by.
 */
export type HostKind = 'github';

/** The host whose list is `github.repos`: the one a command that works through that list reaches. */
export const GITHUB_REPOS_HOST: HostKind = 'github';

/** The config lists that name each host's repositories. */
export interface HostLists {
  readonly github: { readonly repos: readonly string[] };
}

/** The host whose config list names `repo`, or undefined when none does. */
export function hostKindOf(repo: string, lists: HostLists): HostKind | undefined {
  return lists.github.repos.includes(repo) ? GITHUB_REPOS_HOST : undefined;
}
