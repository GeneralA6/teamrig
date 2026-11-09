import type { Files } from '../core/files.ts';
import { numberField, stringField, type JsonRecord } from '../core/guards.ts';
import { assertWritable, parseJsonl, toJsonlLine, VERSION_FIELD } from '../core/jsonl.ts';
import type { LimitSpan } from '../register/stats.ts';
import type { MeterReading } from './calibration.ts';

/**
 * The extra-usage pool (T531 case c): dollars the user adds once the week reads 100%, a pool apart from the week,
 * spent on purpose and never read as a new week. `teamrig budget extra` appends one line to the account's extra log,
 * `<state>/usage/extra-log.jsonl` of the team that keeps the account's week files (`accountHolderOf`): an `add` of dollars to the pool, or a `spent` reading of the dollars claude.ai
 * shows spent from it so far, each with the week's use and the W metered since the period's start. Successive spent
 * readings of one period past 100% teach the pool's W per dollar; until a pair exists a configured rate stands in,
 * else the pool is known in dollars only. Instants are stored as ISO strings, like the meter log.
 */

/** The format of the extra log's records; a newer one is skipped on read and refuses a write. */
export const EXTRA_LOG_FORMAT = 1;
/** The week's use from which metered W comes out of the pool instead of the week. */
export const FULL_PCT = 100;

/** An `add` puts dollars in the pool; a `spent` reading gives the dollars spent from it so far. */
export type ExtraKind = 'add' | 'spent';
const KINDS: readonly ExtraKind[] = ['add', 'spent'];

/** One line of the extra log. */
export interface ExtraEntry {
  readonly at: number;
  readonly kind: ExtraKind;
  /** An add: the dollars added. A spent reading: the dollars spent from the pool so far, as claude.ai shows them. */
  readonly usd: number;
  /** The week's use on the status line at the entry; undefined without a fresh reading. */
  readonly weekPct: number | undefined;
  /** The period the entry was made in. */
  readonly start: number;
  readonly end: number;
  /** Everyone's W metered from the period's start to the entry. */
  readonly w: number;
}

/** The pool's W per dollar fitted through 0, and how many pairs of spent readings taught it. */
export interface UsdRate {
  readonly wPerUsd: number;
  readonly pairs: number;
}

/** What the pool is read against now. */
export interface PoolSight {
  /** The current period's start, and everyone's W metered from it to now. */
  readonly start: number;
  readonly w: number;
  /** The week's use now. */
  readonly usedPct: number;
  /** The W metered from the period's start to its 100% crossing (the meter log's 100% line); undefined when unseen. */
  readonly wAtFull: number | undefined;
  /** The configured W per dollar (`budget.extraWPerUsd`), standing in until spent readings teach one. */
  readonly configuredWPerUsd: number | undefined;
}

/** The pool now. */
export interface ExtraPool {
  readonly addedUsd: number;
  /** The last spent reading, plus the W metered past 100% since it at the pool's rate. */
  readonly spentUsd: number;
  readonly leftUsd: number;
  /** Learned from spent readings, else configured; undefined while neither is known. */
  readonly wPerUsd: number | undefined;
  readonly learned: boolean;
  /** The W the pool still holds; undefined without a rate. */
  readonly leftW: number | undefined;
}

/**
 * At or past 100% of the week, what sets the team's allowance today (week.ts `teamAllowancePct`): the W the pool still
 * holds (`pool`), else nothing: dollars left with no W per dollar known yet (`unpriced`), or no dollars left or none
 * added (`empty`).
 */
export type PastLimit = 'pool' | 'unpriced' | 'empty';

/** What sets the team's allowance past the weekly limit; undefined below 100%, where the week's remainder sets it. */
export function pastLimitOf(usedPct: number, pool: ExtraPool | undefined): PastLimit | undefined {
  if (usedPct < FULL_PCT) {
    return undefined;
  }
  const leftW = pool?.leftW;
  if (leftW !== undefined && leftW > 0) {
    return 'pool';
  }
  return pool !== undefined && pool.leftUsd > 0 && pool.wPerUsd === undefined ? 'unpriced' : 'empty';
}

