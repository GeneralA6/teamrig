import { MS_PER_DAY, MS_PER_MINUTE, utcMinuteOf } from "../core/time.js";
/** The weight of a quiet hour on the pace line when `budget.quietHours.paceWeight` is unset: the team sleeps. */
export const DEFAULT_QUIET_PACE_WEIGHT = 0;
/** The same weights every UTC day, as pieces that cover the day. Pure: the weighted time is a sum over whole days and one partial day. */
export class DailyProfile {
    pieces;
    /** The weighted ms of one whole day. */
    perDay;
    constructor(pieces) {
        this.pieces = pieces;
        this.perDay = pieces.reduce((sum, piece) => sum + piece.weight * (piece.to - piece.from), 0);
    }
    /** Every minute alike: active time is clock time. */
    static even() {
        return new DailyProfile([{ from: 0, to: MS_PER_DAY, weight: 1 }]);
    }
    /**
     * Weight 1 outside the quiet hours and their `paceWeight` (default DEFAULT_QUIET_PACE_WEIGHT) inside them; they
     * may cross midnight. No quiet hours, or a start equal to its end: even.
     */
    static ofQuietHours(quiet) {
        const start = quiet === undefined ? undefined : utcMinuteOf(quiet.startUtc);
        const end = quiet === undefined ? undefined : utcMinuteOf(quiet.endUtc);
        if (quiet === undefined || start === undefined || end === undefined || start === end) {
            return DailyProfile.even();
        }
        const weight = quiet.paceWeight ?? DEFAULT_QUIET_PACE_WEIGHT;
        const from = start * MS_PER_MINUTE;
        const to = end * MS_PER_MINUTE;
        return new DailyProfile(start < end
            ? [
                { from: 0, to: from, weight: 1 },
                { from, to, weight },
                { from: to, to: MS_PER_DAY, weight: 1 },
            ]
            : [
                { from: 0, to, weight },
                { from: to, to: from, weight: 1 },
                { from, to: MS_PER_DAY, weight },
            ]);
    }
    activeMs(from, to) {
        return to <= from ? 0 : this.sinceEpoch(to) - this.sinceEpoch(from);
    }
    /** The weighted ms from the epoch to `at`. */
    sinceEpoch(at) {
        const day = Math.floor(at / MS_PER_DAY);
        const into = at - day * MS_PER_DAY;
        let sum = day * this.perDay;
        for (const piece of this.pieces) {
            sum += piece.weight * Math.min(Math.max(into - piece.from, 0), piece.to - piece.from);
        }
        return sum;
    }
}
