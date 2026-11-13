import { formatUtcDay, MS_PER_DAY } from '../core/time.ts';
import type { UsageState } from './store.ts';

/** Days of notification turns a wake's estimate averages over. */
export const MEASURED_DAYS = 7;
/** Fewest notification turns an average rests on; fewer is too thin to quote as what a wake costs. */
export const MIN_MEASURED_TURNS = 5;

/** What notification turns (a wake, a plugin message, a Stop hook) measurably cost: the whole turn's W, not its first call's. */
export interface MeasuredTurns {
  /** The average W of one notification turn. */
  readonly w: number;
  readonly turns: number;
}

/**
 * The average W of the notification turns in the stored usage of the last `MEASURED_DAYS` UTC days (today included),
 * the figure `teamrig budget --burn` shows. It reads only the per-day counters the meter already stores, never a
 * transcript, so the wake path can call it; undefined below `MIN_MEASURED_TURNS` turns.
 */
export function measuredTurns(states: readonly UsageState[], now: number): MeasuredTurns | undefined {
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
