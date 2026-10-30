import { stringField } from "../core/guards.js";
import { assertWritable, parseJsonl, toJsonlLine, VERSION_FIELD } from "../core/jsonl.js";
import { MS_PER_DAY, MS_PER_HOUR } from "../core/time.js";
import { formatEndTime, formatPct } from "./format.js";
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
/** The daily budget a lift is a part of: the team's, or the group's of the sub-lead that holds the lifted node. */
export function parentBudgetText(subLeadName) {
    return subLeadName === undefined ? "the team's daily budget" : `${subLeadName}'s group's daily budget`;
}
/** Whether a lift is of a session of a team below the lifter's (`<team>/<id>`): no id or name holds a `/`. */
export function isCrossTeamLift(lift) {
    return lift.session.includes('/');
}
function refused(reason) {
    return { kind: 'refused', reason };
}
/** Whether the lift may be given, and when it ends. */
export function decideLift(request, context) {
    const { stopPct, now, reserve } = request;
    const { limits, reset, usedPct, zone } = context;
    if (stopPct === undefined) {
        return refused('a lift needs --stop-pct <n>: the share of the week, in %, at which it ends');
    }
    if (request.partPct + context.liftedPct > 100) {
        const beyond = context.beyondParent === undefined ? '' : `. ${context.beyondParent}`;
        return refused(`the other lifts in force give ${formatPct(context.liftedPct)} of ${context.parent}, so --part ${request.partPct} ` +
            `would give more than all of it; the most this lift may give is ${formatPct(Math.max(0, 100 - context.liftedPct))}${beyond}`);
    }
    if (stopPct > limits.reserveStopPct) {
        return refused(`--stop-pct ${stopPct} is above budget.lift.reserveStopPct (${limits.reserveStopPct}), the most any lift may reach`);
    }
    if (!reserve && stopPct > limits.maxStopPct) {
        return refused(`--stop-pct ${stopPct} is above budget.lift.maxStopPct (${limits.maxStopPct}); only the reserve release ` +
            `(--reserve, in the last hour before the reset) goes up to ${limits.reserveStopPct}`);
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
function newestInForce(lifts, session, group, now, usedPct) {
    const newest = lifts.filter((lift) => lift.session === session && lift.group === group && lift.at <= now).at(-1);
    if (newest === undefined || now >= newest.endsAt || (usedPct !== undefined && usedPct >= newest.stopPct)) {
        return undefined;
    }
    return newest;
}
/** The session's own lift in force at `now`; a lift of the group it leads is not one. */
export function activeLift(lifts, session, now, usedPct) {
    return newestInForce(lifts, session, false, now, usedPct);
}
/** The lift in force at `now` of the group `subLead` leads. */
export function activeGroupLift(lifts, subLead, now, usedPct) {
    return newestInForce(lifts, subLead, true, now, usedPct);
}
/**
 * What a lift gives, after "lifted", on the team's clock, `parent` from `parentBudgetText` and `weekPct` the share of
 * the week its part comes to now (src/budget/parts.ts `liftWeekPctOf`), left out while unknown:
 * `teamrig to 40% of the team's daily budget (2.1% of the week now) today until 18:00 IDT or 97.0% of the week, ...`;
 * a cross-team lift's part is on top of the session's own budget.
 */
export function liftText(lift, name, parent, weekPct, zone) {
    const who = lift.group ? `${name}'s group` : name;
    const week = weekPct === undefined ? '' : ` (${formatPct(weekPct)} of the week now)`;
    const onTop = isCrossTeamLift(lift) ? ' on top of its own budget' : '';
    const quiet = lift.quietHoursExempt ? '; quiet hours do not apply to it' : '';
    return (`${who} to ${formatPct(lift.partPct)} of ${parent}${week}${onTop} today${lift.reserve ? ' from the reserve' : ''} until ` +
        `${formatEndTime(lift.endsAt, zone)} or ${formatPct(lift.stopPct)} of the week, whichever comes first${quiet}.`);
}
/** `Budget: <leader> lifted <session> to ...`, the line that shows a session's lift in force. */
export function liftedLine(lift, name, names, zone) {
    return `Budget: ${names.liftBy ?? lift.by} lifted ${liftText(lift, name, parentBudgetText(names.liftParent), names.liftWeekPct, zone)}`;
}
function liftRecord(lift) {
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
function finitePct(value) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 100;
}
function instantOf(record, key) {
    const text = stringField(record, key);
    const at = text === undefined ? Number.NaN : Date.parse(text);
    return Number.isNaN(at) ? undefined : at;
}
/** One record of format `version` (2 or 3) as a lift; undefined when it is damaged. */
export function parseLift(record, version) {
    const { partPct, stopPct, reserve, quietHoursExempt, group: written } = record;
    const group = version === SESSION_LIFT_FORMAT ? false : written;
    const session = stringField(record, 'session');
    const reason = stringField(record, 'reason');
    const by = stringField(record, 'by');
    const endsAt = instantOf(record, 'endsAt');
    const at = instantOf(record, 'at');
    if (session === undefined ||
        reason === undefined ||
        by === undefined ||
        endsAt === undefined ||
        at === undefined ||
        !finitePct(partPct) ||
        !finitePct(stopPct) ||
        typeof group !== 'boolean' ||
        typeof reserve !== 'boolean' ||
        typeof quietHoursExempt !== 'boolean') {
        return undefined;
    }
    return { session, group, partPct, stopPct, endsAt, reserve, quietHoursExempt, reason, by, at };
}
/** The team's append-only log of lifts, `<state>/usage/lifts.jsonl`, oldest first. */
export class LiftLog {
    files;
    path;
    constructor(files, path) {
        this.files = files;
        this.path = path;
    }
    async read() {
        const parse = parseJsonl((await this.files.read(this.path)) ?? '');
        const lifts = [];
        for (const { record, version } of parse.records) {
            const lift = version === LIFT_FORMAT || version === SESSION_LIFT_FORMAT ? parseLift(record, version) : undefined;
            if (lift !== undefined) {
                lifts.push(lift);
            }
        }
        return { lifts, skipped: parse.unreadable + parse.records.length - lifts.length };
    }
    /** One whole line in one append; refused beside records from a newer teamrig. */
    async append(lift) {
        const text = (await this.files.read(this.path)) ?? '';
        assertWritable(this.path, parseJsonl(text), LIFT_FORMAT);
        const separator = text === '' || text.endsWith('\n') ? '' : '\n';
        await this.files.append(this.path, `${separator}${toJsonlLine(liftRecord(lift))}`);
    }
}
