import { MS_PER_HOUR } from "../core/time.js";
import { DailyProfile } from "./active-time.js";
import { formatPct } from "./format.js";
import { spanAllowancePct } from "./pace.js";
import { teamShareOf } from "./parts.js";
import { wSince } from "./week.js";
/**
 * A burst: the lead's time-boxed scale-out of named sessions onto helpers and hired sessions, for one of
 * two reasons. `surplus`: the week would end with budget unused, measured as the share of the week
 * projected unused at the pace end at the week's mean rate so far; it starts only from `burst.surplusHours`
 * before the reset, once the team's part of it (`surplusOf`) is at least `burst.minSparePct`, and ends at
 * the pace end.
 * `deadline`: work the user needs by a time; it names its tasks and a stop %, and ends at the deadline or
 * the reset. Every burst ends at its stop % at the latest, never above `budget.targetPct`, so it never
 * spends the reserve. Only a person starts one, by command (`burst.policy`): it spends more of the week.
 * Pure: it takes the clock's now, the week and the caps.
 */
export const BURST_KINDS = ['surplus', 'deadline'];
export function isBurstKind(value) {
    return BURST_KINDS.some((kind) => kind === value);
}
export function isBurst(record) {
    return record.kind !== 'end';
}
/**
 * The week's surplus: the use so far, plus the week's mean rate so far (its use over the time since its
 * start) until the pace end, against the target, and the team's part of what that leaves. The mean counts
 * nights and quiet days alike, so it projects the account's own rhythm; undefined at the week's very start,
 * which has no rate yet.
 */
export function surplusOf(input) {
    const { window, now, usedPct, targetPct, config, teams } = input;
    const elapsed = now - window.start;
    if (elapsed <= 0) {
        return undefined;
    }
    const projectedPct = usedPct + (usedPct / elapsed) * Math.max(0, window.paceEnd - now);
    const accountSparePct = Math.max(0, targetPct - projectedPct);
    const sparePct = teamShareOf(accountSparePct, teams.split, teams.others);
    const opensAt = window.reset - config.surplusHours * MS_PER_HOUR;
    const open = now >= opensAt && now < window.paceEnd;
    return {
        reset: window.reset,
        opensAt,
        paceEnd: window.paceEnd,
        projectedPct,
        sparePct,
        accountSparePct: teams.others.length === 0 ? undefined : accountSparePct,
        open,
        worth: open && sparePct >= config.minSparePct,
    };
}
/** After the team's spare in a line: ", this team's part of the account's 3.0%," when other teams share it; '' for a team alone. */
export function spareShareNote(surplus) {
    return surplus.accountSparePct === undefined ? '' : `, this team's part of the account's ${formatPct(surplus.accountSparePct)},`;
}
function refused(reason) {
    return { kind: 'refused', reason };
}
/** The refusal under `burst.policy`, or undefined when it allows a burst. */
function policyProblem(config, approvedBy) {
    switch (config.policy) {
        case 'off':
            return 'burst.policy is off: the team takes no bursts';
        case 'owner':
            return approvedBy === undefined || approvedBy.trim() === ''
                ? 'burst.policy is owner: a burst spends more of the week, so the owner approves each one; ask them, then pass --approved-by "<who>"'
                : undefined;
        case 'lead':
            return undefined;
    }
}
/** The refusal of the request's helpers and hires, or undefined when the caps allow them. */
function capsProblem(request, config) {
    const helpers = request.helpers ?? config.maxHelpers;
    const hires = request.hires ?? 0;
    if (helpers > config.maxHelpers) {
        return `--helpers ${helpers} is above burst.maxHelpers (${config.maxHelpers})`;
    }
    if (hires > config.maxHires) {
        return `--hires ${hires} is above burst.maxHires (${config.maxHires})`;
    }
    return helpers === 0 && hires === 0 ? 'a burst with no helpers and no hires adds nothing: give --helpers or --hires' : undefined;
}
/** When the burst ends at the latest, or why it cannot start. */
function endOf(request, context, window, usedPct) {
    const { now } = request;
    if (request.kind === 'surplus') {
        const surplus = surplusOf({ window, now, usedPct, targetPct: context.targetPct, config: context.config, teams: context.teams });
        if (surplus === undefined || !surplus.open) {
            const from = context.zone.weekdayMinute(new Date(window.reset - context.config.surplusHours * MS_PER_HOUR));
            return { problem: `a surplus burst starts only from ${from} (burst.surplusHours ${context.config.surplusHours} before the reset) until the pace end` };
        }
        if (!surplus.worth) {
            return {
                problem: `only ${formatPct(surplus.sparePct)} of the week${spareShareNote(surplus)} is projected unused at the pace end, below burst.minSparePct ` +
                    `(${formatPct(context.config.minSparePct)}): there is no surplus to spend`,
            };
        }
        return { endsAt: window.paceEnd };
    }
    if (request.deadline === undefined) {
        return { problem: 'a deadline burst needs --by <time>: when its tasks are due' };
    }
    if (request.deadline <= now) {
        return { problem: `--by ${context.zone.minute(new Date(request.deadline))} has passed` };
    }
    if (request.tasks.length === 0) {
        return { problem: 'a deadline burst needs --task <ids>: the tasks due by --by' };
    }
    return { endsAt: Math.min(request.deadline, window.reset) };
}
/**
 * Each burst session's daily budget floor now, in % of the week, never a fixed number: the team's pace rule
 * (`spanAllowancePct`) over the burst, from what is left to its stop % spread over the active time to its end,
 * shared evenly by its sessions. Their spending ahead lowers it and spending less raises it, so a deadline burst
 * spends to its deadline, neither early nor short.
 */
