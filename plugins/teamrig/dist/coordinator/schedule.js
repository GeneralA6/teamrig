import { formatUtcMinute } from "../core/time.js";
/** Minutes after midnight of a valid `HH:MM`. */
function minuteOfDay(time) {
    const [hours = 0, minutes = 0] = time.split(':').map(Number);
    return hours * 60 + minutes;
}
/**
 * Why no heavy step may start at `nowMs`, or undefined when one may: none starts from `cutoffUtc` (`HH:MM`) until
 * midnight UTC. Unset: no cutoff.
 */
export function heavyCutoffReason(nowMs, cutoffUtc) {
    if (cutoffUtc === undefined) {
        return undefined;
    }
    const now = new Date(nowMs);
    const minute = now.getUTCHours() * 60 + now.getUTCMinutes();
    return minute >= minuteOfDay(cutoffUtc) ? `nothing heavy after ${cutoffUtc} UTC (now ${formatUtcMinute(now)})` : undefined;
}
/** A span as a short duration: `45m`, `2h30m`. */
export function minutesText(minutes) {
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return hours === 0 ? `${rest}m` : `${hours}h${String(rest).padStart(2, '0')}m`;
}
