import { numberField } from "../core/guards.js";
import { parseObject, toJsonlLine, VERSION_FIELD, writableObject } from "../core/jsonl.js";
import { MS_PER_HOUR, MS_PER_WEEK } from "../core/time.js";
import { resolveReset } from "./pace.js";
/**
 * The format of the period file this code reads and writes; a file in another format or damaged reads as none,
 * and one in a newer format refuses a write.
 */
export const PERIOD_FORMAT = 1;
/**
 * A drop in the week's use this large, its reset time unchanged, is a reset of the use inside the week: use only
 * grows otherwise, and two sessions' readings of one moment differ by less.
 */
export const RESET_DROP_PTS = 2;
/**
 * The metered W since a guessed start, in percent, at least this many times the status line's use and
 * `LATE_START_PTS` points over it, shows a reset after that start that no stored period saw. The W per percent
 * errs by far less: T370's recount of 10-14..10-17 summed 95.2% against the status line's 86%.
 */
export const LATE_START_RATIO = 1.5;
export const LATE_START_PTS = 10;
/**
 * An end seen more than half a week past the period's is the next week's: a reset moved by the plan, or a
 * configured one that is off from the plan's, moves by hours.
 */
const HALF_WEEK = MS_PER_WEEK / 2;
/** What the readers see at `now`; undefined while no reset is known (no status line reading and no `budget.reset`). */
export function sightOf(budget, use, now, metered) {
    const end = resolveReset(now, use?.resetsAt, budget.reset);
    if (end === undefined) {
        return undefined;
    }
    return metered === undefined ? { end, use } : { end, use, metered };
}
function opened(start, end, kind, use) {
    return { start, end, kind, lastPct: use?.usedPct ?? 0, lastAt: use?.at ?? start };
}
/**
 * The period after what is seen, from the one stored:
 * - none stored, an end before its start, or one over a week and a half past its end (weeks went unseen): the
 *   week before the end, a guess;
 * - an end over half a week past its end: the next week, from its end (case a);
 * - else it runs to the end now seen (the end can move, case d), a guessed start moving with it. A reading taken
 *   after its latest one and `RESET_DROP_PTS` or more below it opens a new budget (case b) from that latest
 *   reading, the earliest the use can have fallen: the use between counts in the new budget, so it errs high,
 *   never low. A reading that may predate the reset is left out (`mayPredateReset`). Any other reading taken after
 *   it becomes its latest.
 * A guessed period whose metered W is far over the status line's use starts where that W reaches it (`inferStart`).
 */
export function nextPeriod(stored, sight) {
    const next = movedOn(stored, sight);
    return next.kind === 'assumed' && sight.use !== undefined && sight.metered !== undefined ? inferStart(next, sight.use, sight.metered) : next;
}
/**
 * A guessed period, started instead at the latest hour from which the metered W reaches `use`, when its W since the
 * guessed start is `LATE_START_RATIO` times `use` and `LATE_START_PTS` points over it: the use was reset after that
 * start before any period was stored. W counted after the reading, or over-counted, puts the start later: a shorter
 * budget, so it errs tight, never loose.
 */
function inferStart(period, use, metered) {
    const sincePct = metered.wFrom(period.start) / metered.wPerPct;
    if (sincePct < use.usedPct * LATE_START_RATIO || sincePct - use.usedPct < LATE_START_PTS) {
        return period;
    }
    const target = use.usedPct * metered.wPerPct;
    // The W from the guessed start reaches the target; find the latest hour whose W still does.
    let reaches = 0;
    let last = Math.max(0, Math.floor((use.at - period.start) / MS_PER_HOUR));
    while (reaches < last) {
        const mid = Math.ceil((reaches + last) / 2);
        if (metered.wFrom(period.start + mid * MS_PER_HOUR) >= target) {
            reaches = mid;
        }
        else {
            last = mid - 1;
        }
    }
    return { ...period, start: period.start + reaches * MS_PER_HOUR, kind: 'inferred' };
}
/**
 * Whether `use`, far over a reset period's latest reading, may be the old week's use and no rise at all: a session
 * can show a reading long after it took it, so one last read before the period's latest reading may hold a reading
 * from before the reset. Taken as the latest, it would log a false point, and the next true reading would fall
 * from it and open a false second reset. Measured against `lastAt`, as a reset's start errs early. Only a reset
 * period needs this: a weekly reset moves `resetsAt`, which drops the old week's readings. A true rise left out
 * costs a delay: the session's next reading is taken after the latest one and counts.
 */
