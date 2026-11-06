import { NOW_PRIORITY } from "../config/priorities.js";
import { MS_PER_DAY } from "../core/time.js";
/** A task's own value: a Roadmap task's by its goal rank, a Maintenance task's by its severity, any other class's flat. */
export function valueOf(facts, focus) {
    const { score } = focus;
    if (facts.workClass === focus.roadmapClass) {
        return facts.rank === null ? score.roadmapUnranked : (score.rankValues[Math.min(facts.rank, score.rankValues.length) - 1] ?? score.roadmapUnranked);
    }
    if (facts.workClass === focus.maintenanceClass) {
        return score.maintenanceValue + (facts.type === 'bug' ? score.maintenanceBug : 0) + (facts.critical ? score.maintenanceCritical : 0);
    }
    return score.improvementsValue;
}
/** What the date adds: the overdue value past the due, the due-soon value up to `dueSoonDays` before it, else nothing. */
export function urgencyOf(dueAt, now, score) {
    if (dueAt === undefined) {
        return 0;
    }
    if (now > dueAt) {
        return score.overdueValue;
    }
    return dueAt - now <= score.dueSoonDays * MS_PER_DAY ? score.dueSoonValue : 0;
}
/**
 * What the tasks that need it add: a share of the best value among them. A value, never their whole cost of delay, so
 * a chain of needs adds one step and a loop of them cannot recurse.
 */
export function unblocksOf(neededValue, score) {
    return neededValue === undefined ? 0 : score.unblocksShare * neededValue;
}
/** The capped override an owner's order adds; every other priority adds nothing. */
export function ownerOrderOf(facts, score) {
    return facts.ownerSourced ? (score.ownerOrderValues[facts.priority - 1] ?? 0) : 0;
}
/**
 * The share of the week a score divides by: the task's size; else twice what it spent, a task half done by the only
 * measure there is; else what like tasks took; else the default; never under the floor, so a tiny task cannot outrank
 * everything.
 */
export function sizePctOf(facts, score) {
    const measured = facts.spentPct > 0 ? facts.spentPct * 2 : facts.likeMedianPct;
    return Math.max(facts.size ?? measured ?? score.defaultSizePct, score.minSizePct);
}
/**
 * The band of a task. A p0 always expedites: it means started ahead of the task in hand, whatever its class or who
 * asked, so no config turns it off. Every other expedite needs its arm on in `focus.expedite`.
 */
export function bandOf(facts, focus) {
    const maintenance = facts.workClass === focus.maintenanceClass;
    if (facts.priority === NOW_PRIORITY.id || (focus.expedite.critical && maintenance && facts.critical) || (focus.expedite.ownerP1 && facts.ownerSourced && facts.priority === 1)) {
        return 0;
    }
    return maintenance || facts.workClass === focus.roadmapClass ? 1 : 2;
}
/** A task's band and score at `now`. */
export function scoreOf(facts, focus, now) {
    const { score } = focus;
    const costOfDelay = valueOf(facts, focus) + urgencyOf(facts.dueAt, now, score) + unblocksOf(facts.neededValue, score) + ownerOrderOf(facts, score);
    const sizePct = sizePctOf(facts.sizing, score);
    return { band: bandOf(facts, focus), score: Number((costOfDelay / sizePct).toFixed(2)), costOfDelay, sizePct };
}
