import type { KitConfig } from '../config/types.ts';
import { plainLine, type GithubIssue } from './issues.ts';

/** The priority of an issue with no priority label of the team's: p2, or the team's least urgent level when it has no p2. */
export const ISSUE_PRIORITY = 2;

/** A priority label: `p1`, `P2`. */
const PRIORITY_LABEL = /^p([1-9]\d?)$/i;

/** How GitHub closed an issue that was not done: the task is dropped. Any other close, `COMPLETED` among them, is done. */
const DROPPED_REASONS: ReadonlySet<string> = new Set(['NOT_PLANNED', 'DUPLICATE']);

/** What the import takes from the team config. */
export interface ImportRules {
  readonly maxTitle: number;
  /** The team's priority levels, most urgent first. */
  readonly priorities: readonly number[];
  /** Each GitHub login, in lowercase, to its session. */
  readonly owners: ReadonlyMap<string, string>;
  readonly lead: string;
}

/** The status an issue's state calls for: open, or the end it was closed with. */
export type IssueOutcome = 'open' | 'done' | 'dropped';

/** A task as an issue describes it. Only the title, priority and outcome follow the issue after the import. */
export interface IssueTask {
  /** The task's ref and the sync's key: `gh:<owner>/<name>#<number>`. */
  readonly ref: string;
  readonly title: string;
  readonly priority: number;
  /** Set on the import only: a reassignment in the register stays. */
  readonly owner: string;
  readonly outcome: IssueOutcome;
  readonly url: string;
}

export function importRules(config: KitConfig): ImportRules {
  return {
    maxTitle: config.register.maxTitle,
    priorities: config.register.priorities.map((level) => level.id),
    owners: new Map(Object.entries(config.github.owners)),
    lead: config.roles.lead,
  };
}

/** The ref of an issue's task: one per issue, whatever its title or state. */
export function issueRef(repo: string, number: number): string {
  return `gh:${repo}#${number}`;
}

export function issueTask(issue: GithubIssue, rules: ImportRules): IssueTask {
  return {
    ref: issueRef(issue.repo, issue.number),
    title: taskTitle(issue, rules.maxTitle),
    priority: issuePriority(issue.labels, rules.priorities),
    owner: issueOwner(issue.assignees, rules),
    outcome: issueOutcome(issue),
    url: issue.url,
  };
}

/**
 * The issue's title on one plain line, cut to `maxTitle`: outside text, so control and format characters
 * go. A title with nothing left names the issue instead.
 */
export function taskTitle(issue: GithubIssue, maxTitle: number): string {
  const title = plainLine(issue.title);
  const text = title === '' ? `GitHub issue ${issue.repo}#${issue.number}` : title;
  // A cut between the two halves of a character leaves the first half alone: it goes too.
  return text.length <= maxTitle ? text : text.slice(0, maxTitle).replace(/[\uD800-\uDBFF]$/, '').trimEnd();
}

/** The most urgent `p<n>` label that is one of the team's levels; else ISSUE_PRIORITY, or the least urgent level without it. */
export function issuePriority(labels: readonly string[], priorities: readonly number[]): number {
  const levels = labels
    .map((label) => PRIORITY_LABEL.exec(label.trim())?.[1])
    .filter((level) => level !== undefined)
    .map(Number)
    .filter((level) => priorities.includes(level));
  if (levels.length > 0) {
    return Math.min(...levels);
  }
  return priorities.includes(ISSUE_PRIORITY) ? ISSUE_PRIORITY : (priorities.at(-1) ?? ISSUE_PRIORITY);
}

/** The session of the first assignee `github.owners` lists, in GitHub's order; the lead when none is listed. */
export function issueOwner(assignees: readonly string[], rules: ImportRules): string {
  for (const login of assignees) {
    const session = rules.owners.get(login.toLowerCase());
    if (session !== undefined) {
      return session;
    }
  }
  return rules.lead;
}

export function issueOutcome(issue: GithubIssue): IssueOutcome {
  if (issue.state === 'open') {
    return 'open';
  }
  return DROPPED_REASONS.has(issue.stateReason.toUpperCase()) ? 'dropped' : 'done';
}
