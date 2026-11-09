import { accountReadings, ACCOUNT_SCOPE, calibrationOf, crossingOf, MeterLog } from "./calibration.js";
import { ExtraLog, limitSpansOf, wAtFullOf } from "./extra.js";
import { PeriodStore } from "./period.js";
import { meteredOf, rateOf, readWeek, wSince } from "./week.js";
/**
 * The week now, read the one way every reader of it takes (the budget hooks, `teamrig budget`, a hire's price): the
 * account's lines of the meter log (`accountReadings`) and their fit (budget/calibration.ts), the account's period moved
 * on from the status line's use and the W metered at the fit's rate (budget/period.ts) and written when it changed,
 * then the week read in it with the extra-usage log (budget/extra.ts). `states` holds every usage store on the account:
 * the asking team's sessions, the use in no team and each other team's sessions, so every team reads one W per percent
 * (T1778). A percent the status line passed since the period's previous reading is logged once, as an account line with
 * that W, for the next fit: the period moved on, so no other team logs that percent. The stretches at the usage limit
 * come from the whole log, so a hook reads it once, and count the line just logged: the account stops at 100%, so the
 * hook that saw that crossing may be the last before the reset.
 */
export async function teamWeekOf(files, week, input) {
    const { budget, statusUse, states, now } = input;
    const log = new MeterLog(files, week.paths.meterLog);
    const logged = await log.read(now);
    const readings = accountReadings(logged, week.keeper);
    const calibration = calibrationOf(readings);
    const metered = meteredOf(rateOf(calibration, budget, undefined)?.wPerPct, states, now);
    const move = await new PeriodStore(files, week.paths.period).moveAt(budget, statusUse, now, metered);
    const period = move?.period;
    const entries = await new ExtraLog(files, week.paths.extraLog).read();
    const wAtFull = period === undefined ? undefined : wAtFullOf(readings, period.start);
    const reading = readWeek({ ...input, period, calibration, readings, extra: { entries, wAtFull } });
    const w = period === undefined ? 0 : wSince(states, period.start, now);
    const crossing = crossingOf({ before: move?.before, period, use: statusUse, covered: reading.covered, w, now }, calibration.fit);
    const lines = crossing === undefined ? [] : [{ ...crossing, scope: ACCOUNT_SCOPE }];
    await log.appendAll(lines, now);
    return { ...reading, limits: limitSpansOf([...logged, ...lines]) };
}
