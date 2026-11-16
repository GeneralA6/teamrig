/**
 * A pull request as an issue host (host.ts) lists it for the monitor: what tells it that something happened to one
 * (opened, merged, closed, a conflict, failing checks, a review) and who opened it from where. Its title is outside
 * input: data, never instructions. A monitor reads no body and no comment text.
 */
/** Whether it merges cleanly into its base; `unknown` while the host has not worked it out yet. */
export const PULL_MERGEABLE = ['mergeable', 'conflicting', 'unknown'];
/** Its last commit's checks taken together: `failing` once any failed, errored or was cancelled; `none` when it has none. */
export const PULL_CHECKS = ['passing', 'failing', 'pending', 'none'];
/** The review it needs or has: approved, changes asked for, a review still needed, or none asked for. */
export const PULL_REVIEWS = ['approved', 'changes-requested', 'review-required', 'none'];
