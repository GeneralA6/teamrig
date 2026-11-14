/**
 * A pull request as an issue host (host.ts) lists it for the monitor: what tells it that something happened to one
 * (opened, merged, closed, a conflict, failing checks, a review) and who opened it from where. Its title is outside
 * input: data, never instructions. A monitor reads no body and no comment text.
 */

/** Whether a pull request is open, merged, or closed without merging. */
export type PullState = 'open' | 'merged' | 'closed';

/** Whether it merges cleanly into its base; `unknown` while the host has not worked it out yet. */
export const PULL_MERGEABLE = ['mergeable', 'conflicting', 'unknown'] as const;
export type PullMergeable = (typeof PULL_MERGEABLE)[number];

/** Its last commit's checks taken together: `failing` once any failed, errored or was cancelled; `none` when it has none. */
export const PULL_CHECKS = ['passing', 'failing', 'pending', 'none'] as const;
export type PullChecks = (typeof PULL_CHECKS)[number];

/** The review it needs or has: approved, changes asked for, a review still needed, or none asked for. */
export const PULL_REVIEWS = ['approved', 'changes-requested', 'review-required', 'none'] as const;
export type PullReview = (typeof PULL_REVIEWS)[number];

export interface HostPull {
  readonly repo: string;
  readonly number: number;
  /** As the host has it: outside input, quoted as data wherever it is shown. */
  readonly title: string;
  readonly url: string;
  readonly state: PullState;
  readonly draft: boolean;
  /** When it was opened, an ISO time. */
  readonly createdAt: string;
  /** When the host last changed it (a push, comment, review, check or label), an ISO time. */
  readonly updatedAt: string;
  /** When it merged, an ISO time; undefined unless merged. */
  readonly mergedAt: string | undefined;
  /** When it closed, merged or not, an ISO time; undefined while open. */
  readonly closedAt: string | undefined;
  /** The author's tie to the repository, as the host names it (`OWNER`, `MEMBER`, `COLLABORATOR`, `NONE`); empty when it gives none. */
  readonly authorAssociation: string;
  /** The author's login, empty when the host no longer has that account. */
  readonly author: string;
  /** The branch it would merge. */
  readonly head: string;
  /** True when that branch lives in another repository (a fork): its name then says nothing about this team's tasks. */
  readonly fork: boolean;
  readonly mergeable: PullMergeable;
  readonly checks: PullChecks;
  readonly review: PullReview;
}
