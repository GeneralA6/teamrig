import { formatUtcDay, MS_PER_DAY } from "../core/time.js";
/** Days of notification turns a wake's estimate averages over. */
export const MEASURED_DAYS = 7;
/** Fewest notification turns an average rests on; fewer is too thin to quote as what a wake costs. */
export const MIN_MEASURED_TURNS = 5;
/**
 * The average W of the notification turns in the stored usage of the last `MEASURED_DAYS` UTC days (today included),
 * the figure `teamrig budget --burn` shows. It reads only the per-day counters the meter already stores, never a
 * transcript, so the wake path can call it; undefined below `MIN_MEASURED_TURNS` turns.
 */
export function measuredTurns(states, now) {
    const days = Array.from({ length: MEASURED_DAYS }, (_, back) => formatUtcDay(new Date(now - back * MS_PER_DAY)));
    let turns = 0;
    let w = 0;
    for (const state of states) {
        for (const day of days) {
            const patterns = state.byDay[day]?.patterns;
            turns += patterns?.notificationTurns ?? 0;
            w += patterns?.notificationW ?? 0;
        }
    }
    return turns < MIN_MEASURED_TURNS ? undefined : { w: w / turns, turns };
}
