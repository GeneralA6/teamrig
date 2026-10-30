import { roleHolderOf } from "../config/roster.js";
import { formatAddress } from "../core/address.js";
import { sessionWeightOf, shareOf, teamTreeOf } from "./parts.js";
import { workWeightOf } from "./work.js";
/** The roles whose holder a short day never pauses: the lead leads the cut, the coordinator owner keeps the fleet up. */
const KEPT_ROLES = ['lead', 'coordinatorOwner'];
/**
 * The sessions of `team` (its roster `ids`) a short day may pause: none while its `budget.pauseByPriority` is off,
 * else all but the holders of the kept roles that the team holds itself (a `<team>/<id>` holder is a team above's).
 */
export function pausableOf(config, team, ids) {
    if (!config.budget.pauseByPriority) {
        return new Set();
    }
    const kept = new Set();
    for (const role of KEPT_ROLES) {
        const holder = roleHolderOf(config.roles, role, team);
        if (holder !== undefined && holder.team === team) {
            kept.add(holder.id);
        }
    }
    return new Set(ids.filter((id) => !kept.has(id)));
}
/** A short day: what is left of the week gives the day less than the pace line plans for it, as when the week's use is past the line. */
export function isShortDay(day) {
    return day.plannedPct > 0 && day.allowancePct < day.plannedPct;
}
/**
 * The sessions the teams' trees hold, each kept unless its team may pause it and no lift, its own, its group's or a
 * team above's (`crossLifted`), is in force.
 */
function leavesOf(splits) {
    const crossLifted = new Set(splits.flatMap((split) => [...split.crossLifted.keys()]));
    return splits.flatMap((split) => [...teamTreeOf(split).sessionPaths].map(([id, path]) => {
        const lifted = split.lifted.has(id) || crossLifted.has(formatAddress({ team: split.team, id })) || path.slice(0, -1).some((group) => split.liftedGroups.has(group));
        return { team: split.team, id, share: shareOf(split, id), work: split.work.get(id) ?? new Map(), weight: sessionWeightOf(split, id), kept: lifted || !split.pausable.has(id) };
    }));
}
function weightOfAll(leaves) {
    return leaves.reduce((sum, leaf) => sum + leaf.weight, 0);
}
/**
 * The teams on the account with their sessions funded in priority order on a short day (`isShortDay`), account-wide
 * so every team's view reads the same cut. The day funds `T × allowance / planned` of the sessions' summed weight `T`:
 * the weight the pace line's rate gives the day. The kept sessions (not `pausable`, or under a lift in force) come off
 * it first and whole, then each priority's queued work, p0 first, then the idle sessions; the tier the funding runs
 * out in is funded in part, the tiers after it not at all. A session's funded part is its funded work over its whole
 * work, so while no lift is in force a funded session gets the part the pace line's rate gives it, and one none of the
 * funding reaches gets 0: paused (`isPaused`). Any other day every session is funded whole.
 */
export function fundByPriority(teams, day) {
    const funded = isShortDay(day) ? fundedParts([teams.split, ...teams.others], day) : new Map();
    const fundedSplit = (split) => ({ ...split, funded: funded.get(split.team) ?? new Map() });
    return { split: fundedSplit(teams.split), others: teams.others.map(fundedSplit) };
}
/** The teams on the account funded for the week's day (`fundByPriority`); as they are while its allowance or plan is unknown. */
export function fundForDay(teams, week) {
    const { allowancePct, plannedPct } = week;
    return allowancePct === undefined || plannedPct === undefined ? teams : fundByPriority(teams, { allowancePct, plannedPct });
}
/** Each cut session's funded part (`fundByPriority`) of a short day, by team; a team with none cut is not in it. */
function fundedParts(splits, day) {
    const leaves = leavesOf(splits);
    const cut = leaves.filter((leaf) => !leaf.kept);
    let left = Math.max(0, (weightOfAll(leaves) * day.allowancePct) / day.plannedPct - weightOfAll(leaves.filter((leaf) => leaf.kept)));
    /** The part of a tier weighing `weight` that what is left of the day's funding reaches, taken from it. */
    const fund = (weight) => {
        if (weight <= left) {
            left -= weight;
            return 1;
        }
        const part = left / weight;
        left = 0;
        return part;
    };
    const tiers = new Map();
    for (const leaf of cut) {
        for (const [priority, weight] of leaf.work) {
            tiers.set(priority, (tiers.get(priority) ?? 0) + leaf.share * weight);
        }
    }
    const tierParts = new Map([...tiers].sort(([a], [b]) => a - b).map(([priority, weight]) => [priority, fund(weight)]));
    const idlePart = fund(weightOfAll(cut.filter((leaf) => workWeightOf(leaf.work) === 0)));
    const byTeam = new Map();
    for (const leaf of cut) {
        const whole = workWeightOf(leaf.work);
        let reached = 0;
        for (const [priority, weight] of leaf.work) {
            reached += (tierParts.get(priority) ?? 0) * weight;
        }
        const parts = byTeam.get(leaf.team) ?? new Map();
        parts.set(leaf.id, whole === 0 ? idlePart : reached / whole);
        byTeam.set(leaf.team, parts);
    }
    return byTeam;
}
/** A session a short day pauses (`fundByPriority`): none of the day's funding reaches its work, so its part is 0. */
export function isPaused(split, id) {
    return split.funded.get(id) === 0;
}
