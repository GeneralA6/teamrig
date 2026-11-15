/**
 * The issue host port: where a team's issues and pull requests live, behind names that hold for any host. teamrig
 * writes to a host only through this port, and each host (GitHub is the only one so far, src/github/host.ts) is an
 * adapter that keeps its own access rules. A repository reaches a host only when the team config lists it there.
 */

import type { HostIssue } from './issue.ts';

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

/**
 * A repository's issues as one list read them, the open ones and those closed since the day it was given, with what
 * a reader should know about the read; or why it could not be read, in which case nothing of it was.
 */
export type HostList =
  | { readonly kind: 'listed'; readonly issues: readonly HostIssue[]; readonly notes: readonly string[] }
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
  /** Closes the issue or pull request. */
  close(target: IssueTarget): Promise<HostEnd>;
}

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
