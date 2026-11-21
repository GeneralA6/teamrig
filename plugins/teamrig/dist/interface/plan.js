import { MS_PER_DAY, parseDeadline } from "../core/time.js";
import { taskNumber } from "../register/fold.js";
import { ACTIVE_STATUSES } from "../register/model.js";
import { planBand } from "../register/tree.js";
/** The `plan` document's body. */
export function planBody(input) {
    const { tree, now } = input;
    const tasks = [...input.tasks];
    const isActive = (task) => ACTIVE_STATUSES.includes(task.status);
    const asked = (task) => input.owner === null || task.owner === input.owner;
    const active = tree.inPlanOrder(tasks.filter(isActive));
    const turns = active.flatMap((task) => turnsOf(task, tree, input.turns)).filter((at) => at > now);
    return {
        at: new Date(now).toISOString(),
        validUntil: turns.length === 0 ? null : new Date(Math.min(...turns)).toISOString(),
        week: tree.week,
        tasks: active.filter(asked).map((task) => plannedTask(task, tree)),
        finished: tasks
            .filter((task) => !isActive(task) && asked(task))
            .sort((a, b) => taskNumber(a.id) - taskNumber(b.id))
            .map((task) => ({ id: task.id, workClass: rankedOf(tree.placeOf(task)).workClass })),
    };
}
function plannedTask(task, tree) {
    const place = tree.placeOf(task);
    const ranked = rankedOf(place);
    const move = tree.nextMove(task.id);
    return {
        id: task.id,
        parked: tree.isParked(task),
        pinned: place.pinned === true,
        band: planBand(ranked),
        ready: place.blocked !== true,
        score: ranked.score,
        started: place.started === true,
        due: servedDue(task.id, tree),
        unblocks: place.unblocks === undefined ? null : { first: place.unblocks.first, priority: place.unblocks.priority, count: place.unblocks.count },
        inWeek: place.inWeek === true,
        size: task.size,
        costOfDelay: ranked.costOfDelay,
        sizePct: ranked.sizePct,
        workClass: ranked.workClass,
        goal: ranked.goal === null ? null : { tag: ranked.goal.tag, rank: ranked.goal.rank },
        prep: ranked.prep,
        needs: tree.needs(task.id).map((id) => servedNeed(id, tree)),
        neededBy: tree.neededByOthers(task.id).map((needer) => ({ id: needer.id, owner: needer.owner, due: servedDue(needer.id, tree) })),
        next: move === undefined ? null : servedMove(move, tree),
    };
}
function servedDue(id, tree) {
    const due = tree.effectiveDue(id);
    return due === undefined ? null : { due: due.due, at: new Date(due.at).toISOString(), from: due.from };
}
/** A plan is a ranked read: a tree built with no ranking places nothing, so it is refused here, loudly, as a bug. */
function rankedOf(place) {
    if (place.ranked === undefined) {
        throw new Error('the plan document needs a tree built with its ranking');
    }
    return place.ranked;
}
function servedNeed(id, tree) {
    const own = tree.task(id);
    if (own !== undefined) {
        return { id, team: null, owner: own.owner, status: own.status };
    }
    const away = tree.elsewhereOf(id);
    return away === undefined ? { id, team: null, owner: null, status: null } : { id, team: away.team, owner: away.task.owner, status: away.task.status };
}
/** A move written out field by field, ids for tasks, so nothing a move's task holds is served by accident. */
function servedMove(move, tree) {
    switch (move.kind) {
        case 'elsewhere':
            return { kind: 'elsewhere', who: move.who, task: move.task.id, team: move.team, need: move.need.id };
        case 'time':
            return { kind: 'time', who: move.who, task: move.task.id, behind: move.behind?.id ?? null, at: parseDeadline(move.at, tree.zone)?.toISOString() ?? null };
        default:
            return { kind: move.kind, who: move.who, task: move.task.id, behind: move.behind?.id ?? null };
    }
}
/**
 * The moments one task's answers may turn at with no file moving: its effective due and the day that due comes near,
 * each time it waits until, and for an open task the day the park rule may take it. A moment that turns nothing only
 * costs a reader one early read.
 */
function turnsOf(task, tree, turns) {
    const due = tree.dueTime(task);
    const waits = task.waits.flatMap((reason) => (reason.kind === 'time' ? [parseDeadline(reason.at, tree.zone)?.getTime() ?? Number.NaN] : []));
    const park = task.status === 'open' ? [Date.parse(task.updatedAt) + turns.parkAfterDays * MS_PER_DAY] : [];
    return [...(due === undefined ? [] : [due, due - turns.dueSoonDays * MS_PER_DAY]), ...waits, ...park].filter((at) => Number.isFinite(at));
}