export function burstFloorPct(burst, pace) {
    const { window, ...reading } = pace;
    return spanAllowancePct({ ...reading, start: window.start, end: burst.endsAt, stopPct: burst.stopPct }) / Math.max(1, burst.sessions.length);
}
/**
 * The sessions' use today inside the week, in % of the week at today's rate (`WeekReading.todayWPerPct`); undefined
 * while the week's limit is unknown.
 */
export function sessionsTodayPct(sessions, week, states, now) {
    return week.todayWPerPct === undefined ? undefined : wSince(sessions.flatMap((id) => states.get(id) ?? []), week.todayFrom, now) / week.todayWPerPct;
}
/**
 * The burst's floor now (`burstFloorPct`), read from the week and its sessions' usage stores; its start reading
 * (`dailyPct`) while the week's window, use or limit is unknown, as nothing newer can be read.
 */
export function burstFloorOf(burst, week, states, budget, now) {
    const { window, usedPct } = week;
    const todayPct = sessionsTodayPct(burst.sessions, week, states, now);
    if (window === undefined || usedPct === undefined || todayPct === undefined) {
        return burst.dailyPct;
    }
    return burstFloorPct(burst, { window, now, usedPct, todayPct, profile: DailyProfile.ofQuietHours(budget.quietHours) });
}
function round2(value) {
    return Math.round(value * 100) / 100;
}
/** Whether the burst may start, and its record. */
export function decideBurst(request, context) {
    const { config, active, targetPct, usedPct, window } = context;
    const policy = policyProblem(config, request.approvedBy);
    if (policy !== undefined) {
        return refused(policy);
    }
    if (request.reason.trim() === '') {
        return refused('a burst needs --reason "<why>"');
    }
    if (active !== undefined) {
        return refused(`a ${active.kind} burst runs until ${context.zone.weekdayMinute(new Date(active.endsAt))} or ${formatPct(active.stopPct)} of the week; end it first: teamrig burst end --reason "<why>"`);
    }
    if (request.sessions.length === 0) {
        return refused('a burst needs at least one session');
    }
    const caps = capsProblem(request, config);
    if (caps !== undefined) {
        return refused(caps);
    }
    if (usedPct === undefined || window === undefined) {
        return refused("the week's use or reset is unknown, so the burst cannot be judged: run teamrig statusline install, or set budget.weeklyLimitW and budget.reset");
    }
    if (request.kind === 'deadline' && request.stopPct === undefined) {
        return refused('a deadline burst needs --stop-pct <n>: the share of the week, in %, at which it ends');
    }
    const stopPct = request.stopPct ?? targetPct;
    if (stopPct > targetPct) {
        return refused(`--stop-pct ${stopPct} is above budget.targetPct (${targetPct}): a burst never spends the reserve`);
    }
    if (usedPct >= stopPct) {
        return refused(`the week is at ${formatPct(usedPct)}, already at or past the stop % ${stopPct}`);
    }
    const end = endOf(request, context, window, usedPct);
    if ('problem' in end) {
        return refused(end.problem);
    }
    const approvedBy = request.approvedBy?.trim();
    return {
        kind: 'burst',
        burst: {
            kind: request.kind,
            sessions: request.sessions,
            helpers: request.helpers ?? config.maxHelpers,
            hires: request.hires ?? 0,
            dailyPct: round2(burstFloorPct({ sessions: request.sessions, stopPct, endsAt: end.endsAt }, { window, now: request.now, usedPct, todayPct: context.sessionsTodayPct ?? 0, profile: context.profile })),
            stopPct,
            endsAt: end.endsAt,
            tasks: request.kind === 'deadline' ? request.tasks : [],
            ...(request.kind === 'deadline' && request.deadline !== undefined ? { deadline: request.deadline } : {}),
            reason: request.reason.trim(),
            ...(approvedBy === undefined || approvedBy === '' ? {} : { approvedBy }),
            by: request.by,
            at: request.now,
        },
    };
}
/** Whether the burst is over at `now`: ended by the lead, by its time or, when the week's use is known, by its stop %. */
export function isBurstOver(burst, records, now, usedPct) {
    if (now >= burst.endsAt || (usedPct !== undefined && usedPct >= burst.stopPct)) {
        return true;
    }
    return records.some((record) => record.kind === 'end' && record.burstAt === burst.at && record.at <= now);
}
/** The burst in force at `now`: the newest one started by now, unless it is over. */
export function activeBurst(records, now, usedPct) {
    const newest = records.filter(isBurst).filter((burst) => burst.at <= now).at(-1);
    return newest === undefined || isBurstOver(newest, records, now, usedPct) ? undefined : newest;
}
/** The `at` of every burst over at `now`, so the hires each one made are due to retire. */
export function burstsOver(records, now, usedPct) {
    return new Set(records
        .filter(isBurst)
        .filter((burst) => isBurstOver(burst, records, now, usedPct))
        .map((burst) => burst.at));
}
/** A session's daily budget with the burst: at least the floor (`burstFloorOf`) for a session in it, else the shared one. */
export function withBurst(shared, floorPct) {
    return floorPct === undefined ? shared : Math.max(shared ?? 0, floorPct);
}