function mayPredateReset(period, use) {
    return period.kind === 'reset' && use.after !== undefined && use.after < period.lastAt && use.usedPct >= period.lastPct + RESET_DROP_PTS;
}
/** The stored period moved on to what `sight` shows, before any inference (`nextPeriod`). */
function movedOn(stored, sight) {
    const { end, use } = sight;
    if (stored === undefined || end <= stored.start || end > stored.end + MS_PER_WEEK + HALF_WEEK) {
        return opened(end - MS_PER_WEEK, end, 'assumed', use);
    }
    if (end > stored.end + HALF_WEEK) {
        return opened(stored.end, end, 'week', use);
    }
    const running = { ...stored, start: stored.kind === 'assumed' ? end - MS_PER_WEEK : stored.start, end };
    if (use === undefined || use.at < running.lastAt || mayPredateReset(running, use)) {
        return running;
    }
    if (use.usedPct <= running.lastPct - RESET_DROP_PTS) {
        return opened(Math.max(running.start, running.lastAt), end, 'reset', use);
    }
    return { ...running, lastPct: use.usedPct, lastAt: use.at };
}
const KINDS = ['assumed', 'week', 'reset', 'inferred'];
function isKind(value) {
    return KINDS.some((kind) => kind === value);
}
/** A period file's content; undefined when it is damaged or in another format, which starts the period over. */
export function parsePeriod(text) {
    const record = parseObject(text.trim());
    if (record === undefined || record[VERSION_FIELD] !== PERIOD_FORMAT) {
        return undefined;
    }
    const start = numberField(record, 'start');
    const end = numberField(record, 'end');
    const lastPct = numberField(record, 'lastPct');
    const lastAt = numberField(record, 'lastAt');
    const kind = record['kind'];
    if (start === undefined || end === undefined || lastPct === undefined || lastAt === undefined || !isKind(kind) || start >= end) {
        return undefined;
    }
    return { start, end, kind, lastPct, lastAt };
}
export function formatPeriod(period) {
    return toJsonlLine({ [VERSION_FIELD]: PERIOD_FORMAT, start: period.start, end: period.end, kind: period.kind, lastPct: period.lastPct, lastAt: period.lastAt });
}
function samePeriod(a, b) {
    return a !== undefined && a.start === b.start && a.end === b.end && a.kind === b.kind && a.lastPct === b.lastPct && a.lastAt === b.lastAt;
}
/**
 * The team's period file, which every reader of the week (the budget hooks, `budget`, a hire's price, the bursts)
 * moves on from what it sees and writes back only when it changed. Two readers that write at once saw nearly the
 * same snapshots: a reset one of them lost is seen again at the next read, from a reading before the fall.
 */
export class PeriodStore {
    files;
    path;
    constructor(files, path) {
        this.files = files;
        this.path = path;
    }
    async read() {
        const text = await this.files.read(this.path);
        return text === undefined ? undefined : parsePeriod(text);
    }
    /** The period after `sight`, written when it changed. A file a newer teamrig wrote is refused (`NewerDataError`), never overwritten. */
    async advance(sight) {
        return (await this.move(sight)).period;
    }
    /** `advance`, with the stored period it moved on from. */
    async move(sight) {
        const text = await this.files.read(this.path);
        writableObject(this.path, text, PERIOD_FORMAT);
        const stored = text === undefined ? undefined : parsePeriod(text);
        const next = nextPeriod(stored, sight);
        if (!samePeriod(stored, next)) {
            await this.files.write(this.path, formatPeriod(next));
        }
        return { before: stored, period: next };
    }
    /**
     * The period at `now` after the status line's `use` and the `metered` W (`sightOf`), written when it changed;
     * undefined while no reset is known.
     */
    async periodAt(budget, use, now, metered) {
        return (await this.moveAt(budget, use, now, metered))?.period;
    }
    /** `periodAt`, with the stored period it moved on from, whose latest use shows a percent passed since (budget/calibration.ts). */
    async moveAt(budget, use, now, metered) {
        const sight = sightOf(budget, use, now, metered);
        return sight === undefined ? undefined : this.move(sight);
    }
}
