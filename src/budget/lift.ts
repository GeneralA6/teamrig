import type { BudgetLiftConfig } from '../config/types.ts';
import type { Files } from '../core/files.ts';
import { stringField, type JsonRecord } from '../core/guards.ts';
import { assertWritable, parseJsonl, toJsonlLine, VERSION_FIELD } from '../core/jsonl.ts';
import { MS_PER_DAY, MS_PER_HOUR } from '../core/time.ts';
import type { TimeZone } from '../core/zone.ts';
import { formatEndTime, formatPct } from './format.ts';

/**
 * A leader's lift, for today only, of one session's daily budget or of a sub-lead's group's: a part of its parent's
 * daily budget (the team's, or the group's that holds it), which is recomputed at every reading, so the lifted
 * budget moves with it. The lifts in force under one parent never give more than the whole of it. Every lift
 * carries a stop %, the week's use at which it ends, and ends at the stop %, its `--until` or the end of the day,
 * whichever comes first. The reserve release (`--reserve`) is the one lift above `lift.maxStopPct`: only in the last
 * hour before the reset, up to `lift.reserveStopPct`, and always over 15 minutes before the reset. A session's lift
 * also exempts it from quiet hours, which the live warning reads; a group's lift is a share, so it does not.
 *
 * A team's lead also lifts a session of a team under its own, at any depth (`<team>/<id>`, a cross-team lift): a part
 * of its own team's daily budget, logged in its own team's log, which tops the session's own budget up. It exempts no
 * quiet hours: the lifted team's live warning reads its own log only.
 */

/**
 * The format of the lift log's records; any other is skipped on read, and a newer one refuses a write. Format 1
 * lifts gave a fixed % of the week; they lasted a day at most, so none is still in force. Format 3 adds `group`.
 */
export const LIFT_FORMAT = 3;
/** Format 2 records, written before group lifts, read as session lifts. */
const SESSION_LIFT_FORMAT = 2;
/** A reserve release is given only this long before the reset. */
export const RESERVE_OPENS_BEFORE_RESET_MS = MS_PER_HOUR;
/** A reserve release always ends this long before the reset. */
export const RESERVE_ENDS_BEFORE_RESET_MS = 15 * 60_000;

export interface Lift {
  /** The lifted session, or for a group lift the sub-lead whose group it lifts; `<team>/<id>` for a session of a team below. */
  readonly session: string;
  /** Whether it lifts the sub-lead's whole group rather than the session alone. */
  readonly group: boolean;
  /** The session's or group's part of its parent's daily budget while the lift lasts, in percent of that budget. */
  readonly partPct: number;
  /** The week's use, in percent, at which the lift ends. */
  readonly stopPct: number;
  /** When it ends at the latest, epoch ms. */
  readonly endsAt: number;
  readonly reserve: boolean;
  /** The live warning's quiet hours do not apply to the session while the lift lasts. */
  readonly quietHoursExempt: boolean;
  readonly reason: string;
  /** The leader that gave it. */
  readonly by: string;
  readonly at: number;
}

export interface LiftRequest {
  readonly session: string;
  readonly group: boolean;
  readonly partPct: number;
  /** Undefined when the command line left it out, which is refused. */
  readonly stopPct: number | undefined;
  readonly until: number | undefined;
  readonly reserve: boolean;
  readonly reason: string;
  readonly by: string;
  readonly now: number;
}

/** What a lift is judged against: the week's use and reset now, the team's bounds and the other lifts in force. */
export interface LiftContext {
  readonly usedPct: number | undefined;
  readonly reset: number | undefined;
  readonly limits: BudgetLiftConfig;
  /** The parts the other lifts in force under the same parent give, in percent of the parent's daily budget, summed. */
  readonly liftedPct: number;
  /** The parent's daily budget in words (`parentBudgetText`), which a refusal names. */
  readonly parent: string;
  /** What to do when the parent is too small, appended to that refusal; undefined when the parent is the team's. */
  readonly beyondParent: string | undefined;
  /** The team's zone, which a refusal prints its times in. */
  readonly zone: TimeZone;
}

/** The daily budget a lift is a part of: the team's, or the group's of the sub-lead that holds the lifted node. */
export function parentBudgetText(subLeadName: string | undefined): string {
  return subLeadName === undefined ? "the team's daily budget" : `${subLeadName}'s group's daily budget`;
}

/** Whether a lift is of a session of a team below the lifter's (`<team>/<id>`): no id or name holds a `/`. */
export function isCrossTeamLift(lift: Pick<Lift, 'session'>): boolean {
  return lift.session.includes('/');
}

export type LiftDecision = { readonly kind: 'lift'; readonly lift: Lift } | { readonly kind: 'refused'; readonly reason: string };

function refused(reason: string): LiftDecision {
  return { kind: 'refused', reason };
}

