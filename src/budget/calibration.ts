import type { Files } from '../core/files.ts';
import { numberField, stringField, type JsonRecord } from '../core/guards.ts';
import { assertWritable, parseJsonl, toJsonlLine, VERSION_FIELD } from '../core/jsonl.ts';
import { MS_PER_MINUTE, MS_PER_WEEK } from '../core/time.ts';
import type { Period, PeriodKind } from './period.ts';
import type { WeekUse } from './snapshot.ts';

/**
 * The week's W per percent, learned from the meter (T531). Each time the status line's week use passes a whole
 * percent, the account's meter log, `<state>/usage/meter-log.jsonl` of the team that keeps the account's week files
 * (`accountHolderOf`, budget/account.ts), gets one line for each team keeping its week there: the use, the period, the
 * W that team's usage stores metered since its start, and the team. Each team sums the W from its own stores, so the
 * teams' W differ, and each reads only its own lines (`readingsOfTeam`, T1669). A fit of W per percent through 0 over
 * a team's newest period that spans `FIT_SPREAD_PTS` points (`fitRate`) stands in for the configured guess. Each line
 * also keeps the use the fit before it forecast for its W, so the forecast's error shows week by week. Instants are
 * stored as ISO strings, like the burst log.
 */

/**
 * The format of the meter log's records; a newer one is skipped on read and refuses a write. The optional `team`
 * (T1669) left it at 1, so a tab still on an older teamrig keeps logging instead of refusing the log: that teamrig
 * reads a tagged line as before, ignoring the field, and its prune keeps each kept line's text whole, so it drops no
 * `team`; its untagged lines count only where `readingsOfTeam` says.
 */
export const METER_LOG_FORMAT = 1;
/** The points of the week the readings must span before their fit is used: a narrow spread fits noise. */
export const FIT_SPREAD_PTS = 10;
/**
 * How high the newest period's use must read before its own rate can overrule an older period's fit (`fitRate`): a
 * first reading alone is too noisy, at 0.00 to 0.66 of its period's final rate on the four teams of the 11-04 week.
 */
export const MOVED_RATE_MIN_PCT = 2;
/**
 * The newest period's own W per percent over an older period's fit, at or past which the limit moved (`fitRate`). The
 * two are lopsided because W lags the status line, so an early rate reads low: at 2 and 3 points the 11-04 week's own
 * rates read 0.61 to 1.18 of their period's final one. The moves seen, about 2.5x up (T2019) and 0.43x down (T1985), pass.
 */
export const MOVED_RATE_UP = 1.5;
export const MOVED_RATE_DOWN = 0.5;
/** How long a reading counts in the fit; the log keeps up to a week more before a write drops the older lines. */
export const READINGS_KEPT_MS = 8 * MS_PER_WEEK;
/** How old a status line reading may be and still be logged: W metered after it would count in its line. */
export const FRESH_READING_MS = 10 * MS_PER_MINUTE;

/** Periods whose start was seen: a weekly reset, or one the use's fall showed. A guessed start would teach the fit its own guess. */
const SEEN_STARTS: readonly PeriodKind[] = ['week', 'reset'];

/** One meter reading: the use just past a whole percent and the W metered for it. */
export interface MeterReading {
  /** When the status line read the use. */
  readonly at: number;
  readonly usedPct: number;
  /** The period the use counts in. */
  readonly start: number;
  readonly end: number;
  /** Everyone's W metered from the period's start to the reading, as one team's usage stores sum it. */
  readonly w: number;
  /** The use the fit before this reading gave for `w`; undefined while there was none. */
  readonly forecastPct: number | undefined;
}

/** A line of the meter log: a reading and the team whose usage stores metered its W, unset on a line logged before T1669. */
export interface LoggedReading extends MeterReading {
  readonly team?: string;
}

/** Whose readings a reader of the meter log takes (`readingsOfTeam`). */
export interface LogScale {
  /** The team reading the log, whose own lines carry its id. */
  readonly team: string;
  /** The team keeping the log (`accountHolderOf`, budget/account.ts). */
  readonly keeper: string;
}

