import { KIT_NAME } from '../core/home.ts';
import type { HostIssue } from '../issues/issue.ts';
import { issueRef } from './map.ts';

/**
 * The security part of the GitHub routing (T3021 sections 3 and 7): an open issue labelled `security`, by the issue
 * form or by a maintainer, wakes the session it routes to and pages the owner, at most once per issue. The sync state
 * keeps the numbers already paged (auto.ts), so a label set after the issue was imported pages too, and a lasting one
 * pages once. Neither the line nor the page repeats the title: a report posted in public may name the hole in it.
 */

/** The label that marks a security report. */
export const SECURITY_LABEL = 'security';

/** An open issue labelled security, and the session it routes to. */
export interface SecurityIssue {
  readonly repo: string;
  readonly number: number;
  readonly url: string;
  readonly to: string;
}

/** The open issues of a read that carry the security label, any case, each with the session `routeOf` gives it. */
export function securityIssues(issues: readonly HostIssue[], routeOf: (issue: HostIssue) => string): SecurityIssue[] {
  return issues
    .filter((issue) => issue.state === 'open' && issue.labels.some((label) => label.toLowerCase() === SECURITY_LABEL))
    .map((issue) => ({ repo: issue.repo, number: issue.number, url: issue.url, to: routeOf(issue) }));
}

/** The security issues of `found` whose number `paged` (the last sync's, by repository) does not hold. */
export function unpagedIssues(found: ReadonlyMap<string, readonly SecurityIssue[]>, paged: ReadonlyMap<string, readonly number[]>): SecurityIssue[] {
  return [...found].flatMap(([repo, issues]) => issues.filter((issue) => !(paged.get(repo) ?? []).includes(issue.number)));
}

/** The numbers each repository's security issues hold now, lowest first; a repository with none is left out. */
export function pagedNumbers(found: ReadonlyMap<string, readonly SecurityIssue[]>): Map<string, readonly number[]> {
  return new Map(
    [...found].flatMap(([repo, issues]) => (issues.length === 0 ? [] : [[repo, issues.map((issue) => issue.number).sort((a, b) => a - b)] as const])),
  );
}

/** The routed session's inbox line: the issue by ref and URL, never its title, and what to do first. */
export function securityLine(issue: SecurityIssue): string {
  return (
    `GitHub security issue ${issueRef(issue.repo, issue.number)} is yours: read it now; if it shows how to exploit a hole, ` +
    `hide those details and move them to a private advisory (${issue.url})`
  );
}

/** The owner's page: which issue, where it went, when and its URL; never its title. */
export function securityPageText(issue: SecurityIssue, team: string, clock: string): string {
  return `${KIT_NAME}: security issue ${issueRef(issue.repo, issue.number)} on GitHub, routed to ${team}/${issue.to} at ${clock}: ${issue.url}`;
}

/** The lead's line when the owner could not be paged for a security issue, and why. */
export function unpagedLine(issue: SecurityIssue, why: string): string {
  return `GitHub security issue ${issueRef(issue.repo, issue.number)} went to ${issue.to}, but the owner was not paged: ${why}`;
}
