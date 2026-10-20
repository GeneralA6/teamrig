import { join } from 'node:path';
import { LiftLog } from "../budget/lift.js";
import { OUTSIDE_ID } from "../budget/measure.js";
import { addedSessionPct, liftedParts } from "../budget/parts.js";
import { PeriodStore } from "../budget/period.js";
import { readSnapshots, weekUseOf } from "../budget/snapshot.js";
import { UsageStore } from "../budget/store.js";
import { meteredOf, readWeek } from "../budget/week.js";
import { workWeights } from "../budget/work.js";
import { snapshotDirOf } from "./commands/budget.js";
/**
 * What a new hire would spend a day, as `check`'s SCALE-OUT prices a slice (src/hiring/scale-out.ts): its part of the
 * team's daily budget today (src/budget/parts.ts `addedSessionPct`), beside each session's share, queued work
 * (`tasks`) and lift in force. The week is read as a hook reads it: each session's use as last stored and the newest
 * status-line reading, no transcript measured. Undefined while the team's daily budget is unknown: no reading of the
 * week's use, or no W per percent (no `budget.weeklyLimitW`, and a meter that does not reach back to the week's start).
 */
export async function readHirePct(runtime, paths, config, tasks, now) {
    const { files } = runtime;
    const { budget, sessions } = config;
    const team = new UsageStore(files, paths.usage);
    const states = [];
    for (const id of sessions) {
        states.push((await team.load(id)).state);
    }
    states.push((await new UsageStore(files, join(paths.usage, 'outside')).load(OUTSIDE_ID)).state);
    const snapshots = await readSnapshots(files, snapshotDirOf(budget, paths));
    const statusUse = weekUseOf(snapshots, now);
    const period = await new PeriodStore(files, paths.period).periodAt(budget, statusUse, now, meteredOf(budget, states, now));
    const week = readWeek({ budget, now, statusUse, period, states });
    if (week.allowancePct === undefined) {
        return undefined;
    }
    const { lifts } = await new LiftLog(files, paths.lifts).read();
    const lifted = liftedParts(lifts, sessions, now, week.usedPct);
    return addedSessionPct(week.allowancePct, { ids: sessions, sessions: budget.sessions, work: workWeights(tasks, config.register.priorities), lifted });
}
