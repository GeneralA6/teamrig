import { join } from 'node:path';
import type { Files } from '../core/files.ts';
import { isNonNegativeInteger, isRecord, isStringArray } from '../core/guards.ts';
import { ID_PATTERN, ID_RULE } from '../core/ids.ts';
import { parseObject, recordVersion, VERSION_FIELD, writableObject } from '../core/jsonl.ts';
import { formatUtcDay, MS_PER_DAY } from '../core/time.ts';
import { TASK_ID } from '../register/model.ts';
import { INITIAL_MISS_STATE, parseMissState, type MissState } from './misses.ts';
import { INITIAL_PATTERN_STATE, parsePatternCounts, parsePatternState, type PatternCounts, type PatternState } from './patterns.ts';
import { NO_TURN, parseOpenTurn, type OpenTurn } from './tasks.ts';

/**
 * The format of the usage files this code writes; a damaged file or one older than `OLDEST_READ_FORMAT`
 * reads as empty, a newer one is refused. A teamrig rewrites a file of its own format without the fields it
 * does not know, so a field added to the file is a new format, which an older teamrig refuses
 * (store.test.ts pins the fields of each). 2 holds what 1 held by 0.111.2: format 1 grew day counters,
 * hours, an open call's hour and a cursor's misses, which a teamrig before each dropped from every file it
 * rewrote. 3 adds W per task and a cursor's open turn (T734). 4 adds a cursor's pending work-block start note
 * (misses.noted, T1529).
 */
export const USAGE_FORMAT = 4;
/** The oldest format this code reads: format 1, whose hours, open-call hours and misses may be missing. */
const OLDEST_READ_FORMAT = 1;
/** Days of totals a usage file keeps: today and the 7 before it. */
export const DAYS_KEPT = 8;
/**
 * Days a transcript's read position is kept after it last moved: today and yesterday. A transcript
 * read again after its position was dropped starts at today's first line, and nothing of today was
 * counted from it, so dropping it never counts a line twice.
 */
export const CURSOR_DAYS_KEPT = 2;
/** How many recent call keys a usage file keeps to skip a call logged twice. */
export const RECENT_KEYS_KEPT = 200;

/** One day's use by a session: its weighted tokens, its calls and its loop-pattern counters. */
export interface DayUsage {
  readonly w: number;
  readonly calls: number;
  readonly patterns: PatternCounts;
}

/**
 * The call a transcript's last read ended in. Its later lines repeat its usage with the output count
 * so far, so a later read adds only the output it grew by, to the day the call began.
 */
export interface OpenCall {
  readonly key: string | null;
  readonly day: string;
  /**
   * The UTC hour the call began (`YYYY-MM-DDTHH`), where its added output is counted too; null in a cursor
   * stored before hours were counted, whose added output counts to its day alone.
   */
  readonly hour: string | null;
  readonly output: number;
  readonly context: number;
  readonly w: number;
}

/** Where the meter stopped in one transcript, and that transcript's state at that point. */
export interface TranscriptCursor {
  /** The offset of the first byte not yet counted, always the start of a line. */
  readonly offset: number;
  /** The file's size at the last read. */
  readonly size: number;
  /** The UTC day this position last moved. */
  readonly day: string;
  readonly call: OpenCall | null;
  readonly patterns: PatternState;
  readonly misses: MissState;
  /** The turn the read ended in, whose W goes to the tasks it names; none in a subagent's transcript. */
  readonly turn: OpenTurn;
}

/**
 * A session's metered use: totals per UTC day, W per UTC hour, a read position per transcript, and the last
 * call keys seen.
 */
export interface UsageState {
  readonly byDay: Readonly<Record<string, DayUsage>>;
  /**
   * W per UTC hour (`YYYY-MM-DDTHH`), kept as long as the days, so use is counted from any hour: a reset
   * of the week. An hour with no use has no entry. A format-1 file from before hours were counted has none,
   * and one a teamrig before 0.99.0 rewrote lost them, so a day's hours can sum to less than its W.
   */
  readonly byHour: Readonly<Record<string, number>>;
  /**
   * W per UTC day per task its turns named (`tasks.ts`), kept as long as the days. A day's W the tasks do not
   * sum to was spent in turns that named no task, by subagents, or is still held by an open turn.
   */
  readonly byTask: Readonly<Record<string, Readonly<Record<string, number>>>>;
  readonly cursors: Readonly<Record<string, TranscriptCursor>>;
  readonly recentKeys: readonly string[];
}

/** A usage state and the revision it was read at, which a write must still find to replace it. */
export interface StoredUsage {
  readonly rev: number;
  readonly state: UsageState;
}