function isKind(text: string | undefined): text is ExtraKind {
  return KINDS.some((kind) => kind === text);
}

function byTime(a: ExtraEntry, b: ExtraEntry): number {
  return a.at - b.at;
}

function spentReadings(entries: readonly ExtraEntry[]): readonly ExtraEntry[] {
  return entries.filter((entry) => entry.kind === 'spent').sort(byTime);
}

/**
 * W per dollar through 0 over successive spent readings of one period, both made at or past 100% (least squares of
 * the W metered between them on the dollars spent between them); undefined with no such pair. All W metered while
 * the week reads 100% comes out of the pool, so each pair prices the pool's dollar.
 */
export function fitWPerUsd(entries: readonly ExtraEntry[]): UsdRate | undefined {
  const full = spentReadings(entries).filter((entry) => (entry.weekPct ?? 0) >= FULL_PCT);
  const steps = full.flatMap((entry, index) => {
    const before = index === 0 ? undefined : full[index - 1];
    if (before === undefined || before.start !== entry.start) {
      return [];
    }
    const usd = entry.usd - before.usd;
    const w = entry.w - before.w;
    return usd > 0 && w >= 0 ? [{ usd, w }] : [];
  });
  if (steps.length === 0) {
    return undefined;
  }
  const wByUsd = steps.reduce((sum, step) => sum + step.w * step.usd, 0);
  const usdSquared = steps.reduce((sum, step) => sum + step.usd * step.usd, 0);
  const wPerUsd = wByUsd / usdSquared;
  return wPerUsd > 0 ? { wPerUsd, pairs: steps.length } : undefined;
}

/** The newest spent reading of the log; undefined with none. */
export function lastSpentOf(entries: readonly ExtraEntry[]): ExtraEntry | undefined {
  const spent = spentReadings(entries);
  return spent[spent.length - 1];
}

/**
 * The dollars the spent readings (oldest first) show spent from the pool so far. claude.ai's extra-usage counter restarts each month
 * while the dollars put in the pool stay, so a reading below the one before starts a new count: each count's last
 * reading adds to the total, the current count's last reading included (T997). Dollars spent between a count's last
 * reading and its restart show in no reading, so they are not counted.
 */
export function spentUsdOf(spent: readonly ExtraEntry[]): number {
  const counts = spent.reduce(
    (sum, entry) => (entry.usd < sum.current ? { closed: sum.closed + sum.current, current: entry.usd } : { closed: sum.closed, current: entry.usd }),
    { closed: 0, current: 0 },
  );
  return counts.closed + counts.current;
}

/**
 * The pool at `sight`; undefined while nothing was added. Dollars spent since the last spent reading count only while
 * the week reads 100% or more, from the later of that reading (when it is of this period) and the period's 100%
 * crossing; without either, or without a rate, the readings' dollars (`spentUsdOf`) stand.
 */
export function poolOf(entries: readonly ExtraEntry[], sight: PoolSight): ExtraPool | undefined {
  const addedUsd = entries.reduce((sum, entry) => (entry.kind === 'add' ? sum + entry.usd : sum), 0);
  if (addedUsd <= 0) {
    return undefined;
  }
  const rate = fitWPerUsd(entries);
  const wPerUsd = rate?.wPerUsd ?? sight.configuredWPerUsd;
  const spent = spentReadings(entries);
  const last = spent[spent.length - 1];
  const anchors = [last?.start === sight.start ? last.w : undefined, sight.wAtFull].filter((w): w is number => w !== undefined);
  const sinceW = sight.usedPct >= FULL_PCT && anchors.length > 0 ? Math.max(0, sight.w - Math.max(...anchors)) : 0;
  const spentUsd = spentUsdOf(spent) + (wPerUsd === undefined ? 0 : sinceW / wPerUsd);
  const leftUsd = Math.max(0, addedUsd - spentUsd);
  return { addedUsd, spentUsd, leftUsd, wPerUsd, learned: rate !== undefined, leftW: wPerUsd === undefined ? undefined : leftUsd * wPerUsd };
}

