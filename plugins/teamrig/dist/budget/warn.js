import { KIT_NAME } from "../core/home.js";
import { formatUtcDay, isMinuteInSpan, MS_PER_DAY, MS_PER_MINUTE, utcMinuteOf } from "../core/time.js";
import { budgetMarkOf, burstPromptLines, burstStopLines } from "./burst-lines.js";
import { formatPct } from "./format.js";
import { liftText } from "./lift.js";
import { hasRoom } from "./pace.js";
/**
 * The live budget warning, pure: from a session's use today and the team's pace, which line its
 * person sees at a turn's end, which line the model gets with the next prompt, whether the lead gets
 * an inbox line, and whether a helper launch goes ahead, asks the person or is refused. Lines come
 * only at crossings, each once, so a session sees a few a day and none on most turns. A burst's lines
 * (`burst-lines.ts`) come the same way: at its start and end, and the lead's surplus line once a week.
 */
/** Past the last warning level, a line at every further step of this many % of the daily budget. */
export const WARN_STEP_PCT = 25;
const BUDGET_COMMAND = `${KIT_NAME} budget`;
export const MORE = `More: ${BUDGET_COMMAND}`;
export function emptyWarnState(day) {
    return { day, level: 0, modelLevel: 0, ahead: false, held: false, leadTold: false, quietFrom: undefined, liftAt: undefined, burstAt: undefined, modelBurstAt: undefined, surplusShown: undefined };
}
/** The state for `now`'s day: a new day keeps only the quiet-hours, lift and burst marks, which cross midnight. */
function stateFor(state, now) {
    const day = formatUtcDay(new Date(now));
    if (state === undefined) {
        return emptyWarnState(day);
    }
    if (state.day === day) {
        return state;
    }
    const { quietFrom, liftAt, burstAt, modelBurstAt, surplusShown } = state;
    return { ...emptyWarnState(day), quietFrom, liftAt, burstAt, modelBurstAt, surplusShown };
}
/** The session's use today in % of its daily budget; any use counts as past a budget of 0. */
function budgetUsePct(facts) {
    if (facts.budgetPct > 0) {
        return (facts.usedTodayPct / facts.budgetPct) * 100;
    }
    return facts.usedTodayPct > 0 ? Number.POSITIVE_INFINITY : 0;
}
/**
 * The highest warning level reached: one of `warnAtPct`, or past the last of them a further step of
 * `WARN_STEP_PCT`; 0 below the first. Past every level by an unbounded amount, the last level.
 */
export function levelOf(usePct, warnAtPct) {
    const levels = [...warnAtPct].sort((a, b) => a - b);
    const first = levels[0];
    const last = levels.at(-1);
    if (first === undefined || last === undefined || usePct < first) {
        return 0;
    }
    if (usePct < last) {
        return levels.filter((level) => level <= usePct).at(-1) ?? 0;
    }
    return Number.isFinite(usePct) ? last + Math.floor((usePct - last) / WARN_STEP_PCT) * WARN_STEP_PCT : last;
}
const MINUTES_PER_DAY = MS_PER_DAY / MS_PER_MINUTE;
/** The quiet hours `now` falls in, epoch ms; undefined outside them. They may cross midnight. */
export function quietSpanOf(quiet, now) {
    const start = quiet === undefined ? undefined : utcMinuteOf(quiet.startUtc);
    const end = quiet === undefined ? undefined : utcMinuteOf(quiet.endUtc);
    if (start === undefined || end === undefined || start === end) {
        return undefined;
    }
    const dayStart = now - (now % MS_PER_DAY);
    const minute = Math.floor((now - dayStart) / MS_PER_MINUTE);
    if (!isMinuteInSpan(minute, start, end)) {
        return undefined;
    }
    const from = (minute >= start ? dayStart : dayStart - MS_PER_DAY) + start * MS_PER_MINUTE;
    return { from, to: from + ((end - start + MINUTES_PER_DAY) % MINUTES_PER_DAY) * MS_PER_MINUTE };
}
/** True when the session's use today is past its daily budget (its lift's while lifted). */
export function isPastDailyBudget(facts) {
    return budgetUsePct(facts) > 100;
}
/**
 * True when the session is past its daily budget while the team has no room today (its use at or past its in-day
 * pace, `hasRoom`): only then is it held, woken for urgent work alone and escalated as `budget.escalate` says.
 * While the team has room, a session past its part uses room the others left, so no session waits while the week
 * has room.
 */