export const EMPTY_USAGE: UsageState = { byDay: {}, byHour: {}, byTask: {}, cursors: {}, recentKeys: [] };

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const HOUR = /^\d{4}-\d{2}-\d{2}T\d{2}$/;

function finiteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function wFrom(value: unknown): number | undefined {
  return finiteNonNegative(value) ? value : undefined;
}

function dayUsageFrom(value: unknown): DayUsage | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const { w, calls } = value;
  const patterns = parsePatternCounts(value['patterns']);
  return finiteNonNegative(w) && isNonNegativeInteger(calls) && patterns !== undefined ? { w, calls, patterns } : undefined;
}

function openCallFrom(value: unknown): OpenCall | null | undefined {
  if (value === null) {
    return null;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  const { key, day, output, context, w } = value;
  // A call stored before hours were counted has no hour.
  const hour = value['hour'] ?? null;
  if (
    !(key === null || typeof key === 'string') ||
    typeof day !== 'string' ||
    !DAY.test(day) ||
    !(hour === null || (typeof hour === 'string' && HOUR.test(hour) && hour.startsWith(day))) ||
    !isNonNegativeInteger(output) ||
    !isNonNegativeInteger(context) ||
    !finiteNonNegative(w)
  ) {
    return undefined;
  }
  return { key, day, hour, output, context, w };
}

function cursorFrom(value: unknown): TranscriptCursor | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const { offset, size, day } = value;
  const call = openCallFrom(value['call']);
  const patterns = parsePatternState(value['patterns']);
  const rawMisses = value['misses'];
  // A cursor stored before 0.87.0 has no miss state: its transcript goes on as if read from its start.
  const misses = rawMisses === undefined ? INITIAL_MISS_STATE : parseMissState(rawMisses);
  const rawTurn = value['turn'];
  // A cursor stored before format 3 has no turn: its next prompt starts one.
  const turn = rawTurn === undefined ? NO_TURN : parseOpenTurn(rawTurn);
  if (
    !isNonNegativeInteger(offset) ||
    !isNonNegativeInteger(size) ||
    typeof day !== 'string' ||
    !DAY.test(day) ||
    call === undefined ||
    patterns === undefined ||
    misses === undefined ||
    turn === undefined
  ) {
    return undefined;
  }
  return { offset, size, day, call, patterns, misses, turn };
}

/** Every entry of a stored map through `parse`; undefined when the map or any entry is damaged. */
function mapFrom<T>(value: unknown, keyValid: (key: string) => boolean, parse: (entry: unknown) => T | undefined): Record<string, T> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const out: Record<string, T> = {};
  for (const [key, entry] of Object.entries(value)) {
    const parsed = parse(entry);
    if (!keyValid(key) || parsed === undefined) {
      return undefined;
    }
    out[key] = parsed;
  }
  return out;
}

/**
 * The revision a usage file was written at; 0 for a missing or damaged file, so the first write makes
 * it 1. A file in a newer format is refused, so an old version never replaces what a newer one wrote.
 */
function revOf(path: string, text: string | undefined): number {
  const rev = writableObject(path, text, USAGE_FORMAT)?.['rev'];
  return isNonNegativeInteger(rev) ? rev : 0;
}

/** A usage file's content; undefined when it is damaged or in a format this code does not read, which the meter treats as a fresh start. */
export function parseUsage(text: string): UsageState | undefined {
  const record = parseObject(text.trim());
  const version = record === undefined ? undefined : recordVersion(record);
  if (record === undefined || version === undefined || version < OLDEST_READ_FORMAT || version > USAGE_FORMAT) {
    return undefined;
  }
  const byDay = mapFrom(record['byDay'], (key) => DAY.test(key), dayUsageFrom);
  const rawHours = record['byHour'];
  // A format-1 file from before hours were counted has none.
  const byHour = rawHours === undefined ? {} : mapFrom(rawHours, (key) => HOUR.test(key), wFrom);
  const rawTasks = record['byTask'];
  // A file before format 3 counted no tasks.
  const byTask = rawTasks === undefined ? {} : mapFrom(rawTasks, (key) => DAY.test(key), (tasks) => mapFrom(tasks, (key) => TASK_ID.test(key), wFrom));
  const cursors = mapFrom(record['cursors'], (key) => key !== '', cursorFrom);
  const recentKeys = record['recentKeys'];
  if (byDay === undefined || byHour === undefined || byTask === undefined || cursors === undefined || !isStringArray(recentKeys)) {
    return undefined;
  }
  return { byDay, byHour, byTask, cursors, recentKeys };
}

