import { fiveHourForecast } from "../budget/five-hour-forecast.js";
import { readFolderFiveHour } from "../budget/five-hour-summary.js";
import { formatPct } from "../budget/format.js";
/** The warning's flag line: where the window stands, how fast it rises once a rate can be read, and what 100% costs. */
function fiveHourText(fold, forecast, zone) {
    const clock = (at) => zone.clock(new Date(at));
    const rise = forecast === undefined ? '' : `, rising ${forecast.ptsPerHour.toFixed(1)} points an hour`;
    const full = forecast?.fullAt === undefined ? '' : `, full by ${clock(forecast.fullAt)}`;
    return `FIVE-HOUR the account's five-hour window read ${formatPct(fold.usedPct)} at ${clock(fold.at)}${rise}${full}; at 100% every session stalls until it resets ${clock(fold.resetsAt)}`;
}
/**
 * FIVE-HOUR (T1968), for `check`: at 100% of the account's five-hour window every session stalls until it resets, so a
 * window at `budget.fiveHourWarnPct`, or rising fast enough to fill before its reset, is a warning no session owns and
 * goes to the lead. Its key names the window, not the reading: the lead is told once a window, however the forecast
 * moves. With the budget off it reads nothing; a plan with no such window has no summary file, so it says nothing.
 */
export async function fiveHourWarnings(files, dir, budget, zone, now) {
    if (!budget.enabled) {
        return [];
    }
    const fold = await readFolderFiveHour(files, dir, now);
    if (fold === undefined) {
        return [];
    }
    const forecast = fiveHourForecast(fold);
    if (fold.usedPct < budget.fiveHourWarnPct && forecast?.fullAt === undefined) {
        return [];
    }
    return [{ key: `five-hour ${fold.resetsAt}`, source: 'the five-hour check [budget.fiveHourWarnPct]', text: fiveHourText(fold, forecast, zone) }];
}