/**
 * The readings on one team's W scale (T1669): only the lines its own usage stores metered, which carry its id. A line
 * with no team was logged before the lines named one: it counts for the team keeping the log, whose scale the log was
 * on, but not in a period that has a line naming a team, where the teams on the account logged untagged lines in turn.
 */
export function readingsOfTeam(logged: readonly LoggedReading[], scale: LogScale): readonly LoggedReading[] {
  const tagged = new Set(logged.filter((reading) => reading.team !== undefined).map((reading) => reading.start));
  const ownUntagged = scale.team === scale.keeper;
  return logged.filter((reading) => (reading.team === undefined ? ownUntagged && !tagged.has(reading.start) : reading.team === scale.team));
}

/** W per percent of the week fitted through 0, and how far the fit misses its own readings. */
export interface RateFit {
  readonly wPerPct: number;
  /** The root mean square of the misses, in points of the week. */
  readonly errorPts: number;
  readonly readings: number;
}

/** How far the forecasts made in one period missed the meter. */
export interface PeriodForecast {
  /** The period's start. */
  readonly start: number;
  /** The root mean square of the misses, in points of the week. */
  readonly errorPts: number;
  readonly readings: number;
}

/** The learned rate and the forecasts' error in each period, oldest first. */
export interface Calibration {
  readonly fit: RateFit | undefined;
  readonly periods: readonly PeriodForecast[];
}
/** What one read of the week saw, for `crossingOf`. */
export interface ReadingSight {
  /** The stored period before this read moved it on (budget/period.ts), and after. */
  readonly before: Period | undefined;
  readonly period: Period | undefined;
  readonly use: WeekUse | undefined;
  /** Whether the usage stores reach back to the period's start (`WeekReading.covered`). */
  readonly covered: boolean;
  /** Everyone's W metered since the period's start. */
  readonly w: number;
  readonly now: number;
}

/**
 * The reading to log when the status line's use passed a whole percent since the period's previous reading:
 * the use then sits at that percent, not anywhere within it. Undefined for the first reading of a period, one the
 * period left out (`nextPeriod`), one in a period with a guessed start, a stale one, one over 100% (extra usage, not
 * the week's), or while the usage stores do not reach the period's start.
 */
export function crossingOf(sight: ReadingSight, fit: RateFit | undefined): MeterReading | undefined {
  const { before, period, use, covered, w, now } = sight;
  if (before === undefined || period === undefined || use === undefined || !covered || !SEEN_STARTS.includes(period.kind)) {
    return undefined;
  }
  const taken = before.start === period.start && use.at > before.lastAt && period.lastPct === use.usedPct;
  const crossed = taken && Math.floor(use.usedPct) > Math.floor(before.lastPct);
  if (!crossed || now - use.at > FRESH_READING_MS || use.usedPct > 100) {
    return undefined;
  }
  return { at: use.at, usedPct: use.usedPct, start: period.start, end: period.end, w, forecastPct: fit === undefined ? undefined : w / fit.wPerPct };
}

function rms(misses: readonly number[]): number {
  return Math.sqrt(misses.reduce((sum, miss) => sum + miss * miss, 0) / misses.length);
}

/** W per percent through 0 over `readings` (least squares of W on the use), with its misses in points; undefined with no W. */
function slopeOver(readings: readonly MeterReading[]): RateFit | undefined {
  const wByPct = readings.reduce((sum, reading) => sum + reading.w * reading.usedPct, 0);
  const pctSquared = readings.reduce((sum, reading) => sum + reading.usedPct * reading.usedPct, 0);
  const wPerPct = wByPct / pctSquared;
  if (!(wPerPct > 0)) {
    return undefined;
  }
  return { wPerPct, errorPts: rms(readings.map((reading) => reading.w / wPerPct - reading.usedPct)), readings: readings.length };
}

/** `slopeOver`, undefined while the readings span fewer than `FIT_SPREAD_PTS` points. */
function fitOver(readings: readonly MeterReading[]): RateFit | undefined {
  const pcts = readings.map((reading) => reading.usedPct);
  return pcts.length === 0 || Math.max(...pcts) - Math.min(...pcts) < FIT_SPREAD_PTS ? undefined : slopeOver(readings);
}

