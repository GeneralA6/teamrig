/**
 * The issue host port: where a team's issues and pull requests live, behind names that hold for any host. teamrig
 * writes to a host only through this port, and each host (GitHub is the only one so far, src/github/host.ts) is an
 * adapter that keeps its own access rules. A repository reaches a host only when the team config lists it there.
 */

import type { HostIssue, LinkedIssue } from './issue.ts';

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

/** Whether a repository has a label: it has, it has not, or the read failed, with one plain line saying why. */
export type HostLabel = { readonly kind: 'found' } | { readonly kind: 'missing' } | { readonly kind: 'failed'; readonly reason: string };

/** Whether a login may be assigned in a repository: found, missing (it may not), or the read failed. */
export type HostAssignee = HostLabel;

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

/** One issue to open: its repository (`owner/name`), title, body and labels. */
export interface IssueDraft {
  readonly repo: string;
  readonly title: string;
  readonly body: string;
  readonly labels: readonly string[];
}

/** How opening an issue ended: the issue opened, or one plain line saying why there is none. */
export type HostOpen = { readonly kind: 'opened'; readonly target: IssueTarget } | { readonly kind: 'failed'; readonly reason: string };

/** An issue host: its reads of a repository's issues and its writes. Each ends in a result and never throws. */
export interface IssueHost {
  /** The host's name, for a message. */
  readonly name: string;
  /** How the host is reached for `repo` to `use` it. Asked before any read or write, so a key that cannot be read does nothing. */
  reach(repo: string, use: HostUse): Promise<HostReach>;
  /** The open issues of `repo` and those closed on or after `closedSince` (`YYYY-MM-DD`, UTC), the newest state of each. */
  list(repo: string, closedSince: string): Promise<HostList>;
  /** Opens one issue. */
  open(draft: IssueDraft): Promise<HostOpen>;
  /** Posts `body` as one comment. */
  comment(target: IssueTarget, body: string): Promise<HostEnd>;
  /** Replaces the body (the description) of the issue or pull request with `body`; its title, state and the rest stay. */
  editBody(target: IssueTarget, body: string): Promise<HostEnd>;
  /**
   * Closes the issue or pull request, giving `reason` when there is one; a duplicate also names the issue it
   * duplicates by its host id (issueId), which the host links. `duplicateId` is used only with the duplicate reason.
   */
  close(target: IssueTarget, reason?: CloseReason, duplicateId?: number): Promise<HostEnd>;
  /** The host's id of one issue, read so a link can name it. */
  issueId(target: IssueTarget): Promise<HostIssueId>;
  /** Whether `repo` has the label `label`, so a label is only added once the repository has it. */
  labelExists(repo: string, label: string): Promise<HostLabel>;
  /** Adds `labels` to the issue or pull request. */
  addLabels(target: IssueTarget, labels: readonly string[]): Promise<HostEnd>;
  /** Takes `label` off the issue or pull request; the repository keeps the label. */
  removeLabel(target: IssueTarget, label: string): Promise<HostEnd>;
  /** Every issue of `repo` with its host id, its parent and its blockers. */
  links(repo: string): Promise<HostLinks>;
  /** Puts the issue whose host id is `childId` under `parent` as its sub-issue. */
  addSubIssue(parent: IssueTarget, childId: number): Promise<HostEnd>;
  /** Marks `target` blocked by the issue whose host id is `blockerId`. */
  addBlockedBy(target: IssueTarget, blockerId: number): Promise<HostEnd>;
  /** Whether `login` may be assigned in `repo`, so an assign is only sent for one the host would not drop. */
  assigneeExists(repo: string, login: string): Promise<HostAssignee>;
  /** Adds `logins` to the assignees of the issue or pull request; those already on it stay. */
  assign(target: IssueTarget, logins: readonly string[]): Promise<HostEnd>;
  /**
   * Whether `repo` changed since the host gave `marks`, cheaply enough to ask every minute: no list is read. Empty
   * marks always read as changed.
   */
  watch(repo: string, marks: WatchMarks): Promise<HostWatch>;
}

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

/** The hosts teamrig has an adapter for, by the team config list that names their repositories. */
export type HostKind = 'github';

/** The config lists that name each host's repositories. */
export interface HostLists {
  readonly github: { readonly repos: readonly string[] };
}

/** The host whose config list names `repo`, or undefined when none does. */
export function hostKindOf(repo: string, lists: HostLists): HostKind | undefined {
  return lists.github.repos.includes(repo) ? 'github' : undefined;
}
