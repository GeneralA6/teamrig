import { BurstLog } from "../budget/burst-log.js";
import { weekWindow } from "../budget/pace.js";
import { PeriodStore } from "../budget/period.js";
import { accountWeekOn } from "./account-teams.js";
export async function readBursts(runtime, paths, budget, now) {
    const { records } = await new BurstLog(runtime.files, paths.bursts).read();
    const account = await accountWeekOn(runtime, budget, paths, now);
    const use = account.statusUse;
    const period = await new PeriodStore(runtime.files, account.paths.period).periodAt(budget, use, now);
    return { records, usedPct: use?.usedPct, window: period === undefined ? undefined : weekWindow(period.end, budget.paceEndHoursBeforeReset, period.start) };
}
