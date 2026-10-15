import { KIT_NAME } from "../core/home.js";
import { formatUtcDay, MS_PER_DAY } from "../core/time.js";
import { formatPct } from "./format.js";
import { liftText } from "./lift.js";
/**
 * The live budget warning, pure: from a session's use today and the team's pace, which line its
 * person sees at a turn's end, which line the model gets with the next prompt, whether the lead gets
 * an inbox line, and whether a helper launch goes ahead, asks the person or is refused. Lines come
 * only at crossings, each once, so a session sees a few a day and none on most turns.
 */
/** Past the last warning level, a line at every further step of this many % of the daily budget. */
export const WARN_STEP_PCT = 25;
const BUDGET_COMMAND = `${KIT_NAME} budget`;
export const MORE = `More: ${BUDGET_COMMAND}`;
export function emptyWarnState(day) {
    return { day, level: 0, modelLevel: 0, ahead: false, leadTold: false, quietFrom: undefined, liftAt: undefined };
}
/** The state for `now`'s day: a new day keeps only the quiet-hours and lift marks, which cross midnight. */
function stateFor(state, now) {
    const day = formatUtcDay(new Date(now));
    if (state === undefined) {
        return emptyWarnState(day);
    }
    return state.day === day ? state : { ...emptyWarnState(day), quietFrom: state.quietFrom, liftAt: state.liftAt };
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
/** Minutes since 00:00 UTC of an `HH:MM`; undefined when malformed. */
function minuteOfDay(text) {
    const match = /^(\d{2}):(\d{2})$/.exec(text);
    if (match === null) {
        return undefined;
    }
    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    return hours < 24 && minutes < 60 ? hours * 60 + minutes : undefined;
}
/** When the quiet hours `now` falls in began, epoch ms; undefined outside them. They may cross midnight. */
export function quietStartOf(quiet, now) {
    const start = quiet === undefined ? undefined : minuteOfDay(quiet.startUtc);
    const end = quiet === undefined ? undefined : minuteOfDay(quiet.endUtc);
    if (start === undefined || end === undefined || start === end) {
        return undefined;
    }
    const dayStart = now - (now % MS_PER_DAY);
    const minute = Math.floor((now - dayStart) / 60_000);
    if (start < end) {
        return minute >= start && minute < end ? dayStart + start * 60_000 : undefined;
    }
    if (minute >= start) {
        return dayStart + start * 60_000;
    }
    return minute < end ? dayStart - MS_PER_DAY + start * 60_000 : undefined;
}
function standingOf(facts, budget) {
    const usePct = budgetUsePct(facts);
    const over = usePct > 100;
    const ahead = facts.pace?.state === 'ahead';
    const quietFrom = facts.lift?.quietHoursExempt === true ? undefined : quietStartOf(budget.quietHours, facts.now);
    return { over, level: levelOf(usePct, budget.warnAtPct), ahead, escalated: over && (budget.escalate === 'session' || ahead), quietFrom };
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
    const use = `${facts.name} has used ${formatPct(facts.usedTodayPct)} of the week today; its daily budget is ${formatPct(facts.budgetPct)}${facts.lift === undefined ? '' : ' (lifted)'}.`;
    if (!standing.over) {
        return joined([`Budget: ${use}`, teamText(facts), MORE]);
    }
    if (!standing.escalated) {
        return joined([`Budget: ${use}`, teamText(facts), 'The team is not ahead of its pace line, so nothing more happens.', MORE]);
    }
    return joined([`Budget: ${use}`, budget.escalate === 'session' ? teamText(facts) : `${capitalized(aheadClause(facts))}.`, escalatedText(facts, budget), MORE]);
}
function quietLine(quiet, facts) {
    const helpers = facts.isLead ? undefined : helperClause(quiet.action);
    const what = helpers === undefined ? 'the team rests; start no new work.' : `${helpers}.`;
    return `Quiet hours (${quiet.startUtc}-${quiet.endUtc} UTC): ${what} ${MORE}`;
}
function leadLineOf(facts) {
    return (`${facts.name} is past its daily budget: ${formatPct(facts.usedTodayPct)} of the week today against ${formatPct(facts.budgetPct)}, ` +
        `and ${aheadClause(facts)}. ` +
        `It finishes the step in hand; lift it only with a stop %: teamrig budget lift ${facts.id} --to <pct> --stop-pct <pct> --reason "<why>".`);
}
/**
 * The person's lines at a turn's end: a lift starting or ending, the quiet hours starting, a new
 * warning level, or the team moving ahead of its pace line while the session is past budget. The
 * lead gets one inbox line a day per session once it escalates, unless the action is only `warn`.
 */
export function stopWarning(facts, budget, previous) {
    const state = stateFor(previous, facts.now);
    const standing = standingOf(facts, budget);
    const lines = [];
    if (facts.lift !== undefined && facts.lift.at !== state.liftAt) {
        lines.push(`Budget: the lead lifted ${liftText(facts.lift, facts.name)}`);
    }
    else if (facts.lift === undefined && state.liftAt !== undefined) {
        lines.push(`Budget: ${facts.name}'s lift has ended; its daily budget is ${formatPct(facts.budgetPct)} again.`);
    }
    if (budget.quietHours !== undefined && standing.quietFrom !== undefined && standing.quietFrom !== state.quietFrom) {
        lines.push(quietLine(budget.quietHours, facts));
    }
    if (standing.level > state.level) {
        lines.push(levelLine(facts, budget, standing));
    }
    else if (standing.escalated && standing.ahead && !state.ahead && budget.escalate === 'session-and-fleet') {
        lines.push(joined([`Budget: ${facts.name} is past its daily budget, and ${aheadClause(facts)}.`, escalatedText(facts, budget), MORE]));
    }
    const tellLead = standing.escalated && budget.overAction !== 'warn' && !facts.isLead && !state.leadTold;
    return {
        lines,
        leadLine: tellLead ? leadLineOf(facts) : undefined,
        state: {
            day: state.day,
            level: Math.max(state.level, standing.level),
            modelLevel: state.modelLevel,
            ahead: standing.ahead,
            leadTold: state.leadTold || tellLead,
            quietFrom: standing.quietFrom ?? state.quietFrom,
            liftAt: facts.lift?.at,
        },
    };
}
/**
 * The model's line with a prompt, while the session has escalated and once per warning level: finish
 * the step in hand and start nothing new. It never asks for a cheaper model or effort, nor a skipped check.
 */
export function promptWarning(facts, budget, previous) {
    const state = stateFor(previous, facts.now);
    const standing = standingOf(facts, budget);
    if (!standing.escalated || standing.level <= state.modelLevel) {
        return { line: undefined, state };
    }
    const team = standing.ahead ? ' and the team is ahead of its pace line' : '';
    const lift = facts.isLead ? 'As the lead, lift it only with a stop %.' : 'The lead can lift it.';
    const line = `${BUDGET_COMMAND}: you are past today's budget${team}. Finish the step in hand and start no new work items or helpers. ` +
        `Never skip a test or check to save budget. ${lift}`;
    return { line, state: { ...state, modelLevel: standing.level } };
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
            text: `${facts.name} is past its daily budget (${formatPct(facts.usedTodayPct)} of the week today against ${formatPct(facts.budgetPct)})${standing.ahead ? ` and ${aheadClause(facts)}` : ''}.`,
        });
    }
    const quiet = budget.quietHours;
    if (quiet !== undefined && standing.quietFrom !== undefined) {
        reasons.push({ action: quiet.action, text: `It is quiet hours (${quiet.startUtc}-${quiet.endUtc} UTC).` });
    }
    const strongest = Math.max(0, ...reasons.map((reason) => gateRank(reason.action)));
    if (strongest === 0) {
        return { kind: 'allow' };
    }
    const reason = `${BUDGET_COMMAND}: ${reasons.map((each) => each.text).join(' ')} ${strongest === 2 ? 'New helpers are refused' : 'New helpers ask first'}; the lead can lift it. ${MORE}`;
    return { kind: strongest === 2 ? 'deny' : 'ask', reason };
}
