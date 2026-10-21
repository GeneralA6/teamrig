import { MS_PER_DAY } from "../core/time.js";
/** How `teamrig budget` writes its numbers: short, and the same everywhere. */
/**
 * Why a session past its part is held, the same in the hook line and in `teamrig budget`:
 * "the team has used 3.1% of the week today, at or past its in-day pace of 3.0%".
 */
export function noRoomText(day) {
    return `the team has used ${formatPct(day.usedPct)} of the week today, at or past its in-day pace of ${formatPct(day.pacePct)}`;
}
/** A share of the week: two decimals below 1%, else one, such as `0.25%` or `10.0%`. */
export function formatPct(value) {
    return `${value.toFixed(Math.abs(value) < 1 && value !== 0 ? 2 : 1)}%`;
}
/** Weighted tokens: `850k`, `7.50M`, `1.20B`. */
export function formatW(value) {
    if (value >= 1e9) {
        return `${(value / 1e9).toFixed(2)}B`;
    }
    if (value >= 1e6) {
        return `${(value / 1e6).toFixed(2)}M`;
    }
    return value >= 1e3 ? `${Math.round(value / 1e3)}k` : `${Math.round(value)}`;
}
/** A count with thousands separators, such as `2,634`. */
export function formatCount(value) {
    return Math.round(value).toLocaleString('en-US');
}
/**
 * When something ends, on the team's clock: `18:00 IDT`, and at a UTC midnight `03:00 IDT (the end of the budget
 * day)`: budget days are UTC days, so the day a lift lasts ends there.
 */
export function formatEndTime(at, zone) {
    const clock = zone.clock(new Date(at));
    return at % MS_PER_DAY === 0 ? `${clock} (the end of the budget day)` : clock;
}