export function isHeld(facts) {
    return isPastDailyBudget(facts) && !hasRoom(facts.teamDay);
}
/** The quiet hours the session is in; undefined outside them, or while its lift exempts it. */
export function sessionQuietSpan(facts, quiet) {
    return facts.lift?.quietHoursExempt === true ? undefined : quietSpanOf(quiet, facts.now);
}
function standingOf(facts, budget) {
    const usePct = budgetUsePct(facts);
    const over = isPastDailyBudget(facts);
    const held = isHeld(facts);
    const ahead = facts.pace?.state === 'ahead';
    const quiet = sessionQuietSpan(facts, budget.quietHours);
    return { over, level: levelOf(usePct, budget.warnAtPct), ahead, held, escalated: held && (budget.escalate === 'session' || ahead), quiet };
}
/** How strongly an action holds a helper launch back: only "ask" and "block" do. */
function gateRank(action) {
    switch (action) {
        case 'warn':
        case 'ask-lead':
            return 0;
        case 'ask':
            return 1;
        case 'block':
            return 2;
    }
}
/** What happens to new helpers under `action`, as a clause; undefined when nothing does. */
function helperClause(action) {
    switch (action) {
        case 'warn':
        case 'ask-lead':
            return undefined;
        case 'ask':
            return 'new helpers ask first';
        case 'block':
            return 'new helpers are refused';
    }
}
function capitalized(text) {
    return text.charAt(0).toUpperCase() + text.slice(1);
}
function teamText(facts) {
    const pace = facts.pace;
    if (pace === undefined) {
        return `Team: ${formatPct(facts.weekUsedPct)} of the week used.`;
    }
    return `Team: ${formatPct(facts.weekUsedPct)} used, pace line ${formatPct(pace.linePct)}.`;
}
/** "the team is 1.3 points ahead of its pace line" */
function aheadClause(facts) {
    return `the team is ${(facts.pace?.gapPts ?? 0).toFixed(1)} points ahead of its pace line`;
}
/** "the team has used 3.1% of the week today, at or past its in-day pace of 3.0%" */
function noRoomClause(facts) {
    return `the team has used ${formatPct(facts.teamDay.usedPct)} of the week today, at or past its in-day pace of ${formatPct(facts.teamDay.pacePct)}`;
}
/** Why a held session is held: the team has no room today, and the week's pace when it is ahead. */
function heldClause(facts, standing) {
    return standing.ahead ? `${noRoomClause(facts)}, and ${aheadClause(facts)}` : noRoomClause(facts);
}
function roomText(facts) {
    return `The team has room today: ${formatPct(facts.teamDay.usedPct)} of the week used, below its in-day pace of ${formatPct(facts.teamDay.pacePct)}, so nothing more happens.`;
}
/** What escalation does for this session, as sentences; '' with `warn` or for the lead. */
function escalatedText(facts, budget) {
    if (facts.isLead || budget.overAction === 'warn') {
        return '';
    }
    const helpers = helperClause(budget.overAction);
    return helpers === undefined ? 'The lead has an inbox line.' : `${capitalized(helpers)}; the lead has an inbox line.`;
}
function joined(parts) {
    return parts.filter((part) => part !== '').join(' ');
}
/** The line at a new warning level. */
function levelLine(facts, budget, standing) {
    const use = `${facts.name} has used ${formatPct(facts.usedTodayPct)} of the week today; its daily budget is ${formatPct(facts.budgetPct)}${budgetMarkOf(facts)}.`;
    if (!standing.over) {
        return joined([`Budget: ${use}`, teamText(facts), MORE]);
    }
    if (!standing.held) {
        return joined([`Budget: ${use}`, roomText(facts), MORE]);
    }
    if (!standing.escalated) {
        return joined([`Budget: ${use}`, teamText(facts), `${capitalized(noRoomClause(facts))}, but the team is not ahead of its pace line, so nothing more happens.`, MORE]);
    }
    return joined([`Budget: ${use}`, `${capitalized(heldClause(facts, standing))}.`, escalatedText(facts, budget), MORE]);
}
/** The person's line as quiet hours start, their times on the team's clock. */
function quietLine(quiet, span, facts) {
    const helpers = facts.isLead ? undefined : helperClause(quiet.action);
    const what = helpers === undefined ? 'the team rests; start no new work.' : `${helpers}.`;
    return `Quiet hours (${facts.zone.clockSpan(new Date(span.from), new Date(span.to))}): ${what} ${MORE}`;
}
function leadLineOf(facts, standing) {
    return (`${facts.name} is past its daily budget: ${formatPct(facts.usedTodayPct)} of the week today against ${formatPct(facts.budgetPct)}, ` +
        `and ${heldClause(facts, standing)}. ` +
        `It finishes the step in hand; lift it only with a stop %: teamrig budget lift ${facts.id} --part <pct> --stop-pct <pct> --reason "<why>".`);
}
/**
 * The person's lines at a turn's end: a lift or a burst starting or ending, the quiet hours starting, a new
 * warning level, or the session escalating with no new level (the team's room for the day running out, or the
 * team moving ahead of its pace line, while the session is past budget). The lead gets one inbox line a day per
 * session once it escalates, unless the action is only `warn`.
 */
