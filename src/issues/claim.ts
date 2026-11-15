import { isRecord } from '../core/guards.ts';
import { parseObject, toJsonlLine, VERSION_FIELD } from '../core/jsonl.ts';
import { DESIGN_LABEL } from './design-label.ts';
import type { HostIssue, IssueComment } from './issue.ts';
import { isInsider } from '../github/trust.ts';

/**
 * A contributor claims an open issue by a comment, and code assigns them (T3021 design, section 1). This file holds
 * the decisions only: which comment is a claim, which claims a sync makes, and which run out. It reads and writes
 * nothing; the sync applies its plan.
 */

/** Days a claim holds with no linked pull request before code takes the assignee off again. */
export const CLAIM_DAYS = 7;
const DAY_MS = 86_400_000;
/**
 * The most claims one sync makes in one repository. A burst of claims from many new accounts is not a contributor
 * at work; the rest wait for the next sync, so a real claim is only late, never lost.
 */
export const CLAIMS_PER_RUN = 5;

/**
 * A claim line: only `/take`, or a line starting "I'll take", "I'm working on" or "I can take", either apostrophe.
 * Anchored at the line's start, so a quoted line (`> I'll take`) is someone else's words and no claim.
 */
const CLAIM_LINE = /^(?:\/take$|(?:i['’]ll take|i['’]m working on|i can take)\b)/i;
const FENCE = /^(?:```|~~~)/;

/** True when one line of `body`, outside a fenced block, is a claim line. */
export function isClaim(body: string): boolean {
  let fenced = false;
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (FENCE.test(line)) {
      fenced = !fenced;
    } else if (!fenced && CLAIM_LINE.test(line)) {
      return true;
    }
  }
  return false;
}

/** A claim code made: who, on which issue, and when (ms since the epoch). Kept in the sync state. */
export interface Claim {
  readonly repo: string;
  readonly number: number;
  readonly login: string;
  readonly at: number;
}

/** The format of the claims file this code writes; a file in another format, or damaged, reads as no claim made. */
export const CLAIM_STATE_FORMAT = 1;

/**
 * The claims a file holds; a damaged entry is left out, a damaged file reads as none. Reading none is the safe side:
 * a claim code no longer knows is never taken off, it only stays until a person does.
 */
export function parseClaims(text: string): Claim[] {
  const record = parseObject(text.trim());
  const list = record?.[VERSION_FIELD] === CLAIM_STATE_FORMAT ? record['claims'] : undefined;
  return Array.isArray(list) ? list.flatMap(claimOf) : [];
}

function claimOf(value: unknown): Claim[] {
  if (!isRecord(value)) {
    return [];
  }
  const { repo, number, login, at } = value;
  const valid = typeof repo === 'string' && typeof login === 'string' && login !== '' && Number.isSafeInteger(number) && typeof number === 'number' && number > 0;
  return valid && typeof at === 'number' && Number.isFinite(at) ? [{ repo, number, login, at }] : [];
}

export function formatClaims(claims: readonly Claim[]): string {
  return toJsonlLine({ [VERSION_FIELD]: CLAIM_STATE_FORMAT, claims: claims.map(({ repo, number, login, at }) => ({ repo, number, login, at })) });
}

/** The issue facts a claim plan reads. */
export type ClaimIssue = Pick<HostIssue, 'repo' | 'number' | 'state' | 'labels' | 'assignees' | 'comments' | 'linkedPulls'>;

/** The account kind of a person; an app (`Bot`) or an organization never claims. */
const PERSON = 'User';

/** What a sync does with claims: assign each new one, take the assignee off each that ran out, keep the rest. */
export interface ClaimPlan {
  readonly made: readonly Claim[];
  readonly expired: readonly Claim[];
  readonly kept: readonly Claim[];
}

/** Ms since the epoch. */
export interface ClaimTimes {
  readonly now: number;
  /** The previous sync's start: a comment before it was read then, so it claims nothing now. */
  readonly since: number;
}

/**
 * The claims of one repository after a sync: `claims` are those code made before (only these may ever lose their
 * assignee), `issues` the repository's issues as just read. A claim whose issue closed, or whose login is no longer
 * an assignee (handed over, or taken off by hand), is dropped with no write; one with a linked pull request holds.
 */
export function planClaims(issues: readonly ClaimIssue[], claims: readonly Claim[], times: ClaimTimes): ClaimPlan {
  const byNumber = new Map(issues.map((issue) => [`${issue.repo}#${issue.number}`, issue]));
  const kept: Claim[] = [];
  const expired: Claim[] = [];
  for (const claim of claims) {
    const issue = byNumber.get(`${claim.repo}#${claim.number}`);
    if (issue === undefined || issue.state !== 'open' || !issue.assignees.includes(claim.login)) {
      continue;
    }
    if (issue.linkedPulls === 0 && times.now - claim.at >= CLAIM_DAYS * DAY_MS) {
      expired.push(claim);
    } else {
      kept.push(claim);
    }
  }
  const made: Claim[] = [];
  for (const issue of issues) {
    if (made.filter((claim) => claim.repo === issue.repo).length >= CLAIMS_PER_RUN || !claimable(issue)) {
      continue;
    }
    const holding = new Set([...kept, ...made].filter((claim) => claim.repo === issue.repo).map((claim) => claim.login));
    const comment = firstClaim(issue, times.since, holding);
    if (comment !== undefined) {
      made.push({ repo: issue.repo, number: issue.number, login: comment.login, at: Date.parse(comment.at) });
    }
  }
  return { made, expired, kept };
}

/** An open issue with no assignee that is not a design issue (talk, never work to take). */
function claimable(issue: ClaimIssue): boolean {
  return issue.state === 'open' && issue.assignees.length === 0 && !issue.labels.includes(DESIGN_LABEL);
}

/** The oldest claim comment since `since` by an outside person holding no other claim in the repository. */
function firstClaim(issue: ClaimIssue, since: number, holding: ReadonlySet<string>): IssueComment | undefined {
  return [...issue.comments]
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
    .find(
      (comment) =>
        comment.claims &&
        Date.parse(comment.at) >= since &&
        comment.login !== '' &&
        comment.authorKind === PERSON &&
        !isInsider(comment.authorAssociation) &&
        !holding.has(comment.login),
    );
}
