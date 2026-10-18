import { formatUtcMinute, MS_PER_HOUR } from "../core/time.js";
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
/** When the blackout before `reset` starts: `hours` before it. */
export function blackoutStart(reset, hours) {
    return reset.at - hours * MS_PER_HOUR;
}
/**
 * Why no deploy may start at `nowMs`, or undefined when one may: none starts from `hours` before the weekly token reset
 * until the reset, so nothing that may need a fix lands while the week has no budget left to fix it. Unset hours or
 * an unknown reset: no blackout.
 */
export function resetBlackoutReason(nowMs, reset, hours) {
    if (reset === undefined || hours === undefined) {
        return undefined;
    }
    const from = blackoutStart(reset, hours);
    if (nowMs < from || nowMs >= reset.at) {
        return undefined;
    }
    return `deploy blackout before the weekly token reset: no deploy from ${formatUtcMinute(new Date(from))} until ${formatUtcMinute(new Date(reset.at))} UTC (reset from the ${reset.source})`;
}
const SPAN = /^(?:(\d{1,4})h)?(?:(\d{1,5})m)?$/;
/** A span written as minutes, hours or both, `45m`, `2h`, `1h30m`, as minutes; undefined for any other text or a span of none. */
export function parseSpanMinutes(text) {
    const match = SPAN.exec(text.trim());
    if (match === null || (match[1] === undefined && match[2] === undefined)) {
        return undefined;
    }
    const minutes = Number(match[1] ?? 0) * 60 + Number(match[2] ?? 0);
    return minutes > 0 ? minutes : undefined;
}
/** A span as a short duration: `45m`, `2h30m`. */
export function minutesText(minutes) {
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return hours === 0 ? `${rest}m` : `${hours}h${String(rest).padStart(2, '0')}m`;
}
