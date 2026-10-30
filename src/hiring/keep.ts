import { LeadTree } from '../config/lead-tree.ts';
import type { KitConfig } from '../config/types.ts';
import type { Checked } from '../setup/team-create.ts';
import { checkedReviewDay } from './plan.ts';
import type { HireRecord, KeepRecord } from './record.ts';

/**
 * The plan behind `hire <id> --review <day>` on a hired session: it stays on the team to a new review day, which clears
 * its REVIEW-DUE (src/hiring/due.ts); its job and launch stay as hired. Only a lead over it keeps it, as only one
 * retires it, under every `hiring.policy` and with no owner's approval: a keep adds no session, and the leader decides
 * which workers the team needs. Pure: it takes the hires still active and returns the record to log.
 */

export interface KeepRequest {
  readonly id: string;
  /** Its new review day, `YYYY-MM-DD`. */
  readonly reviewBy: string;
  /** Why the team still needs it. */
  readonly reason: string;
  /** The session keeping it. */
  readonly by: string;
  readonly now: number;
}

export interface KeepPlan {
  readonly keep: KeepRecord;
  /** The hire it keeps, at the review day it had. */
  readonly hire: HireRecord;
}

/** The keep to log for a hired session, or why not. */
export function planKeep(config: Pick<KitConfig, 'sessions' | 'roles' | 'leads'>, active: readonly HireRecord[], request: KeepRequest): Checked<KeepPlan> {
  if (request.by !== config.roles.lead && !new LeadTree(config).leads(request.by, request.id)) {
    return { ok: false, problem: 'only a lead over the session keeps it (the lead, or its sub-lead): the leader decides which workers the team needs' };
  }
  const hire = active.find((record) => record.session === request.id);
  if (hire === undefined) {
    return { ok: false, problem: `${request.id} is set up with the team, not hired: it has no review day to keep` };
  }
  if (request.reason.trim() === '') {
    return { ok: false, problem: 'a keep needs why the team still needs it (--reason)' };
  }
  const reviewBy = checkedReviewDay(request.reviewBy, request.now);
  if (!reviewBy.ok) {
    return reviewBy;
  }
  const keep: KeepRecord = { kind: 'keep', session: request.id, reviewBy: reviewBy.value, reason: request.reason.trim(), by: request.by, at: request.now };
  return { ok: true, value: { keep, hire } };
}