/** The period's own rate once it shows the limit moved from `older` (`MOVED_RATE_UP`, `MOVED_RATE_DOWN`); else undefined. */
function movedRate(period: readonly MeterReading[], older: RateFit): RateFit | undefined {
  const own = period.some((reading) => reading.usedPct >= MOVED_RATE_MIN_PCT) ? slopeOver(period) : undefined;
  if (own === undefined) {
    return undefined;
  }
  const ratio = own.wPerPct / older.wPerPct;
  return ratio >= MOVED_RATE_UP || ratio <= MOVED_RATE_DOWN ? own : undefined;
}

/**
 * The week's W per percent from `readings`: the fit of the newest period that spans `FIT_SPREAD_PTS` points alone,
 * else of them all, for a team too quiet for any period to. A period stands alone because the account's limit can move
 * at a reset, and a fit across periods averages the move away for as long as the old lines count: a week point fell
 * from 9.1M to 3.9M W at one reset while the fit stayed at 9.1M, so every session read 2.3x under its real use (T1985).
 * The newest period overrules an older fit sooner once its own rate shows the limit moved (`movedRate`): waiting for
 * the spread left a plan raised inside a week priced at the old rate for its first 10 points, about 90M W (T2019).
 */
export function fitRate(readings: readonly MeterReading[]): RateFit | undefined {
  const newestFirst = [...new Set(readings.map((reading) => reading.start))].sort((a, b) => b - a);
  const periods = newestFirst.map((start) => readings.filter((reading) => reading.start === start));
  const fits = periods.map((period) => fitOver(period));
  const fit = fits.find((found) => found !== undefined) ?? fitOver(readings);
  const [newest] = periods;
  return newest === undefined || fit === undefined || fits[0] !== undefined ? fit : (movedRate(newest, fit) ?? fit);
}

/** The forecasts' misses in each period that had any, oldest first. */
export function periodForecasts(readings: readonly MeterReading[]): readonly PeriodForecast[] {
  const missesByStart = new Map<number, number[]>();
  for (const { start, forecastPct, usedPct } of readings) {
    if (forecastPct !== undefined) {
      missesByStart.set(start, [...(missesByStart.get(start) ?? []), forecastPct - usedPct]);
    }
  }
  return [...missesByStart.entries()].sort(([a], [b]) => a - b).map(([start, misses]) => ({ start, errorPts: rms(misses), readings: misses.length }));
}

export function calibrationOf(readings: readonly MeterReading[]): Calibration {
  return { fit: fitRate(readings), periods: periodForecasts(readings) };
}

/** A point of a period's use: the status line's percent and the W metered since the period's start. */
type UsePoint = Pick<MeterReading, 'usedPct' | 'w'>;

/** Every period's start: no use, no W. */
const PERIOD_START_POINT: UsePoint = { usedPct: 0, w: 0 };

/**
 * The week's use when `w` had been metered since the start of the period from `start`, read from its meter readings:
 * between the two around `w`, on the line through them, so a point inside a bracket a percent wide leans little on a
 * rate; past the last, that reading plus the W since it at `wPerPct`. The period's start reads 0% at 0 W. Readings are
 * found by W, not time: the W metered since an instant is read from the usage stores now, as theirs was then.
 */
export function useAtW(readings: readonly MeterReading[], start: number, w: number, wPerPct: number): number {
  const at = Math.max(0, w);
  const points = [PERIOD_START_POINT, ...readings.filter((reading) => reading.start === start).sort((a, b) => a.w - b.w)];
  const before = points.filter((point) => point.w <= at).at(-1) ?? PERIOD_START_POINT;
  const next = points.find((point) => point.w > at);
  return next === undefined
    ? before.usedPct + (at - before.w) / wPerPct
    : before.usedPct + ((at - before.w) * (next.usedPct - before.usedPct)) / (next.w - before.w);
}

function iso(at: number): string {
  return new Date(at).toISOString();
}

