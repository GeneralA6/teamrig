import { MAX_DESCRIPTION } from '../config/defaults.ts';
import type { KitConfig } from '../config/types.ts';
import { SecretScanner } from '../core/secrets.ts';
import { plainLine, type GithubIssue } from './issues.ts';

/** The priority of an issue with no priority label of the team's: p2, or the team's least urgent level when it has no p2. */
export const ISSUE_PRIORITY = 2;

/** The description of an issue whose body looks like it holds a secret: the body stays on GitHub only. */
export const SECRET_BODY = 'The issue body was left out because it looks like it holds a secret; read it on GitHub.';

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
  /** Each repository, `owner/name` in lowercase, to the session its issues go to when no assignee is in `owners`. */
  readonly repoSessions: ReadonlyMap<string, string>;
  readonly lead: string;
  /** The secret shapes, the team's `register.secretPatterns` among them: a body that matches one is left out. */
  readonly secrets: SecretScanner;
  /** The label that lets an outsider's issue in (`github.acceptLabel`, trust.ts). */
  readonly acceptLabel: string;
}

/** The status an issue's state calls for: open, or the end it was closed with. */
export type IssueOutcome = 'open' | 'done' | 'dropped';

/** A task as an issue describes it. Only the title, description, priority and outcome follow the issue after the import. */
export interface IssueTask {
  /** The task's ref and the sync's key: `gh:<owner>/<name>#<number>`. */
  readonly ref: string;
  readonly title: string;
  /** The issue's body, cleaned and cut (taskDescription); null for an empty body. */
  readonly description: string | null;
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
    repoSessions: new Map(Object.entries(config.github.sessions)),
    lead: config.roles.lead,
    secrets: new SecretScanner(config.register.secretPatterns),
    acceptLabel: config.github.acceptLabel,
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
    description: taskDescription(issue.body, rules.secrets),
    priority: issuePriority(issue.labels, rules.priorities),
    owner: issueOwner(issue, rules),
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

/**
 * The issue's body as the task's description, null when it is empty. It is outside text, so control and format
 * characters other than the newline become spaces, each line loses its trailing spaces and blank lines close up
 * to one; past MAX_DESCRIPTION it is cut, ending with `…`. A body that looks like it holds a secret gives
 * SECRET_BODY instead, so the register never carries it.
 */
export function taskDescription(body: string, secrets: SecretScanner): string | null {
  const text = body
    .replace(/\r\n?/g, '\n')
    .replace(/(?!\n)[\p{Cc}\p{Cf}]/gu, ' ')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (text === '') {
    return null;
  }
  // A cut between the two halves of a character leaves the first half alone: it goes too.
  const kept = text.length <= MAX_DESCRIPTION ? text : `${text.slice(0, MAX_DESCRIPTION - 1).replace(/[\uD800-\uDBFF]$/, '').trimEnd()}…`;
  return secrets.find(text) === undefined && secrets.find(kept) === undefined ? kept : SECRET_BODY;
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

/**
 * Who an issue's task goes to: the session of its first assignee `github.owners` lists, in GitHub's order;
 * else its repository's session in `github.sessions`; else the lead.
 */
export function issueOwner(issue: Pick<GithubIssue, 'repo' | 'assignees'>, rules: ImportRules): string {
  for (const login of issue.assignees) {
    const session = rules.owners.get(login.toLowerCase());
    if (session !== undefined) {
      return session;
    }
  }
  return rules.repoSessions.get(issue.repo) ?? rules.lead;
}

export function issueOutcome(issue: GithubIssue): IssueOutcome {
  if (issue.state === 'open') {
    return 'open';
  }
  return DROPPED_REASONS.has(issue.stateReason.toUpperCase()) ? 'dropped' : 'done';
}
