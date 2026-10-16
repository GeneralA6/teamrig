import type { Clock } from '../core/lock.ts';
import { formatUtcDay, MS_PER_DAY } from '../core/time.ts';
import { findLineAtOrAfter, readLines, type TranscriptBytes } from './cursor.ts';
import { parseTranscriptLine, type CallLine } from './line.ts';
import { emptyPatterns, PatternTracker, type Count, type PatternField } from './patterns.ts';
import {
  newCursor,
  pruneUsage,
  RECENT_KEYS_KEPT,
  type DayUsage,
  type OpenCall,
  type TranscriptCursor,
  type UsageState,
  type UsageStorage,
} from './store.ts';
import { contextTokens, WEIGHTS, weightOf } from './weights.ts';

/** What the meter reads with and where it keeps its totals. */
export interface MeterDeps {
  readonly bytes: TranscriptBytes;
  readonly store: UsageStorage;
  readonly clock: Clock;
}

export interface MeterRun {
  /** The session the transcripts belong to: its usage file is the one updated. */
  readonly session: string;
  /** The session's transcripts, read in this order: its own, then its subagents'. */
  readonly transcripts: readonly string[];
  /** The most bytes this run reads; what is left is read by the next run. */
  readonly maxBytes: number;
}

export interface MeterResult {
  /** The usage after this run, saved or not. */
  readonly state: UsageState;
  /** False when another run saved first: this run's counts are dropped and its lines are read again next time. */
  readonly saved: boolean;
  /** True when the byte limit left lines unread, so the totals are behind. */
  readonly catchingUp: boolean;
  readonly bytesRead: number;
}

interface DayTotals {
  w: number;
  calls: number;
  readonly patterns: Record<PatternField, number>;
}

/**
 * Totals while a run counts: per-day sums, and the latest call keys across all the session's
 * transcripts, so a call two files both logged counts once.
 */
class Tally {
  private readonly days = new Map<string, DayTotals>();
  private readonly keys: string[];
  private readonly keySet: Set<string>;

  constructor(state: UsageState) {
    for (const [day, usage] of Object.entries(state.byDay)) {
      this.days.set(day, { w: usage.w, calls: usage.calls, patterns: { ...usage.patterns } });
    }
    this.keys = [...state.recentKeys];
    this.keySet = new Set(this.keys);
  }

  day(day: string): DayTotals {
    const found = this.days.get(day);
    if (found !== undefined) {
      return found;
    }
    const created: DayTotals = { w: 0, calls: 0, patterns: emptyPatterns() };
    this.days.set(day, created);
    return created;
  }

  counter(day: string | undefined): Count {
    if (day === undefined) {
      return () => undefined;
    }
    const totals = this.day(day);
    return (field, amount) => {
      totals.patterns[field] += amount;
    };
  }

  /** True when the key was seen recently; else it is remembered, the oldest key falling out past the limit. */
  seen(key: string): boolean {
    if (this.keySet.has(key)) {
      return true;
    }
    this.keys.push(key);
    this.keySet.add(key);
    if (this.keys.length > RECENT_KEYS_KEPT) {
      const oldest = this.keys.shift();
      if (oldest !== undefined) {
        this.keySet.delete(oldest);
      }
    }
    return false;
  }

  byDay(): Record<string, DayUsage> {
    return Object.fromEntries([...this.days].map(([day, totals]) => [day, { w: totals.w, calls: totals.calls, patterns: { ...totals.patterns } }]));
  }

  recentKeys(): readonly string[] {
    return [...this.keys];
  }
}

function dayOf(at: number): string {
  return formatUtcDay(new Date(at));
}

/**
 * Counts one transcript's new lines into the tally. A reply is several lines sharing its key, each
 * repeating the usage with the output so far: the first line counts the call, a later one only the
 * output it adds. A call whose key was seen in the last few hundred calls was logged twice and is
 * skipped; a call without a timestamp is skipped, as no day can take it.
 */
class TranscriptFold {
  private call: OpenCall | null;
  private readonly tracker: PatternTracker;
  private readonly tally: Tally;

  constructor(cursor: TranscriptCursor, tally: Tally) {
    this.call = cursor.call;
    this.tracker = new PatternTracker(cursor.patterns);
    this.tally = tally;
  }

