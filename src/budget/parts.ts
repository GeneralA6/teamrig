import { DEFAULT_SESSION_SHARE } from '../config/defaults.ts';
import type { SessionBudget } from '../config/types.ts';
import { activeLift, type Lift } from './lift.ts';

/** How the team's daily budget is split among its sessions; every part moves with the budget it splits. */
export interface BudgetSplit {
  /** The team's sessions, the whole roster. */
  readonly ids: readonly string[];
  readonly sessions: Readonly<Record<string, SessionBudget>>;
  /** Each session's queued work (`workWeights`); a session not in it counts 1. */
  readonly work: ReadonlyMap<string, number>;
  /** The lifts in force, as each lifted session's part of the team's budget in percent (`liftedParts`). */
  readonly lifted: ReadonlyMap<string, number>;
}

/** A session's weight in the split: its `share` times its queued work, at least 1 so a session with none still gets a part. */
function weightOf(split: BudgetSplit, id: string): number {
  return (split.sessions[id]?.share ?? DEFAULT_SESSION_SHARE) * Math.max(1, split.work.get(id) ?? 0);
}

/**
 * The session's part of the team's daily budget (`allowancePct`, in percent of the week): a lifted session's is
 * its lift's part of it; a fixed `dailyPct` is given as is; what those leave is split among the other sessions by
 * weight. Recomputed with the budget, so no session waits while the week has room and the parts never add up to
 * more than the team's budget.
 */
export function sessionBudgetPct(allowancePct: number, session: string, split: BudgetSplit): number {
  const liftedPart = split.lifted.get(session);
  if (liftedPart !== undefined) {
    return (allowancePct * liftedPart) / 100;
  }
  const own = split.sessions[session]?.dailyPct;
  if (own !== undefined) {
    return own;
  }
  let liftedPct = 0;
  let fixed = 0;
  let weights = 0;
  for (const id of split.ids) {
    const part = split.lifted.get(id);
    const daily = split.sessions[id]?.dailyPct;
    if (part !== undefined) {
      liftedPct += part;
    } else if (daily !== undefined) {
      fixed += daily;
    } else {
      weights += weightOf(split, id);
    }
  }
  const rest = Math.max(0, (allowancePct * Math.max(0, 100 - liftedPct)) / 100 - fixed);
  return weights > 0 ? (rest * weightOf(split, session)) / weights : 0;
}

/**
 * The session's daily budget now, in percent of the week: its part of the team's (`sessionBudgetPct`), or its
 * fixed `dailyPct` while the team's is unknown; undefined when neither is known.
 */
export function dailyBudgetOf(allowancePct: number | undefined, session: string, split: BudgetSplit): number | undefined {
  return allowancePct === undefined ? split.sessions[session]?.dailyPct : sessionBudgetPct(allowancePct, session, split);
}

/** The lifts in force at `now` (`activeLift`), as each lifted session's part of the team's budget. */
export function liftedParts(lifts: readonly Lift[], ids: readonly string[], now: number, usedPct: number | undefined): ReadonlyMap<string, number> {
  const parts = new Map<string, number>();
  for (const id of ids) {
    const lift = activeLift(lifts, id, now, usedPct);
    if (lift !== undefined) {
      parts.set(id, lift.partPct);
    }
  }
  return parts;
}