export function formatUsage(state: UsageState, rev: number): string {
  const { byDay, byHour, byTask, cursors, recentKeys } = state;
  return `${JSON.stringify({ [VERSION_FIELD]: USAGE_FORMAT, rev, byDay, byHour, byTask, cursors, recentKeys })}\n`;
}

/**
 * Drops what a usage file no longer needs at `now`: days, their hours and their tasks older than the kept window,
 * transcript positions that have not moved since before yesterday, and all but the latest call keys.
 */
export function pruneUsage(state: UsageState, now: number): UsageState {
  const oldestDay = formatUtcDay(new Date(now - (DAYS_KEPT - 1) * MS_PER_DAY));
  const oldestCursor = formatUtcDay(new Date(now - (CURSOR_DAYS_KEPT - 1) * MS_PER_DAY));
  return {
    byDay: Object.fromEntries(Object.entries(state.byDay).filter(([day]) => day >= oldestDay)),
    // An hour key starts with its day, and a longer key sorts after its prefix.
    byHour: Object.fromEntries(Object.entries(state.byHour).filter(([hour]) => hour >= oldestDay)),
    byTask: Object.fromEntries(Object.entries(state.byTask).filter(([day]) => day >= oldestDay)),
    cursors: Object.fromEntries(Object.entries(state.cursors).filter(([, cursor]) => cursor.day >= oldestCursor)),
    recentKeys: state.recentKeys.slice(-RECENT_KEYS_KEPT),
  };
}

/** A transcript's position before its first read: no call or turn open and no pattern or miss seen. */
export function newCursor(offset: number, size: number, day: string): TranscriptCursor {
  return { offset, size, day, call: null, patterns: INITIAL_PATTERN_STATE, misses: INITIAL_MISS_STATE, turn: NO_TURN };
}

/** Where a meter keeps each session's usage: its usage file, or memory for a recount that writes nothing. */
export interface UsageStorage {
  load(session: string): Promise<StoredUsage>;
  /** Saves `state` as the revision after `baseRev`; false, saving nothing, when another writer saved since. */
  save(session: string, state: UsageState, baseRev: number): Promise<boolean>;
}

/** Usage kept in memory, for a recount of a past day that must not move the usage files. */
export class MemoryUsageStore implements UsageStorage {
  private readonly stored = new Map<string, StoredUsage>();

  async load(session: string): Promise<StoredUsage> {
    return this.stored.get(session) ?? { rev: 0, state: EMPTY_USAGE };
  }

  async save(session: string, state: UsageState, baseRev: number): Promise<boolean> {
    if ((this.stored.get(session)?.rev ?? 0) !== baseRev) {
      return false;
    }
    this.stored.set(session, { rev: baseRev + 1, state });
    return true;
  }
}

/**
 * Each session's usage file, `<dir>/<session>.json`. Only the session's own hooks write it, but two of
 * them can run at once: each write replaces the whole file atomically and only when the file still has
 * the revision its writer read, so totals and read positions always change together. A writer that
 * lost writes nothing, and the next run counts its lines again from the positions that won.
 */
export class UsageStore implements UsageStorage {
  private readonly files: Files;
  private readonly dir: string;

  constructor(files: Files, dir: string) {
    this.files = files;
    this.dir = dir;
  }

  /**
   * The session's usage and its revision: an empty state when there is none or it is damaged.
   * Throws NewerDataError when a newer teamrig wrote it.
   */
  async load(session: string): Promise<StoredUsage> {
    const path = this.pathOf(session);
    const text = await this.files.read(path);
    const rev = revOf(path, text);
    const state = text === undefined ? undefined : parseUsage(text);
    return { rev, state: state ?? EMPTY_USAGE };
  }

  /**
   * Writes `state` as the revision after `baseRev`; false, writing nothing, when another writer saved
   * since. Two writers that check at the same moment can both write: the later one replaces the
   * earlier whole, and as each file holds totals that match its own read positions, nothing is
   * counted twice; the lines only the earlier one counted are counted again by the next run.
   */
  async save(session: string, state: UsageState, baseRev: number): Promise<boolean> {
    const path = this.pathOf(session);
    if (revOf(path, await this.files.read(path)) !== baseRev) {
      return false;
    }
    await this.files.write(path, formatUsage(state, baseRev + 1));
    return true;
  }

  private pathOf(session: string): string {
    if (!ID_PATTERN.test(session)) {
      throw new Error(`Session id "${session}" is not valid: ${ID_RULE}.`);
    }
    return join(this.dir, `${session}.json`);
  }
}
