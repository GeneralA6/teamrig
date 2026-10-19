import type { BudgetConfig } from '../config/types.ts';
import type { Files } from '../core/files.ts';
import type { JsonRecord } from '../core/guards.ts';
import { parseObject, toJsonlLine, VERSION_FIELD } from '../core/jsonl.ts';
import { MS_PER_WEEK } from '../core/time.ts';
import { resolveReset } from './pace.ts';
import type { WeekUse } from './snapshot.ts';

/** The format of the period file this code reads and writes; a file in another format or damaged reads as none. */
export const PERIOD_FORMAT = 1;
/**
 * A drop in the week's use this large, its reset time unchanged, is a reset of the use inside the week: use only
 * grows otherwise, and two sessions' readings of one moment differ by less.
 */
export const RESET_DROP_PTS = 2;

/**
 * An end seen more than half a week past the period's is the next week's: a reset moved by the plan, or a
 * configured one that is off from the plan's, moves by hours.
 */
const HALF_WEEK = MS_PER_WEEK / 2;

/**
 * How the period's start is known: `assumed` a week before its end (no earlier period was seen), `week` the end of
 * the period before it (the weekly reset), `reset` the latest reading before the use fell inside the week.
 */
export type PeriodKind = 'assumed' | 'week' | 'reset';

/**
 * The span the week's use counts in, from `start` to the plan's reset at `end`: a whole week, or after a reset
 * inside the week its rest, a new budget. `lastPct` and `lastAt` are the latest use read in it, which a reading
 * far below shows a reset after.
 */
export interface Period {
  readonly start: number;
  readonly end: number;
  readonly kind: PeriodKind;
  readonly lastPct: number;
  readonly lastAt: number;
}

/** What the readers see now: the next reset (the status line's, else the config's) and the status line's use. */
export interface PeriodSight {
  readonly end: number;
  readonly use: WeekUse | undefined;
}

/** What the readers see at `now`; undefined while no reset is known (no status line reading and no `budget.reset`). */
export function sightOf(budget: Pick<BudgetConfig, 'reset'>, use: WeekUse | undefined, now: number): PeriodSight | undefined {
  const end = resolveReset(now, use?.resetsAt, budget.reset);
  return end === undefined ? undefined : { end, use };
}

function opened(start: number, end: number, kind: PeriodKind, use: WeekUse | undefined): Period {
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
 *   never low. Any other reading taken after it becomes its latest.
 */
export function nextPeriod(stored: Period | undefined, sight: PeriodSight): Period {
  const { end, use } = sight;
  if (stored === undefined || end <= stored.start || end > stored.end + MS_PER_WEEK + HALF_WEEK) {
    return opened(end - MS_PER_WEEK, end, 'assumed', use);
  }
  if (end > stored.end + HALF_WEEK) {
    return opened(stored.end, end, 'week', use);
  }
  const running: Period = { ...stored, start: stored.kind === 'assumed' ? end - MS_PER_WEEK : stored.start, end };
  if (use === undefined || use.at < running.lastAt) {
    return running;
  }
  if (use.usedPct <= running.lastPct - RESET_DROP_PTS) {
    return opened(Math.max(running.start, running.lastAt), end, 'reset', use);
  }
  return { ...running, lastPct: use.usedPct, lastAt: use.at };
}

const KINDS: readonly PeriodKind[] = ['assumed', 'week', 'reset'];

function isKind(value: unknown): value is PeriodKind {
  return KINDS.some((kind) => kind === value);
}

function numberField(record: JsonRecord, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** A period file's content; undefined when it is damaged or in another format, which starts the period over. */
export function parsePeriod(text: string): Period | undefined {
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

export function formatPeriod(period: Period): string {
  return toJsonlLine({ [VERSION_FIELD]: PERIOD_FORMAT, start: period.start, end: period.end, kind: period.kind, lastPct: period.lastPct, lastAt: period.lastAt });
}

function samePeriod(a: Period | undefined, b: Period): boolean {
  return a !== undefined && a.start === b.start && a.end === b.end && a.kind === b.kind && a.lastPct === b.lastPct && a.lastAt === b.lastAt;
}

/**
 * The team's period file, which every reader of the week (the budget hooks, `budget`, a hire's price, the bursts)
 * moves on from what it sees and writes back only when it changed. Two readers that write at once saw nearly the
 * same snapshots: a reset one of them lost is seen again at the next read, from a reading before the fall.
 */
export class PeriodStore {
  private readonly files: Files;
  private readonly path: string;

  constructor(files: Files, path: string) {
    this.files = files;
    this.path = path;
  }

  async read(): Promise<Period | undefined> {
    const text = await this.files.read(this.path);
    return text === undefined ? undefined : parsePeriod(text);
  }

  /** The period after `sight`, written when it changed. */
  async advance(sight: PeriodSight): Promise<Period> {
    const stored = await this.read();
    const next = nextPeriod(stored, sight);
    if (!samePeriod(stored, next)) {
      await this.files.write(this.path, formatPeriod(next));
    }
    return next;
  }

  /** The period at `now` after the status line's `use` (`sightOf`), written when it changed; undefined while no reset is known. */
  async periodAt(budget: Pick<BudgetConfig, 'reset'>, use: WeekUse | undefined, now: number): Promise<Period | undefined> {
    const sight = sightOf(budget, use, now);
    return sight === undefined ? undefined : this.advance(sight);
  }
}
