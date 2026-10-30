import { numberField, stringField } from "../core/guards.js";
import { assertWritable, parseJsonl, toJsonlLine, VERSION_FIELD } from "../core/jsonl.js";
import { MS_PER_MINUTE, MS_PER_WEEK } from "../core/time.js";
/**
 * The week's W per percent, learned from the meter (T531). Each time the status line's week use passes a whole
 * percent, the account's meter log, `<state>/usage/meter-log.jsonl` of the team that keeps the account's week files
 * (`accountHolderOf`, budget/account.ts), gets one line: the use, the period and the W metered since its start. A fit of W per percent through 0 over the recent lines stands in for the configured
 * guess once they span `FIT_SPREAD_PTS` points. Each line also keeps the use the fit before it forecast for its W,
 * so the forecast's error shows week by week. Instants are stored as ISO strings, like the burst log.
 */
/** The format of the meter log's records; a newer one is skipped on read and refuses a write. */
export const METER_LOG_FORMAT = 1;
/** The points of the week the readings must span before their fit is used: a narrow spread fits noise. */
export const FIT_SPREAD_PTS = 10;
/** How long a reading counts in the fit; the log keeps up to a week more before a write drops the older lines. */
export const READINGS_KEPT_MS = 8 * MS_PER_WEEK;
/** How old a status line reading may be and still be logged: W metered after it would count in its line. */
export const FRESH_READING_MS = 10 * MS_PER_MINUTE;
/** Periods whose start was seen: a weekly reset, or one the use's fall showed. A guessed start would teach the fit its own guess. */
const SEEN_STARTS = ['week', 'reset'];
/**
 * The reading to log when the status line's use passed a whole percent since the period's previous reading:
 * the use then sits at that percent, not anywhere within it. Undefined for the first reading of a period, one in a
 * period with a guessed start, a stale one, one over 100% (extra usage, not the week's), or while the usage stores
 * do not reach the period's start.
 */
export function crossingOf(sight, fit) {
    const { before, period, use, covered, w, now } = sight;
    if (before === undefined || period === undefined || use === undefined || !covered || !SEEN_STARTS.includes(period.kind)) {
        return undefined;
    }
    const crossed = before.start === period.start && use.at > before.lastAt && Math.floor(use.usedPct) > Math.floor(before.lastPct);
    if (!crossed || now - use.at > FRESH_READING_MS || use.usedPct > 100) {
        return undefined;
    }
    return { at: use.at, usedPct: use.usedPct, start: period.start, end: period.end, w, forecastPct: fit === undefined ? undefined : w / fit.wPerPct };
}
function rms(misses) {
    return Math.sqrt(misses.reduce((sum, miss) => sum + miss * miss, 0) / misses.length);
}
/**
 * W per percent through 0 over `readings` (least squares of W on the use), with its misses in points; undefined
 * while they span fewer than `FIT_SPREAD_PTS` points.
 */
export function fitRate(readings) {
    const pcts = readings.map((reading) => reading.usedPct);
    if (pcts.length === 0 || Math.max(...pcts) - Math.min(...pcts) < FIT_SPREAD_PTS) {
        return undefined;
    }
    const wByPct = readings.reduce((sum, reading) => sum + reading.w * reading.usedPct, 0);
    const pctSquared = readings.reduce((sum, reading) => sum + reading.usedPct * reading.usedPct, 0);
    const wPerPct = wByPct / pctSquared;
    if (!(wPerPct > 0)) {
        return undefined;
    }
    return { wPerPct, errorPts: rms(readings.map((reading) => reading.w / wPerPct - reading.usedPct)), readings: readings.length };
}
/** The forecasts' misses in each period that had any, oldest first. */
export function periodForecasts(readings) {
    const missesByStart = new Map();
    for (const { start, forecastPct, usedPct } of readings) {
        if (forecastPct !== undefined) {
            missesByStart.set(start, [...(missesByStart.get(start) ?? []), forecastPct - usedPct]);
        }
    }
    return [...missesByStart.entries()].sort(([a], [b]) => a - b).map(([start, misses]) => ({ start, errorPts: rms(misses), readings: misses.length }));
}
export function calibrationOf(readings) {
    return { fit: fitRate(readings), periods: periodForecasts(readings) };
}
/** Every period's start: no use, no W. */
const PERIOD_START_POINT = { usedPct: 0, w: 0 };
/**
 * The week's use when `w` had been metered since the start of the period from `start`, read from its meter readings:
 * between the two around `w`, on the line through them, so a point inside a bracket a percent wide leans little on a
 * rate; past the last, that reading plus the W since it at `wPerPct`. The period's start reads 0% at 0 W. Readings are
 * found by W, not time: the W metered since an instant is read from the usage stores now, as theirs was then.
 */