/** One reading as the log's JSON record. */
export function meterRecordOf(reading: LoggedReading): JsonRecord {
  return {
    [VERSION_FIELD]: METER_LOG_FORMAT,
    at: iso(reading.at),
    usedPct: reading.usedPct,
    start: iso(reading.start),
    end: iso(reading.end),
    w: reading.w,
    ...(reading.forecastPct === undefined ? {} : { forecastPct: reading.forecastPct }),
    ...(reading.team === undefined ? {} : { team: reading.team }),
  };
}

function instantOf(record: JsonRecord, key: string): number | undefined {
  const text = stringField(record, key);
  const at = text === undefined ? Number.NaN : Date.parse(text);
  return Number.isNaN(at) ? undefined : at;
}

/** One record as a reading; undefined when it is damaged. */
export function parseMeterRecord(record: JsonRecord): LoggedReading | undefined {
  const at = instantOf(record, 'at');
  const usedPct = numberField(record, 'usedPct');
  const start = instantOf(record, 'start');
  const end = instantOf(record, 'end');
  const w = numberField(record, 'w');
  const forecastPct = numberField(record, 'forecastPct');
  const team = stringField(record, 'team');
  if (at === undefined || usedPct === undefined || usedPct <= 0 || start === undefined || end === undefined || start >= end || w === undefined || w < 0) {
    return undefined;
  }
  if (('forecastPct' in record && forecastPct === undefined) || ('team' in record && (team === undefined || team === ''))) {
    return undefined;
  }
  return { at, usedPct, start, end, w, forecastPct, ...(team === undefined ? {} : { team }) };
}

/** The account's append-only log of meter readings, oldest first. */
export class MeterLog {
  private readonly files: Files;
  readonly path: string;

  constructor(files: Files, path: string) {
    this.files = files;
    this.path = path;
  }

  /**
   * The readings that count at `now`, every team's, oldest first (`readingsOfTeam` takes one team's). Damaged lines,
   * lines from a newer teamrig and a second line of one team for a percent already read in its period (two readers
   * that logged at once) are skipped.
   */
  async read(now: number): Promise<readonly LoggedReading[]> {
    const parse = parseJsonl((await this.files.read(this.path)) ?? '');
    const seen = new Set<string>();
    const readings: LoggedReading[] = [];
    for (const { record, version } of parse.records) {
      const reading = version === METER_LOG_FORMAT ? parseMeterRecord(record) : undefined;
      const key = reading === undefined ? '' : `${reading.team ?? ''}:${reading.start}:${Math.floor(reading.usedPct)}`;
      if (reading !== undefined && reading.at >= now - READINGS_KEPT_MS && !seen.has(key)) {
        seen.add(key);
        readings.push(reading);
      }
    }
    return readings;
  }

  /** One reading's line (`appendAll`). */
  async append(reading: LoggedReading, now: number): Promise<void> {
    await this.appendAll([reading], now);
  }

  /**
   * Whole lines, one per reading, in one append; refused beside records from a newer teamrig. A log holding a line
   * over a week past `READINGS_KEPT_MS` is first rewritten to the lines still kept, so it stays a few hundred lines at
   * most.
   */
  async appendAll(readings: readonly LoggedReading[], now: number): Promise<void> {
    if (readings.length === 0) {
      return;
    }
    const text = (await this.files.read(this.path)) ?? '';
    const parse = parseJsonl(text);
    assertWritable(this.path, parse, METER_LOG_FORMAT);
    const lines = readings.map((reading) => toJsonlLine(meterRecordOf(reading))).join('');
    const atOf = (record: JsonRecord): number => instantOf(record, 'at') ?? 0;
    if (parse.records.some(({ record }) => atOf(record) < now - READINGS_KEPT_MS - MS_PER_WEEK)) {
      const kept = parse.records.filter(({ record }) => atOf(record) >= now - READINGS_KEPT_MS);
      await this.files.write(this.path, `${kept.map(({ raw }) => `${raw}\n`).join('')}${lines}`);
      return;
    }
    const separator = text === '' || text.endsWith('\n') ? '' : '\n';
    await this.files.append(this.path, `${separator}${lines}`);
  }
}
