import type { KitConfig } from '../config/types.ts';
import type { TimeZone } from '../core/zone.ts';
import type { Rush } from './burst.ts';
import { formatPct } from './format.ts';

/**
 * A rush (T2810): while one is in force the team's config reads with every budget hold turned to report only, so the
 * team works its goal at full speed. The overlay changes the config as read (`openKit`), never the file, so a rush
 * ends by its end record, its time or its stop % with nothing to restore. Queue cutoffs, CPU gates, owner gates and
 * the stop % are not budget holds: they stay.
 * Pure.
 */

/**
 * The config as a rush reads it: the over-budget action and quiet hours' action warn, no session is paused by
 * priority, and the WIP rule warns (left off when the team turned it off).
 */
export function rushOverlay(config: KitConfig): KitConfig {
  const { budget, focus } = config;
  return {
    ...config,
    budget: {
      ...budget,
      overAction: 'warn',
      pauseByPriority: false,
      ...(budget.quietHours === undefined ? {} : { quietHours: { ...budget.quietHours, action: 'warn' } }),
    },
    focus: { ...focus, wip: { ...focus.wip, mode: focus.wip.mode === 'off' ? 'off' : 'warn' } },
  };
}

/** The status line's segment: "RUSH PROD to Fri 11-20 18:00 IST". */
export function rushSegment(rush: Rush, zone: TimeZone): string {
  return `RUSH ${rush.goal} to ${zone.weekdayMinute(new Date(rush.endsAt))}`;
}

/** The report's line: the goal, its end and stop %, and that the holds only report while it runs. */
export function rushLine(rush: Rush, zone: TimeZone): string {
  return (
    `RUSH goal ${rush.goal} until ${zone.weekdayMinute(new Date(rush.endsAt))} or ${formatPct(rush.stopPct)} of the week: ` +
    "the budget's holds only report; queue cutoffs, CPU gates and owner gates still hold"
  );
}
