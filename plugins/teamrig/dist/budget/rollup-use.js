function newClassTally() {
    return { planned: { w: 0, seconds: 0 }, unplanned: { w: 0, seconds: 0 } };
}
function add(tally, use) {
    tally.w += use.w;
    tally.seconds += use.seconds;
}
function sum(uses) {
    const total = { w: 0, seconds: 0 };
    uses.forEach((use) => add(total, use));
    return total;
}
function percentOf(part, whole) {
    return whole === 0 ? null : (part / whole) * 100;
}
/**
 * The rollup's task rows split by plan and class (T2091, T2076's 3A). Only `tasks` rows are read: they hold task work
 * alone, so coordination stays the rollup's own class and out of every share here, and a share is of the W with a task.
 */
export function planUse({ days, placeOf, focus, session }) {
    const byClass = new Map(focus.classes.map((workClass) => [workClass, newClassTally()]));
    const noTask = { w: 0, seconds: 0 };
    for (const { day, team, tasks } of days) {
        for (const row of tasks) {
            if (session !== undefined && (team !== session.team || row.session !== session.session)) {
                continue;
            }
            if (row.task === null) {
                add(noTask, row);
                continue;
            }
            const { workClass, planned } = placeOf(team, day, row.task);
            const tally = byClass.get(workClass) ?? newClassTally();
            byClass.set(workClass, tally);
            add(planned ? tally.planned : tally.unplanned, row);
        }
    }
    const tallies = [...byClass.values()];
    const planned = sum(tallies.map((tally) => tally.planned));
    const unplanned = sum(tallies.map((tally) => tally.unplanned));
    const taskW = planned.w + unplanned.w;
    const others = [...byClass.keys()].filter((workClass) => !focus.classes.includes(workClass)).sort();
    const classes = [...focus.classes, ...others].flatMap((workClass) => {
        const tally = byClass.get(workClass);
        return tally === undefined ? [] : [{ workClass, ...tally, sharePct: percentOf(tally.planned.w + tally.unplanned.w, taskW), targetPct: focus.allocation[workClass] ?? null }];
    });
    return { planned, unplanned, noTask, coveragePct: percentOf(planned.w, taskW), targetPct: focus.plannedTargetPct, classes };
}