export function useAtW(readings, start, w, wPerPct) {
    const at = Math.max(0, w);
    const points = [PERIOD_START_POINT, ...readings.filter((reading) => reading.start === start).sort((a, b) => a.w - b.w)];
    const before = points.filter((point) => point.w <= at).at(-1) ?? PERIOD_START_POINT;
    const next = points.find((point) => point.w > at);
    return next === undefined
        ? before.usedPct + (at - before.w) / wPerPct
        : before.usedPct + ((at - before.w) * (next.usedPct - before.usedPct)) / (next.w - before.w);
}
function iso(at) {
    return new Date(at).toISOString();
}
/** One reading as the log's JSON record. */
export function meterRecordOf(reading) {
    return {
        [VERSION_FIELD]: METER_LOG_FORMAT,
        at: iso(reading.at),
        usedPct: reading.usedPct,
        start: iso(reading.start),
        end: iso(reading.end),
        w: reading.w,
        ...(reading.forecastPct === undefined ? {} : { forecastPct: reading.forecastPct }),
    };
}
function instantOf(record, key) {
    const text = stringField(record, key);
    const at = text === undefined ? Number.NaN : Date.parse(text);
    return Number.isNaN(at) ? undefined : at;
}
/** One record as a reading; undefined when it is damaged. */
export function parseMeterRecord(record) {
    const at = instantOf(record, 'at');
    const usedPct = numberField(record, 'usedPct');
    const start = instantOf(record, 'start');
    const end = instantOf(record, 'end');
    const w = numberField(record, 'w');
    const forecastPct = numberField(record, 'forecastPct');
    if (at === undefined || usedPct === undefined || usedPct <= 0 || start === undefined || end === undefined || start >= end || w === undefined || w < 0) {
        return undefined;
    }
    if ('forecastPct' in record && forecastPct === undefined) {
        return undefined;
    }
    return { at, usedPct, start, end, w, forecastPct };
}
/** The team's append-only log of meter readings, oldest first. */
export class MeterLog {
    files;
    path;
    constructor(files, path) {
        this.files = files;
        this.path = path;
    }
    /**
     * The readings that count at `now`, oldest first. Damaged lines, lines from a newer teamrig and a second line for
     * a percent already read in its period (two readers that logged at once) are skipped.
     */
    async read(now) {
        const parse = parseJsonl((await this.files.read(this.path)) ?? '');
        const seen = new Set();
        const readings = [];
        for (const { record, version } of parse.records) {
            const reading = version === METER_LOG_FORMAT ? parseMeterRecord(record) : undefined;
            const key = reading === undefined ? '' : `${reading.start}:${Math.floor(reading.usedPct)}`;
            if (reading !== undefined && reading.at >= now - READINGS_KEPT_MS && !seen.has(key)) {
                seen.add(key);
                readings.push(reading);
            }
        }
        return readings;
    }
    /**
     * One whole line in one append; refused beside records from a newer teamrig. A log holding a line over a week
     * past `READINGS_KEPT_MS` is first rewritten to the lines still kept, so it stays a few hundred lines at most.
     */
    async append(reading, now) {
        const text = (await this.files.read(this.path)) ?? '';
        const parse = parseJsonl(text);
        assertWritable(this.path, parse, METER_LOG_FORMAT);
        const line = toJsonlLine(meterRecordOf(reading));
        const atOf = (record) => instantOf(record, 'at') ?? 0;
        if (parse.records.some(({ record }) => atOf(record) < now - READINGS_KEPT_MS - MS_PER_WEEK)) {
            const kept = parse.records.filter(({ record }) => atOf(record) >= now - READINGS_KEPT_MS);
            await this.files.write(this.path, `${kept.map(({ raw }) => `${raw}\n`).join('')}${line}`);
            return;
        }
        const separator = text === '' || text.endsWith('\n') ? '' : '\n';
        await this.files.append(this.path, `${separator}${line}`);
    }
}