export function stopWarning(facts, budget, previous) {
    const state = stateFor(previous, facts.now);
    const standing = standingOf(facts, budget);
    const lines = [];
    if (facts.lift !== undefined && facts.lift.at !== state.liftAt) {
        lines.push(`Budget: the lead lifted ${liftText(facts.lift, facts.name, facts.zone)}`);
    }
    else if (facts.lift === undefined && state.liftAt !== undefined) {
        lines.push(`Budget: ${facts.name}'s lift has ended; its daily budget is ${formatPct(facts.budgetPct)} again.`);
    }
    const burst = burstStopLines(facts, state);
    lines.push(...burst.lines);
    if (budget.quietHours !== undefined && standing.quiet !== undefined && standing.quiet.from !== state.quietFrom) {
        lines.push(quietLine(budget.quietHours, standing.quiet, facts));
    }
    // A state saved before `held` was kept reads as not held: a session escalated then sees this line once more.
    const wasEscalated = state.held && (budget.escalate === 'session' || state.ahead);
    if (standing.level > state.level) {
        lines.push(levelLine(facts, budget, standing));
    }
    else if (standing.escalated && !wasEscalated) {
        lines.push(joined([`Budget: ${facts.name} is past its daily budget, and ${heldClause(facts, standing)}.`, escalatedText(facts, budget), MORE]));
    }
    const tellLead = standing.escalated && budget.overAction !== 'warn' && !facts.isLead && !state.leadTold;
    return {
        lines,
        leadLine: tellLead ? leadLineOf(facts, standing) : undefined,
        state: {
            day: state.day,
            level: Math.max(state.level, standing.level),
            modelLevel: state.modelLevel,
            ahead: standing.ahead,
            held: standing.held,
            leadTold: state.leadTold || tellLead,
            quietFrom: standing.quiet?.from ?? state.quietFrom,
            liftAt: facts.lift?.at,
            burstAt: burst.burstAt,
            modelBurstAt: state.modelBurstAt,
            surplusShown: state.surplusShown,
        },
    };
}
/** The model's past-budget line, once per warning level while escalated; undefined when none is due. */
function escalationLine(facts, standing, state) {
    if (!standing.escalated || standing.level <= state.modelLevel) {
        return undefined;
    }
    const team = standing.ahead ? ', and it is ahead of its pace line' : '';
    const lift = facts.isLead ? 'As the lead, lift it only with a stop %.' : 'The lead can lift it.';
    return (`${BUDGET_COMMAND}: you are past today's budget and the team has no room left today${team}. Finish the step in hand and start no new work items or helpers. ` +
        `Never skip a test or check to save budget. ${lift}`);
}
/**
 * The model's lines with a prompt, one per line: a burst starting or ending, the lead's surplus once a
 * week, and, while the session has escalated and once per warning level, finish the step in hand and
 * start nothing new. None asks for a cheaper model or effort, nor a skipped check.
 */
export function promptWarning(facts, budget, previous) {
    const state = stateFor(previous, facts.now);
    const standing = standingOf(facts, budget);
    const burst = burstPromptLines(facts, state);
    const escalation = escalationLine(facts, standing, state);
    const lines = escalation === undefined ? burst.lines : [...burst.lines, escalation];
    if (lines.length === 0) {
        return { line: undefined, state };
    }
    return {
        line: lines.join('\n'),
        state: {
            ...state,
            modelLevel: escalation === undefined ? state.modelLevel : standing.level,
            modelBurstAt: burst.modelBurstAt,
            surplusShown: burst.surplusShown,
        },
    };
}
/**
 * Before a helper launch: past budget once escalated, `overAction` applies; in quiet hours,
 * `quietHours.action`; the stronger wins. Only "ask" and "block" hold a launch back. The lead's own
 * helpers and a session under a lift always go ahead: the lead decides, and a lift is its decision.
 */
export function helperGate(facts, budget) {
    if (facts.isLead || facts.lift !== undefined) {
        return { kind: 'allow' };
    }
    const standing = standingOf(facts, budget);
    const reasons = [];
    if (standing.escalated) {
        reasons.push({
            action: budget.overAction,
            text: `${facts.name} is past its daily budget (${formatPct(facts.usedTodayPct)} of the week today against ${formatPct(facts.budgetPct)}), and ${heldClause(facts, standing)}.`,
        });
    }
    const quiet = budget.quietHours;
    if (quiet !== undefined && standing.quiet !== undefined) {
        reasons.push({ action: quiet.action, text: `It is quiet hours (${facts.zone.clockSpan(new Date(standing.quiet.from), new Date(standing.quiet.to))}).` });
    }
    const strongest = Math.max(0, ...reasons.map((reason) => gateRank(reason.action)));
    if (strongest === 0) {
        return { kind: 'allow' };
    }
    const reason = `${BUDGET_COMMAND}: ${reasons.map((each) => each.text).join(' ')} ${strongest === 2 ? 'New helpers are refused' : 'New helpers ask first'}; the lead can lift it. ${MORE}`;
    return { kind: strongest === 2 ? 'deny' : 'ask', reason };
}