/**
 * The W metered to the period's 100% crossing: the first meter log line of the period starting at `start` at or past
 * 100% of the week (`PoolSight.wAtFull`); undefined before the week reached it.
 */
export function wAtFullOf(readings: readonly MeterReading[], start: number): number | undefined {
  return readings.find((reading) => reading.start === start && reading.usedPct >= FULL_PCT)?.w;
}

/**
 * The stretches the account's week sat at its usage limit, oldest first, for the stats' `$` days (T1771): in each
 * period, from its earliest meter log line at or past 100% (any team's line: the use is the account's) up to the
 * period's end, or to the start of the next period the log shows when that came sooner (a reset the use's fall
 * showed). The log keeps `READINGS_KEPT_MS` of lines (budget/calibration.ts), so an older stretch is gone.
 */
export function limitSpansOf(readings: readonly MeterReading[]): LimitSpan[] {
  const starts = [...new Set(readings.map((reading) => reading.start))].sort((a, b) => a - b);
  return starts.flatMap((start) => {
    const first = readings.filter((reading) => reading.start === start && reading.usedPct >= FULL_PCT).sort((a, b) => a.at - b.at)[0];
    const end = Math.min(first?.end ?? start, starts.find((next) => next > start) ?? Number.POSITIVE_INFINITY);
    return first !== undefined && end > first.at ? [{ start: first.at, end }] : [];
  });
}

function iso(at: number): string {
  return new Date(at).toISOString();
}

function instantOf(record: JsonRecord, key: string): number | undefined {
  const text = stringField(record, key);
  const at = text === undefined ? Number.NaN : Date.parse(text);
  return Number.isNaN(at) ? undefined : at;
}

/** One entry as the log's JSON record. */
export function extraRecordOf(entry: ExtraEntry): JsonRecord {
  return {
    [VERSION_FIELD]: EXTRA_LOG_FORMAT,
    at: iso(entry.at),
    kind: entry.kind,
    usd: entry.usd,
    ...(entry.weekPct === undefined ? {} : { weekPct: entry.weekPct }),
    start: iso(entry.start),
    end: iso(entry.end),
    w: entry.w,
  };
}

/** One record as an entry; undefined when it is damaged (an add of no dollars counts as damaged). */
export function parseExtraRecord(record: JsonRecord): ExtraEntry | undefined {
  const at = instantOf(record, 'at');
  const kind = stringField(record, 'kind');
  const usd = numberField(record, 'usd');
  const weekPct = numberField(record, 'weekPct');
  const start = instantOf(record, 'start');
  const end = instantOf(record, 'end');
  const w = numberField(record, 'w');
  if (at === undefined || !isKind(kind) || usd === undefined || usd < 0 || start === undefined || end === undefined || start >= end || w === undefined || w < 0) {
    return undefined;
  }
  if ((kind === 'add' && usd === 0) || ('weekPct' in record && (weekPct === undefined || weekPct < 0))) {
    return undefined;
  }
  return { at, kind, usd, weekPct, start, end, w };
}

/** The team's append-only log of extra-usage entries, oldest first. A line per user command keeps it a few lines a week. */
export class ExtraLog {
  private readonly files: Files;
  readonly path: string;

  constructor(files: Files, path: string) {
    this.files = files;
    this.path = path;
  }

  /** Every entry, oldest first; damaged lines and lines from a newer teamrig are skipped. */
  async read(): Promise<readonly ExtraEntry[]> {
    const parse = parseJsonl((await this.files.read(this.path)) ?? '');
    return parse.records.flatMap(({ record, version }) => {
      const entry = version === EXTRA_LOG_FORMAT ? parseExtraRecord(record) : undefined;
      return entry === undefined ? [] : [entry];
    });
  }

  /** One whole line in one append; refused beside records from a newer teamrig. */
  async append(entry: ExtraEntry): Promise<void> {
    const text = (await this.files.read(this.path)) ?? '';
    assertWritable(this.path, parseJsonl(text), EXTRA_LOG_FORMAT);
    const separator = text === '' || text.endsWith('\n') ? '' : '\n';
    await this.files.append(this.path, `${separator}${toJsonlLine(extraRecordOf(entry))}`);
  }
}