/** Whether the lift may be given, and when it ends. */
export function decideLift(request: LiftRequest, context: LiftContext): LiftDecision {
  const { stopPct, now, reserve } = request;
  const { limits, reset, usedPct, zone } = context;
  if (stopPct === undefined) {
    return refused('a lift needs --stop-pct <n>: the share of the week, in %, at which it ends');
  }
  if (request.partPct + context.liftedPct > 100) {
    const beyond = context.beyondParent === undefined ? '' : `. ${context.beyondParent}`;
    return refused(
      `the other lifts in force give ${formatPct(context.liftedPct)} of ${context.parent}, so --part ${request.partPct} ` +
        `would give more than all of it; the most this lift may give is ${formatPct(Math.max(0, 100 - context.liftedPct))}${beyond}`,
    );
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
    return refused(`--reserve releases the reserve only in the last hour before the reset, from ${zone.minute(new Date(reset - RESERVE_OPENS_BEFORE_RESET_MS))}`);
  }
  if (request.until !== undefined && request.until <= now) {
    return refused(`--until ${zone.minute(new Date(request.until))} has passed`);
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
    return refused(`the reserve release ends 15 minutes before the reset, at ${zone.minute(new Date(endsAt))}, which has passed`);
  }
  return {
    kind: 'lift',
    lift: {
      session: request.session,
      group: request.group,
      partPct: request.partPct,
      stopPct,
      endsAt,
      reserve,
      quietHoursExempt: !request.group && !isCrossTeamLift(request),
      reason: request.reason,
      by: request.by,
      at: now,
    },
  };
}

/**
 * The newest lift of `session` of the kind `group`, given by now and not yet ended by its time or, when the week's
 * use is known, by its stop %. A newer lift replaces an older one of the same kind.
 */
function newestInForce(lifts: readonly Lift[], session: string, group: boolean, now: number, usedPct: number | undefined): Lift | undefined {
  const newest = lifts.filter((lift) => lift.session === session && lift.group === group && lift.at <= now).at(-1);
  if (newest === undefined || now >= newest.endsAt || (usedPct !== undefined && usedPct >= newest.stopPct)) {
    return undefined;
  }
  return newest;
}

/** The session's own lift in force at `now`; a lift of the group it leads is not one. */
export function activeLift(lifts: readonly Lift[], session: string, now: number, usedPct: number | undefined): Lift | undefined {
  return newestInForce(lifts, session, false, now, usedPct);
}

/** The lift in force at `now` of the group `subLead` leads. */
export function activeGroupLift(lifts: readonly Lift[], subLead: string, now: number, usedPct: number | undefined): Lift | undefined {
  return newestInForce(lifts, subLead, true, now, usedPct);
}

/**
 * What a lift gives, after "lifted", on the team's clock, `parent` from `parentBudgetText`:
 * `teamrig to 40% of the team's daily budget today until 18:00 IDT or 97.0% of the week, ...`; a cross-team lift's
 * part is on top of the session's own budget.
 */
export function liftText(lift: Lift, name: string, parent: string, zone: TimeZone): string {
  const who = lift.group ? `${name}'s group` : name;
  const onTop = isCrossTeamLift(lift) ? ' on top of its own budget' : '';
  const quiet = lift.quietHoursExempt ? '; quiet hours do not apply to it' : '';
  return (
    `${who} to ${formatPct(lift.partPct)} of ${parent}${onTop} today${lift.reserve ? ' from the reserve' : ''} until ` +
    `${formatEndTime(lift.endsAt, zone)} or ${formatPct(lift.stopPct)} of the week, whichever comes first${quiet}.`
  );
}

/** A session's lift in force, by name for its lines; both undefined while it is not lifted. */
export interface LiftNames {
  /** The leader that gave the lift ({@link Lift.by}). */
  readonly liftBy: string | undefined;
  /** The sub-lead whose group's daily budget the lift is a part of; undefined for the team's. */
  readonly liftParent: string | undefined;
}

/** `Budget: <leader> lifted <session> to ...`, the line that shows a session's lift in force. */
export function liftedLine(lift: Lift, name: string, names: LiftNames, zone: TimeZone): string {
  return `Budget: ${names.liftBy ?? lift.by} lifted ${liftText(lift, name, parentBudgetText(names.liftParent), zone)}`;
}

function liftRecord(lift: Lift): JsonRecord {
  return {
    [VERSION_FIELD]: LIFT_FORMAT,
    session: lift.session,
    group: lift.group,
    partPct: lift.partPct,
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

/** One record of format `version` (2 or 3) as a lift; undefined when it is damaged. */
export function parseLift(record: JsonRecord, version: number): Lift | undefined {
  const { partPct, stopPct, reserve, quietHoursExempt, group: written } = record;
  const group = version === SESSION_LIFT_FORMAT ? false : written;
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
    !finitePct(partPct) ||
    !finitePct(stopPct) ||
    typeof group !== 'boolean' ||
    typeof reserve !== 'boolean' ||
    typeof quietHoursExempt !== 'boolean'
  ) {
    return undefined;
  }
  return { session, group, partPct, stopPct, endsAt, reserve, quietHoursExempt, reason, by, at };
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
      const lift = version === LIFT_FORMAT || version === SESSION_LIFT_FORMAT ? parseLift(record, version) : undefined;
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
