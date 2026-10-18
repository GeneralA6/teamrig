import { formatUtcMinute, MS_PER_HOUR } from '../core/time.ts';

/** The weekly token reset a blackout counts back from, and where its time came from (`status line`, `config`). */
export interface ResetTime {
  readonly at: number;
  readonly source: string;
}

/** Minutes after midnight of a valid `HH:MM`. */
function minuteOfDay(time: string): number {
  const [hours = 0, minutes = 0] = time.split(':').map(Number);
  return hours * 60 + minutes;
}

/**
 * Why no heavy step may start at `nowMs`, or undefined when one may: none starts from `cutoffUtc` (`HH:MM`) until
 * midnight UTC. Unset: no cutoff.
 */
export function heavyCutoffReason(nowMs: number, cutoffUtc: string | undefined): string | undefined {
  if (cutoffUtc === undefined) {
    return undefined;
  }
  const now = new Date(nowMs);
  const minute = now.getUTCHours() * 60 + now.getUTCMinutes();
  return minute >= minuteOfDay(cutoffUtc) ? `nothing heavy after ${cutoffUtc} UTC (now ${formatUtcMinute(now)})` : undefined;
}

/**
 * Why no deploy may start at `nowMs`, or undefined when one may: none starts from `hours` before the weekly token reset
 * until the reset, so nothing that may need a fix lands while the week has no budget left to fix it. Unset hours or
 * an unknown reset: no blackout.
 */
export function resetBlackoutReason(nowMs: number, reset: ResetTime | undefined, hours: number | undefined): string | undefined {
  if (reset === undefined || hours === undefined) {
    return undefined;
  }
  const from = reset.at - hours * MS_PER_HOUR;
  if (nowMs < from || nowMs >= reset.at) {
    return undefined;
  }
  return `deploy blackout before the weekly token reset: no deploy from ${formatUtcMinute(new Date(from))} until ${formatUtcMinute(new Date(reset.at))} UTC (reset from the ${reset.source})`;
}

/** A span as a short duration: `45m`, `2h30m`. */
export function minutesText(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours === 0 ? `${rest}m` : `${hours}h${String(rest).padStart(2, '0')}m`;
}