  line(raw: string): void {
    const line = parseTranscriptLine(raw);
    if (line === undefined) {
      return;
    }
    if (line.kind === 'prompt') {
      this.close();
      this.tracker.prompt(line.trigger, this.tally.counter(line.at === undefined ? undefined : dayOf(line.at)));
    } else if (line.kind === 'compact') {
      this.tally.counter(line.at === undefined ? undefined : dayOf(line.at))('compactions', 1);
    } else if (line.kind === 'results') {
      const day = this.call?.day ?? (line.at === undefined ? undefined : dayOf(line.at));
      this.tracker.results(line.results, this.tally.counter(day));
    } else {
      this.reply(line);
    }
  }

  cursor(offset: number, size: number, day: string): TranscriptCursor {
    return { offset, size, day, call: this.call, patterns: this.tracker.state() };
  }

  private reply(line: CallLine): void {
    const open = this.call;
    if (open !== null && line.key !== undefined && line.key === open.key) {
      const added = Math.max(0, line.usage.output - open.output) * WEIGHTS.output;
      this.tally.day(open.day).w += added;
      this.tracker.charged(added, this.tally.counter(open.day));
      this.call = { ...open, output: Math.max(open.output, line.usage.output), w: open.w + added };
      this.tracker.callJoined(line.tools);
      return;
    }
    this.close();
    if (line.at === undefined || (line.key !== undefined && this.tally.seen(line.key))) {
      return;
    }
    const day = dayOf(line.at);
    const w = weightOf(line.usage);
    const context = contextTokens(line.usage);
    const totals = this.tally.day(day);
    totals.w += w;
    totals.calls += 1;
    this.tracker.charged(w, this.tally.counter(day));
    this.tracker.callStarted(line.usage, line.tools, this.tally.counter(day));
    this.call = { key: line.key ?? null, day, output: line.usage.output, context, w };
  }

  /** The open call is complete: its loop patterns are judged now, against the call before it. */
  private close(): void {
    const open = this.call;
    if (open === null) {
      return;
    }
    this.tracker.callClosed(open.context, open.w, this.tally.counter(open.day));
    this.call = null;
  }
}

/**
 * Counts a session's API use from its transcripts since the last run, as weighted tokens per UTC day,
 * calls and loop patterns, and saves the totals with each transcript's read position. A transcript
 * seen for the first time (or that shrank, so it was replaced) is read from today's first line, found
 * by a binary search. One run reads at most `maxBytes`; the rest waits for the next run.
 */
export async function runMeter(deps: MeterDeps, run: MeterRun): Promise<MeterResult> {
  const { rev, state } = await deps.store.load(run.session);
  const now = deps.clock.now();
  const today = dayOf(now);
  const todayStart = now - (now % MS_PER_DAY);
  const tally = new Tally(state);
  const cursors: Record<string, TranscriptCursor> = { ...state.cursors };
  let budget = run.maxBytes;
  let bytesRead = 0;
  let catchingUp = false;
  for (const path of run.transcripts) {
    const size = await deps.bytes.size(path);
    if (size === undefined) {
      continue;
    }
    const stored = cursors[path];
    const cursor =
      stored !== undefined && stored.offset <= size ? stored : newCursor(await findLineAtOrAfter(deps.bytes, path, size, todayStart), size, today);
    if (cursor.offset === size) {
      cursors[path] = { ...cursor, size };
      continue;
    }
    if (budget <= 0) {
      catchingUp = true;
      cursors[path] = cursor;
      continue;
    }
    const batch = await readLines(deps.bytes, path, cursor.offset, size, budget);
    budget -= batch.bytes;
    bytesRead += batch.bytes;
    catchingUp ||= batch.capped;
    const fold = new TranscriptFold(cursor, tally);
    for (const line of batch.lines) {
      fold.line(line);
    }
    cursors[path] = fold.cursor(batch.end, size, batch.end > cursor.offset ? today : cursor.day);
  }
  const next = pruneUsage({ byDay: tally.byDay(), cursors, recentKeys: tally.recentKeys() }, now);
  const saved = await deps.store.save(run.session, next, rev);
  return { state: next, saved, catchingUp, bytesRead };
}
