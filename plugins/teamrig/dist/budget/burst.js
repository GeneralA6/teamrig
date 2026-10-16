import { formatUtcMinute, MS_PER_DAY, MS_PER_HOUR } from "../core/time.js";
import { formatPct, formatWeekdayMinute } from "./format.js";
/**
 * A burst: the lead's time-boxed scale-out of named sessions onto helpers and hired sessions, for one of
 * two reasons. `surplus`: the week would end with budget unused, measured as the share of the week
 * projected unused at the pace end at the week's mean rate so far; it starts only from `burst.surplusHours`
 * before the reset, once at least `burst.minSparePct` is projected unused, and ends at the pace end.
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
 * start) until the pace end, against the target. The mean counts nights and quiet days alike, so it
 * projects the team's own rhythm; undefined at the week's very start, which has no rate yet.
 */
export function surplusOf(input) {
    const { window, now, usedPct, targetPct, config } = input;
    const elapsed = now - window.start;
    if (elapsed <= 0) {
        return undefined;
    }
    const projectedPct = usedPct + (usedPct / elapsed) * Math.max(0, window.paceEnd - now);
    const sparePct = Math.max(0, targetPct - projectedPct);
    const opensAt = window.reset - config.surplusHours * MS_PER_HOUR;
    const open = now >= opensAt && now < window.paceEnd;
    return { reset: window.reset, opensAt, paceEnd: window.paceEnd, projectedPct, sparePct, open, worth: open && sparePct >= config.minSparePct };
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
        const surplus = surplusOf({ window, now, usedPct, targetPct: context.targetPct, config: context.config });
        if (surplus === undefined || !surplus.open) {
            const from = formatWeekdayMinute(window.reset - context.config.surplusHours * MS_PER_HOUR);
            return { problem: `a surplus burst starts only from ${from} (burst.surplusHours ${context.config.surplusHours} before the reset) until the pace end` };
        }
        if (!surplus.worth) {
            return {
                problem: `only ${formatPct(surplus.sparePct)} of the week is projected unused at the pace end, below burst.minSparePct ` +
                    `(${formatPct(context.config.minSparePct)}): there is no surplus to spend`,
            };
        }
        return { endsAt: window.paceEnd };
    }
    if (request.deadline === undefined) {
        return { problem: 'a deadline burst needs --by <time>: when its tasks are due' };
    }
    if (request.deadline <= now) {
        return { problem: `--by ${formatUtcMinute(new Date(request.deadline))} UTC has passed` };
    }
    if (request.tasks.length === 0) {
        return { problem: 'a deadline burst needs --task <ids>: the tasks due by --by' };
    }
    return { endsAt: Math.min(request.deadline, window.reset) };
}
/** Each burst session's daily budget: what is left to the stop %, shared by its sessions over its days (one at least). */
export function burstDailyPct(stopPct, usedPct, sessions, ms) {
    const days = Math.max(1, ms / MS_PER_DAY);
    return Math.round(((stopPct - usedPct) / Math.max(1, sessions) / days) * 100) / 100;
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
        return refused(`a ${active.kind} burst runs until ${formatWeekdayMinute(active.endsAt)} or ${formatPct(active.stopPct)} of the week; end it first: teamrig burst end --reason "<why>"`);
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
            dailyPct: burstDailyPct(stopPct, usedPct, request.sessions.length, end.endsAt - request.now),
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
/** A session's daily budget with the burst: at least the burst's for a session in it, else the shared one. */
export function withBurst(shared, burst, id) {
    return burst !== undefined && burst.sessions.includes(id) ? Math.max(shared ?? 0, burst.dailyPct) : shared;
}
