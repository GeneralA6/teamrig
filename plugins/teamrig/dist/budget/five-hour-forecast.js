import { MS_PER_HOUR, MS_PER_MINUTE } from "../core/time.js";
import { formatPct } from "./format.js";
/**
 * The shortest stretch of a window's readings a rate is read from: two readings a minute apart would forecast a full
 * window from one point. The 11-04 wave read 30% 22 minutes into its window, a rate that fills one in 73 minutes, so a
 * rate read after 15 still sees it with about an hour left.
 */
export const FIVE_HOUR_RATE_SPAN_MS = 15 * MS_PER_MINUTE;
/** The window's course from its first reading to its highest; undefined under `FIVE_HOUR_RATE_SPAN_MS`, or once it is full. */
export function fiveHourForecast(fold) {
    const span = fold.at - fold.firstAt;
    if (span < FIVE_HOUR_RATE_SPAN_MS || fold.usedPct >= 100) {
        return undefined;
    }
    // Multiplied before divided, so a window landing on exactly 100% at its reset does not read as full by a rounding error.
    const rise = fold.usedPct - fold.firstPct;
    const endPct = fold.usedPct + (rise * (fold.resetsAt - fold.at)) / span;
    return { ptsPerHour: (rise * MS_PER_HOUR) / span, fullAt: endPct > 100 ? fold.at + ((100 - fold.usedPct) * span) / rise : undefined, endPct };
}
/** `teamrig budget`'s line on the window: its use and reset, then where its rise takes it once there is one to read. */
export function fiveHourLine(fold, zone) {
    const used = `Five-hour window: ${formatPct(fold.usedPct)} used at ${zone.clock(new Date(fold.at))}. Resets ${zone.clock(new Date(fold.resetsAt))}.`;
    const forecast = fiveHourForecast(fold);
    if (forecast === undefined) {
        return used;
    }
    const rise = `At its rise of ${forecast.ptsPerHour.toFixed(1)} points an hour`;
    return forecast.fullAt === undefined ? `${used} ${rise}, it ends near ${Math.round(forecast.endPct)}%.` : `${used} ${rise}, it reaches 100% ${zone.clock(new Date(forecast.fullAt))}.`;
}
