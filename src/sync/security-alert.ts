import { KIT_NAME } from '../core/home.ts';
import type { HostIssue } from '../issues/issue.ts';
import { issueRef } from './map.ts';

/**
 * The security part of the GitHub routing (T3021 sections 3 and 7): an open issue labelled `security`, by the issue
 * form or by a maintainer, wakes the session it routes to and pages the owner, at most once per issue ever. The sync
 * state keeps every number already paged for good (auto.ts), so a label set after the issue was imported pages too,
 * and a lasting one, a close and reopen or a label taken off and set again never pages twice. The issue form sets the
 * label, so anyone can open many at once: a run pages and wakes for at most SECURITY_ALERTS_PER_RUN of them, and
 * gives the rest to the lead in one line and one page (security pass T3060 F1). Neither the lines nor the pages
 * repeat a title: a report posted in public may name the hole in it.
 */

/** The label that marks a security report. */
export const SECURITY_LABEL = 'security';

/** Security issues one run pages the owner and wakes a session for, each on its own: one wake costs about 0.34% of the week. */
export const SECURITY_ALERTS_PER_RUN = 3;

/** Refs the over-the-cap line and page name; the rest are counted, so neither grows with a flood of issues. */
const NAMED_OVER_CAP = 10;

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

/**
 * The numbers paged once this run ends: every one `before` held, of any repository, and those of each security issue
 * `found` now, lowest first. A number is never dropped, so an issue closed or unlabelled and then reopened or
 * labelled again does not page twice; one security issue is a few bytes, so the list stays small.
 */
export function pagedAfter(before: ReadonlyMap<string, readonly number[]>, found: ReadonlyMap<string, readonly SecurityIssue[]>): Map<string, readonly number[]> {
  const paged = new Map(before);
  for (const [repo, issues] of found) {
    if (issues.length > 0) {
      const numbers = new Set([...(paged.get(repo) ?? []), ...issues.map((issue) => issue.number)]);
      paged.set(repo, [...numbers].sort((a, b) => a - b));
    }
  }
  return paged;
}

/** `issues` split at the run's cap: the first SECURITY_ALERTS_PER_RUN paged and woken for each, and the rest. */
export function capAlerts(issues: readonly SecurityIssue[]): { readonly each: readonly SecurityIssue[]; readonly overCap: readonly SecurityIssue[] } {
  return { each: issues.slice(0, SECURITY_ALERTS_PER_RUN), overCap: issues.slice(SECURITY_ALERTS_PER_RUN) };
}

/** The refs of the security issues past the cap, each with the session it routes to, at most NAMED_OVER_CAP named. */
function overCapRefs(overCap: readonly SecurityIssue[]): string {
  const named = overCap.slice(0, NAMED_OVER_CAP).map((issue) => `${issueRef(issue.repo, issue.number)} (${issue.to})`);
  const more = overCap.length - named.length;
  return `${named.join(', ')}${more > 0 ? `, and ${more} more` : ''}`;
}

/** The lead's line for the security issues past the run's cap, and why the owner was not paged for them, if not. */
export function overCapLine(overCap: readonly SecurityIssue[], why: string | undefined): string {
  return (
    `${overCap.length} more GitHub security issues this run, past its cap of ${SECURITY_ALERTS_PER_RUN} pages and wakes; ` +
    `none of their sessions was told: read each and hand it on: ${overCapRefs(overCap)}${why === undefined ? '' : `; the owner was not paged: ${why}`}`
  );
}

/** The owner's page for the security issues past the run's cap: how many, their refs, who has them and when. */
export function overCapPageText(overCap: readonly SecurityIssue[], team: string, lead: string, clock: string): string {
  return `${KIT_NAME}: ${overCap.length} more security issues on GitHub past this run's cap, told to ${team}/${lead} at ${clock}: ${overCapRefs(overCap)}`;
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
