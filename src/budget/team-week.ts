import type { Files } from '../core/files.ts';
import type { TeamPaths } from '../core/home.ts';
import { calibrationOf, crossingOf, MeterLog } from './calibration.ts';
import { PeriodStore } from './period.ts';
import { meteredOf, rateOf, readWeek, wSince, type WeekInput, type WeekReading } from './week.ts';

/** The team paths the week now reads and writes. */
export type TeamWeekPaths = Pick<TeamPaths, 'period' | 'meterLog'>;

/**
 * The week now, read the one way every reader of it takes (the budget hooks, `teamrig budget`, a hire's price): the
 * meter log's fit (budget/calibration.ts), the team's period moved on from the status line's use and the W metered
 * at the fit's rate (budget/period.ts) and written when it changed, then the week read in it. A percent the status
 * line passed since the period's previous reading is logged, with the W metered for it, for the next fit.
 */
export async function teamWeekOf(files: Files, paths: TeamWeekPaths, input: Omit<WeekInput, 'period' | 'calibration'>): Promise<WeekReading> {
  const { budget, statusUse, states, now } = input;
  const log = new MeterLog(files, paths.meterLog);
  const calibration = calibrationOf(await log.read(now));
  const metered = meteredOf(rateOf(calibration, budget, undefined)?.wPerPct, states, now);
  const move = await new PeriodStore(files, paths.period).moveAt(budget, statusUse, now, metered);
  const period = move?.period;
  const week = readWeek({ ...input, period, calibration });
  const w = period === undefined ? 0 : wSince(states, period.start, now);
  const crossing = crossingOf({ before: move?.before, period, use: statusUse, covered: week.covered, w, now }, calibration.fit);
  if (crossing !== undefined) {
    await log.append(crossing, now);
  }
  return week;
}
