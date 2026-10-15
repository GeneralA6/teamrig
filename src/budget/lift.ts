import type { BudgetLiftConfig } from '../config/types.ts';
import type { Files } from '../core/files.ts';
import { stringField, type JsonRecord } from '../core/guards.ts';
import { assertWritable, parseJsonl, toJsonlLine, VERSION_FIELD } from '../core/jsonl.ts';
import { formatUtcMinute, MS_PER_DAY, MS_PER_HOUR } from '../core/time.ts';
import { formatEndTime, formatPct } from './format.ts';

/**
 * The lead's lift of one session's daily budget, for today only. Every lift carries a stop %, the
 * week's use at which it ends, and ends at the stop %, its `--until` or the end of the day, whichever
 * comes first. The reserve release (`--reserve`) is the one lift above `lift.maxStopPct`: only in the
 * last hour before the reset, up to `lift.reserveStopPct`, and always over 15 minutes before the reset.
 * A lift also exempts its session from quiet hours, which the live warning reads.
 */

/** The format of the lift log's records; a newer one is skipped on read and refuses a write. */
export const LIFT_FORMAT = 1;
/** A reserve release is given only this long before the reset. */
export const RESERVE_OPENS_BEFORE_RESET_MS = MS_PER_HOUR;
/** A reserve release always ends this long before the reset. */
export const RESERVE_ENDS_BEFORE_RESET_MS = 15 * 60_000;

export interface Lift {
  readonly session: string;
  /** The session's daily budget while the lift lasts, in percent of the week. */
  readonly toPct: number;
  /** The week's use, in percent, at which the lift ends. */
  readonly stopPct: number;
  /** When it ends at the latest, epoch ms. */
  readonly endsAt: number;
  readonly reserve: boolean;
  /** The live warning's quiet hours do not apply to the session while the lift lasts. */
  readonly quietHoursExempt: boolean;
  readonly reason: string;
  /** The lead that gave it. */
  readonly by: string;
  readonly at: number;
}

export interface LiftRequest {
  readonly session: string;
  readonly toPct: number;
  /** Undefined when the command line left it out, which is refused. */
  readonly stopPct: number | undefined;
  readonly until: number | undefined;
  readonly reserve: boolean;
  readonly reason: string;
  readonly by: string;
  readonly now: number;
}

/** What a lift is judged against: the week's use and reset now, and the team's bounds. */
export interface LiftContext {
  readonly usedPct: number | undefined;
  readonly reset: number | undefined;
  readonly limits: BudgetLiftConfig;
}

export type LiftDecision = { readonly kind: 'lift'; readonly lift: Lift } | { readonly kind: 'refused'; readonly reason: string };

function refused(reason: string): LiftDecision {
  return { kind: 'refused', reason };
}

/** Whether the lift may be given, and when it ends. */
export function decideLift(request: LiftRequest, context: LiftContext): LiftDecision {
  const { stopPct, now, reserve } = request;
  const { limits, reset, usedPct } = context;
  if (stopPct === undefined) {
    return refused('a lift needs --stop-pct <n>: the share of the week, in %, at which it ends');
  }
  if (stopPct > limits.reserveStopPct) {
    return refused(`--stop-pct ${stopPct} is above budget.lift.reserveStopPct (${limits.reserveStopPct}), the most any lift may reach`);
  }
  if (!reserve && stopPct > limits.maxStopPct) {
    return refused(
      `--stop-pct ${stopPct} is above budget.lift.maxStopPct (${limits.maxStopPct}); only the reserve release ` +
        `(--reserve, in the last hour before the reset) goes up to ${limits.reserveStopPct}`,
    );
  }
  if (reserve && reset === undefined) {
    return refused('--reserve needs the week\'s reset: no status line snapshot gives it and budget.reset is not set');
  }
  if (reserve && reset !== undefined && now < reset - RESERVE_OPENS_BEFORE_RESET_MS) {
    return refused(`--reserve releases the reserve only in the last hour before the reset, from ${formatUtcMinute(new Date(reset - RESERVE_OPENS_BEFORE_RESET_MS))} UTC`);
  }
  if (request.until !== undefined && request.until <= now) {
    return refused(`--until ${formatUtcMinute(new Date(request.until))} UTC has passed`);
  }
  if (usedPct === undefined) {
    return refused("the week's use is unknown, so the stop % cannot be judged: run teamrig statusline install, or set budget.weeklyLimitW");
  }
  if (usedPct >= stopPct) {
    return refused(`the week is at ${formatPct(usedPct)}, already at or past --stop-pct ${stopPct}`);
  }
  const dayEnd = now - (now % MS_PER_DAY) + MS_PER_DAY;
  const latest = reserve && reset !== undefined ? reset - RESERVE_ENDS_BEFORE_RESET_MS : dayEnd;
  const endsAt = Math.min(request.until ?? latest, latest);
  if (endsAt <= now) {
    return refused(`the reserve release ends 15 minutes before the reset, at ${formatUtcMinute(new Date(endsAt))} UTC, which has passed`);
  }
  return {
    kind: 'lift',
    lift: {
      session: request.session,
      toPct: request.toPct,
      stopPct,
      endsAt,
      reserve,
      quietHoursExempt: true,
      reason: request.reason,
      by: request.by,
      at: now,
    },
  };
}

