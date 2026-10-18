import type { QuietHours } from '../config/types.ts';
import { MS_PER_DAY, MS_PER_MINUTE, utcMinuteOf } from '../core/time.ts';

/**
 * How much of the team's work each stretch of time carries, for the pace line and the daily budget. The pace
 * counts active time, not clock time: a night the team sleeps through adds nothing to the line, so the evening
 * is not falsely ahead of it and the night's hours are not budgeted as if worked.
 */
export interface ActivityProfile {
  /** The weighted ms from `from` to `to`, each ms counted at its weight (0..1); 0 when `to` is not after `from`. */
  activeMs(from: number, to: number): number;
}

/** The weight of a quiet hour on the pace line when `budget.quietHours.paceWeight` is unset: the team sleeps. */
export const DEFAULT_QUIET_PACE_WEIGHT = 0;

/** One stretch of the UTC day, in ms since 00:00: [from, to). */
interface DayPiece {
  readonly from: number;
  readonly to: number;
  readonly weight: number;
}

/** The same weights every UTC day, as pieces that cover the day. Pure: the weighted time is a sum over whole days and one partial day. */
export class DailyProfile implements ActivityProfile {
  private readonly pieces: readonly DayPiece[];
  /** The weighted ms of one whole day. */
  private readonly perDay: number;

  private constructor(pieces: readonly DayPiece[]) {
    this.pieces = pieces;
    this.perDay = pieces.reduce((sum, piece) => sum + piece.weight * (piece.to - piece.from), 0);
  }

  /** Every minute alike: active time is clock time. */
  static even(): DailyProfile {
    return new DailyProfile([{ from: 0, to: MS_PER_DAY, weight: 1 }]);
  }

  /**
   * Weight 1 outside the quiet hours and their `paceWeight` (default DEFAULT_QUIET_PACE_WEIGHT) inside them; they
   * may cross midnight. No quiet hours, or a start equal to its end: even.
   */
  static ofQuietHours(quiet: QuietHours | undefined): DailyProfile {
    const start = quiet === undefined ? undefined : utcMinuteOf(quiet.startUtc);
    const end = quiet === undefined ? undefined : utcMinuteOf(quiet.endUtc);
    if (quiet === undefined || start === undefined || end === undefined || start === end) {
      return DailyProfile.even();
    }
    const weight = quiet.paceWeight ?? DEFAULT_QUIET_PACE_WEIGHT;
    const from = start * MS_PER_MINUTE;
    const to = end * MS_PER_MINUTE;
    return new DailyProfile(
      start < end
        ? [
            { from: 0, to: from, weight: 1 },
            { from, to, weight },
            { from: to, to: MS_PER_DAY, weight: 1 },
          ]
        : [
            { from: 0, to, weight },
            { from: to, to: from, weight: 1 },
            { from, to: MS_PER_DAY, weight },
          ],
    );
  }

  activeMs(from: number, to: number): number {
    return to <= from ? 0 : this.sinceEpoch(to) - this.sinceEpoch(from);
  }

  /** The weighted ms from the epoch to `at`. */
  private sinceEpoch(at: number): number {
    const day = Math.floor(at / MS_PER_DAY);
    const into = at - day * MS_PER_DAY;
    let sum = day * this.perDay;
    for (const piece of this.pieces) {
      sum += piece.weight * Math.min(Math.max(into - piece.from, 0), piece.to - piece.from);
    }
    return sum;
  }
}
