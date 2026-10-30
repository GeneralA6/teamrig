import { MS_PER_DAY, MS_PER_HOUR, MS_PER_MINUTE, utcMinuteOf } from "../core/time.js";
/** The part of `nowMs`'s UTC day when no queued step starts: from `cutoffUtc` (`HH:MM`, UTC) until midnight UTC. Unset: none. */
export function queueCutoffSpan(nowMs, cutoffUtc) {
    const cutoff = cutoffUtc === undefined ? undefined : utcMinuteOf(cutoffUtc);
    if (cutoff === undefined) {
        return undefined;
    }
    const dayStart = nowMs - (nowMs % MS_PER_DAY);
    return { from: dayStart + cutoff * MS_PER_MINUTE, to: dayStart + MS_PER_DAY };
}
/**
 * Why no queued step may start at `nowMs`, or undefined when one may: none starts from `cutoffUtc` (`HH:MM`, UTC) until
 * midnight UTC. Unset: no cutoff. The reason names the span and the time on `zone`'s clock.
 */
export function queueCutoffReason(nowMs, cutoffUtc, zone) {
    const span = queueCutoffSpan(nowMs, cutoffUtc);
    return span !== undefined && nowMs >= span.from ? `queue cutoff ${zone.clockSpan(new Date(span.from), new Date(span.to))} (now ${zone.clock(new Date(nowMs))})` : undefined;
}
/** When the blackout before `reset` starts: `hours` before it. */
export function blackoutStart(reset, hours) {
    return reset.at - hours * MS_PER_HOUR;
}
/**
 * Why no deploy may start at `nowMs`, or undefined when one may: none starts from `hours` before the weekly token reset
 * until the reset, so nothing that may need a fix lands while the week has no budget left to fix it. Unset hours or
 * an unknown reset: no blackout. The reason names both ends on `zone`'s clock.
 */
export function resetBlackoutReason(nowMs, reset, hours, zone) {
    if (reset === undefined || hours === undefined) {
        return undefined;
    }
    const from = blackoutStart(reset, hours);
    if (nowMs < from || nowMs >= reset.at) {
        return undefined;
    }
    return `deploy blackout before the weekly token reset: no deploy from ${zone.weekdayMinute(new Date(from))} until ${zone.weekdayMinute(new Date(reset.at))} (reset from the ${reset.source})`;
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