/**
 * The session's lift in force at `now`: its newest lift, given by now and not yet ended by its time
 * or, when the week's use is known, by its stop %. A newer lift replaces an older one.
 */
export function activeLift(lifts: readonly Lift[], session: string, now: number, usedPct: number | undefined): Lift | undefined {
  const newest = lifts.filter((lift) => lift.session === session && lift.at <= now).at(-1);
  if (newest === undefined || now >= newest.endsAt || (usedPct !== undefined && usedPct >= newest.stopPct)) {
    return undefined;
  }
  return newest;
}

/** What a lift gives, after "lifted": `teamrig to 2.0% today until 18:00 UTC or 97.0% of the week, ...`. */
export function liftText(lift: Lift, name: string): string {
  return (
    `${name} to ${formatPct(lift.toPct)} today${lift.reserve ? ' from the reserve' : ''} until ${formatEndTime(lift.endsAt)} ` +
    `or ${formatPct(lift.stopPct)} of the week, whichever comes first; quiet hours do not apply to it.`
  );
}

function liftRecord(lift: Lift): JsonRecord {
  return {
    [VERSION_FIELD]: LIFT_FORMAT,
    session: lift.session,
    toPct: lift.toPct,
    stopPct: lift.stopPct,
    endsAt: new Date(lift.endsAt).toISOString(),
    reserve: lift.reserve,
    quietHoursExempt: lift.quietHoursExempt,
    reason: lift.reason,
    by: lift.by,
    at: new Date(lift.at).toISOString(),
  };
}

function finitePct(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 100;
}

function instantOf(record: JsonRecord, key: string): number | undefined {
  const text = stringField(record, key);
  const at = text === undefined ? Number.NaN : Date.parse(text);
  return Number.isNaN(at) ? undefined : at;
}

/** One record as a lift; undefined when it is damaged. */
export function parseLift(record: JsonRecord): Lift | undefined {
  const { toPct, stopPct, reserve, quietHoursExempt } = record;
  const session = stringField(record, 'session');
  const reason = stringField(record, 'reason');
  const by = stringField(record, 'by');
  const endsAt = instantOf(record, 'endsAt');
  const at = instantOf(record, 'at');
  if (
    session === undefined ||
    reason === undefined ||
    by === undefined ||
    endsAt === undefined ||
    at === undefined ||
    !finitePct(toPct) ||
    !finitePct(stopPct) ||
    typeof reserve !== 'boolean' ||
    typeof quietHoursExempt !== 'boolean'
  ) {
    return undefined;
  }
  return { session, toPct, stopPct, endsAt, reserve, quietHoursExempt, reason, by, at };
}

export interface LiftLogRead {
  readonly lifts: readonly Lift[];
  /** Damaged lines and lines from a newer teamrig, skipped. */
  readonly skipped: number;
}

/** The team's append-only log of lifts, `<state>/usage/lifts.jsonl`, oldest first. */
export class LiftLog {
  private readonly files: Files;
  readonly path: string;

  constructor(files: Files, path: string) {
    this.files = files;
    this.path = path;
  }

  async read(): Promise<LiftLogRead> {
    const parse = parseJsonl((await this.files.read(this.path)) ?? '');
    const lifts: Lift[] = [];
    for (const { record, version } of parse.records) {
      const lift = version === LIFT_FORMAT ? parseLift(record) : undefined;
      if (lift !== undefined) {
        lifts.push(lift);
      }
    }
    return { lifts, skipped: parse.unreadable + parse.records.length - lifts.length };
  }

  /** One whole line in one append; refused beside records from a newer teamrig. */
  async append(lift: Lift): Promise<void> {
    const text = (await this.files.read(this.path)) ?? '';
    assertWritable(this.path, parseJsonl(text), LIFT_FORMAT);
    const separator = text === '' || text.endsWith('\n') ? '' : '\n';
    await this.files.append(this.path, `${separator}${toJsonlLine(liftRecord(lift))}`);
  }
}
