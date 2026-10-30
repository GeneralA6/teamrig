import { ruleLabel, ruleNumberOf } from "../rules/keys.js";
import { budgetMarkOf, burstText, MORE_BURST } from "./burst-lines.js";
import { formatCount, formatPct, formatUsd, formatW, isBudgetDayEnd, noRoomText } from "./format.js";
import { liftedLine } from "./lift.js";
import { TURN_TRIGGERS } from "./line.js";
import { hasRoom } from "./pace.js";
import { emptyPatterns, PATTERN_FIELDS } from "./patterns.js";
import { DAYS_KEPT } from "./store.js";
/** The lines of `teamrig budget`: short by default, the key numbers and anything past its budget. */
/** Sessions listed by default; `--all` lists every one. */
export const SESSION_ROWS_SHOWN = 7;
/** Titles of sessions outside the team named by default. */
export const OUTSIDE_TITLES_SHOWN = 5;
/** What a session past its daily budget does: never skip a test or check (G-B1 wording). */
export const OVER_BUDGET_ADVICE = "Finish the step in hand and start no new work items or helpers. Never skip a test or check to save budget. A session's leader can lift its budget.";
export const W_EXPLAINED = 'W = weighted tokens: input 1, cache writes 1.25 to 2, cache reads 0.1, output 5.';
function pctOf(w, week) {
    return week.wPerPct === undefined ? undefined : w / week.wPerPct;
}
/** Today's W in percent of the week, at today's rate (`WeekReading.todayWPerPct`), so the rows add up to the team's day. */
function todayPctOf(w, week) {
    return week.todayWPerPct === undefined ? undefined : w / week.todayWPerPct;
}
function useText(w, calls) {
    return `${formatW(w)} W in ${formatCount(calls)} call${calls === 1 ? '' : 's'}`;
}
/** The week's use and its pace, on the team's clock, and the extra-usage pool: the first line of `budget`, and the last of `start`. */
export function weekLine(week, zone) {
    if (week.usedPct === undefined || week.reset === undefined) {
        return "Week: its use is unknown: no status line reading (run teamrig statusline install) and no budget.weeklyLimitW.";
    }
    const source = week.statusAt === undefined ? ' (metered)' : ` at ${readingTimeText(week.statusAt, week.todayFrom, zone)} (status line)`;
    const pace = week.pace;
    const paceText = pace === undefined
        ? ''
        : `; the pace line is at ${formatPct(pace.linePct)}: ${pace.state === 'on pace' ? 'on pace' : `${Math.abs(pace.gapPts).toFixed(1)} points ${pace.state}`}`;
    return `Week: ${formatPct(week.usedPct)} used${source}${paceText}. Resets ${zone.weekdayMinute(new Date(week.reset))}.${periodText(week, zone)}${poolText(week.pool)}`;
}
/** When the status line reading was taken: its time, and its day too when that was before today's start, so a stale reading shows as stale. */
function readingTimeText(statusAt, todayFrom, zone) {
    const at = new Date(statusAt);
    return statusAt < todayFrom ? zone.shortMinute(at) : zone.clock(at);
}
/**
 * The extra-usage pool (budget/extra.ts) once dollars were added: what is left in dollars and, with its W per dollar,
 * in W, which past 100% of the week sets the team's allowance; nothing without a pool.
 */
function poolText(pool) {
    if (pool === undefined) {
        return '';
    }
    const left = ` Extra usage: ${formatUsd(pool.leftUsd)} of ${formatUsd(pool.addedUsd)} left`;
    if (pool.wPerUsd === undefined || pool.leftW === undefined) {
        return `${left}, in dollars only until two spent readings past 100% (teamrig budget extra --spent <usd>) or budget.extraWPerUsd give its W per dollar.`;
    }
    const from = pool.learned ? 'learned from spent readings' : 'budget.extraWPerUsd';
    return `${left}, about ${formatW(pool.leftW)} W at ${formatW(pool.wPerUsd)} W per dollar (${from}).`;
}
/** Where the use counts from after a reset inside the week (budget/period.ts); nothing for a whole week. */
function periodText(week, zone) {
    const { window, periodKind } = week;
    if (window === undefined || (periodKind !== 'reset' && periodKind !== 'inferred')) {
        return '';
    }
    const found = periodKind === 'inferred' ? ' (found from the metered W)' : '';
    return ` Counted from ${zone.weekdayMinute(new Date(window.start))}, after a reset inside the week${found}.`;
}
/** "<who> used 1.1% of the week today; its daily budget is 1.0%. 7.50M W in 310 calls." */
function useLine(who, w, calls, budgetPct, mark, week, when = 'today') {
    const used = pctOf(w, week);
    if (used === undefined) {
        return `${who} used ${useText(w, calls)} ${when}.`;
    }
    const budget = budgetPct === undefined ? '' : `; its daily budget is ${formatPct(budgetPct)}${mark}`;
    return `${who} used ${formatPct(used)} of the week ${when}${budget}. ${useText(w, calls)}.`;
}
function isPast(w, budgetPct, week) {
    const used = todayPctOf(w, week);
    return used !== undefined && budgetPct !== undefined && used > budgetPct;
}
/**
 * The rows of the sessions with use, busiest first: the first seven, then a count of the rest; with
 * `--all` every one, then the idle ones by name.
 */
function sessionRows(sessions, all, when, row) {
    const used = [...sessions].filter((session) => session.w > 0).sort((a, b) => b.w - a.w);
    const shown = all ? used : used.slice(0, SESSION_ROWS_SHOWN);
    const notes = [];
    if (shown.length < used.length) {
        notes.push(`+${used.length - shown.length} more sessions with use ${when} (--all lists them).`);
    }
    const idle = sessions.filter((session) => session.w === 0).map((session) => session.name);
    if (all && idle.length > 0) {
        notes.push(`No use ${when}: ${idle.join(', ')}.`);
    }
    return { rows: shown.map(row), notes };
}
/** A table's indent under its heading. */
const TABLE_INDENT = '  ';
function indented(lines) {
    return lines.map((line) => `${TABLE_INDENT}${line}`);
}
/**
 * Today's use as a table: the team, each sub-lead's group (its sessions' use summed), then each session, with its use
 * and daily budget in % of the week, its mark (lifted, burst, paused), its W and calls; W and calls alone while the week's W
 * is unknown.
 */
function todayTable(report, teamW, teamCalls) {
    const { week, sessions, groups, all } = report;
    const row = (who, w, calls, budgetPct, mark) => {
        const use = [formatW(w), formatCount(calls)];
        const used = todayPctOf(w, week);
        return used === undefined ? [who, ...use] : [who, formatPct(used), budgetPct === undefined ? '-' : formatPct(budgetPct), mark.trim(), ...use];
    };
    const { rows, notes } = sessionRows(sessions, all, 'today', (session) => row(session.name, session.w, session.calls, session.budgetPct, budgetMarkOf(session.lift, session.inBurst !== undefined, session.paused)));
    const team = row('the team', teamW, teamCalls, report.teamPct, '');
    const groupRows = groups.map((group) => {
        const members = sessions.filter((session) => group.sessions.includes(session.id));
        const w = members.reduce((sum, session) => sum + session.w, 0);
        const calls = members.reduce((sum, session) => sum + session.calls, 0);
        return row(`group ${group.name} (${group.sessions.length})`, w, calls, group.budgetPct, budgetMarkOf(group.lift, false, false));
    });
    if (week.wPerPct === undefined) {
        return ['Today (UTC day):', ...indented([...aligned([['session', 'W', 'calls'], team, ...groupRows, ...rows]), ...notes])];
    }
    const table = aligned([['session', 'used', 'budget', '', 'W', 'calls'], team, ...groupRows, ...rows], ['left', 'right', 'right', 'left', 'right', 'right']);
    return ['Today (UTC day), used and daily budget in % of the week:', ...indented([...table, ...notes])];
}
/**
 * The lifts in force as one block: the terms every lift shares once in its heading, then a row each, group lifts
 * first, with the budget it is a part of while the team has sub-leads, its part, the share of the week that part comes
 * to now ('-' while unknown), its end time and its stop; a lift that lasts the day ends at its UTC midnight.
 */
function liftLines(report) {
    const { sessions, groups, zone } = report;
    const lifts = [
        ...groups.flatMap((group) => (group.lift === undefined ? [] : [{ who: `group ${group.name}`, lift: group.lift, parent: group.liftParent, weekPct: group.liftWeekPct }])),
        ...sessions.flatMap((session) => (session.lift === undefined ? [] : [{ who: session.name, lift: session.lift, parent: session.liftParent, weekPct: session.liftWeekPct }])),
    ];
    if (lifts.length === 0) {
        return [];
    }
    // With no sub-lead every lift is a session's part of the team's budget: no parent column, and none keeps quiet hours.
    const nested = groups.length > 0;
    const parentOf = (parent) => (!nested ? '' : parent === undefined ? 'the team' : `group ${parent}`);
    const rows = lifts.map(({ who, lift, parent, weekPct }) => [
        who,
        parentOf(parent),
        `${formatPct(lift.partPct)}${lift.reserve ? ' (reserve)' : ''}`,
        weekPct === undefined ? '-' : formatPct(weekPct),
        zone.clock(new Date(lift.endsAt)),
        formatPct(lift.stopPct),
    ]);
    const table = aligned([['session', nested ? 'of' : '', 'part', 'week now', 'until', 'stop at'], ...rows], ['left', 'left']);
    const dayEnd = lifts.find(({ lift }) => isBudgetDayEnd(lift.endsAt));
    const notes = dayEnd === undefined ? [] : [`${zone.clock(new Date(dayEnd.lift.endsAt))} is the end of the budget day.`];
    const share = 'the share of the week it comes to now beside it';
    const terms = nested
        ? `a part of the team's or a group's daily budget, ${share}, until its time or its stop % of the week, whichever comes first; ` +
            "quiet hours do not apply to a session's lift, but do to a group's."
        : `a part of the team's daily budget, ${share}, until its time or its stop % of the week, whichever comes first; quiet hours do not apply to them.`;
    return [`Lifts, today only: ${terms}`, ...indented([...table, ...notes])];
}
/** "N Claude Code sessions (titled a, b, +2 more)": the first five titles, or every one with `--all`. */
function outsideSessionsText(outside, all) {
    const shown = all ? outside.titles : outside.titles.slice(0, OUTSIDE_TITLES_SHOWN);
    const more = outside.titles.length - shown.length;
    const titles = shown.length === 0 ? '' : ` (titled ${shown.join(', ')}${more > 0 ? `, +${more} more` : ''})`;
    return `${outside.sessions} Claude Code session${outside.sessions === 1 ? '' : 's'}${titles}`;
}
function outsideLine(outside, all) {
    if (outside.sessions === 0 && outside.w === 0) {
        return undefined;
    }
    return (`Not on the team: ${outsideSessionsText(outside, all)}, ${formatW(outside.w)} W today. ` +
        'A tab counts for a session once it runs teamrig inbox read --session <id> or is named after it.');
}
/**
 * Who is past the daily budget, and what that means: a session past its part is held (finishes the step in hand)
 * only while the team has no room today (`hasRoom`); while it has room, the sessions past their parts are named
 * apart, not held. The team past its part of the account's day has no room. A hold for want of room gives the team's use today
 * against its in-day pace, so it never reads as a fixed cap next to the team's daily budget.
 */
function pastLines(report, teamPast) {
    const { week, sessions } = report;
    const pastSessions = sessions.filter((session) => isPast(session.w, session.budgetPct, week)).map((session) => session.name);
    const teamDay = week.teamDay;
    if (!teamPast && teamDay !== undefined && hasRoom(teamDay)) {
        const room = `Past their part, not held while the team has room today (${formatPct(teamDay.usedPct)} of the week used, ` +
            `below its in-day pace of ${formatPct(teamDay.pacePct)}): ${pastSessions.join(', ')}.`;
        return pastSessions.length > 0 ? [room] : [];
    }
    const past = [...(teamPast ? ['the team'] : []), ...pastSessions];
    // Held for want of room, unless the team is past its part of the account's day, which its row already shows.
    const why = teamPast || teamDay === undefined ? '' : ` (${noRoomText(teamDay)})`;
    return past.length > 0 ? [`Past the daily budget: ${past.join(', ')}${why}. ${OVER_BUDGET_ADVICE}`] : [];
}
/** The sessions a short day pauses and no burst holds up, named even when idle, as `--all` alone shows their rows. */
function pausedLine(sessions) {
    const paused = sessions.filter((session) => session.paused && session.inBurst === undefined).map((session) => session.name);
    return paused.length > 0 ? `Paused today, funded by priority as the week's use is past its pace line (budget.pauseByPriority): ${paused.join(', ')}.` : undefined;
}
/** `teamrig budget`: the week, the team and each session today, lifts, who a short day pauses, use outside the team, and who is past budget. */
export function todayLines(report) {
    const { week, sessions, outside, all, zone } = report;
    const teamW = sessions.reduce((sum, session) => sum + session.w, 0);
    const teamCalls = sessions.reduce((sum, session) => sum + session.calls, 0);
    const lines = [weekLine(week, zone), ...todayTable(report, teamW, teamCalls), ...liftLines(report)];
    const inBurst = sessions.filter((session) => session.inBurst !== undefined);
    const first = inBurst[0]?.inBurst;
    if (first !== undefined) {
        lines.push(`Budget: the lead started ${burstText(first.burst, inBurst.map((session) => session.name), zone, first.floorPct)} ${MORE_BURST}`);
    }
    const paused = pausedLine(sessions);
    if (paused !== undefined) {
        lines.push(paused);
    }
    const outsideText = outsideLine(outside, all);
    if (outsideText !== undefined) {
        lines.push(outsideText);
    }
    if (report.behind.length > 0) {
        lines.push(`Still reading: ${report.behind.join(', ')}; run teamrig budget again for the rest.`);
    }
    lines.push(...pastLines(report, isPast(teamW, report.teamPct, week)));
    if (week.usedPct !== undefined && week.wPerPct === undefined) {
        lines.push('Daily budgets need the week in W: set budget.weeklyLimitW, or let teamrig meter a whole week to estimate it.');
    }
    lines.push(rateLine(week, zone));
    return lines;
}
/** The latest periods whose forecast misses the rate line names. */
const FORECAST_PERIODS_SHOWN = 3;
/** What a W is and, when the week's W per percent is not the configured one, where it comes from and how far it errs. */
function rateLine(week, zone) {
    const { wPerPct, rateFrom } = week;
    const { fit, periods } = week.calibration;
    if (wPerPct === undefined || rateFrom === undefined || rateFrom === 'limit') {
        return W_EXPLAINED;
    }
    if (rateFrom === 'estimate' || fit === undefined) {
        return `${W_EXPLAINED} 1% of the week is about ${formatW(wPerPct)} W, estimated from the status line.`;
    }
    const learned = `${W_EXPLAINED} 1% of the week is about ${formatW(wPerPct)} W, learned from ${formatCount(fit.readings)} meter readings, which it misses by ${fit.errorPts.toFixed(1)} points.`;
    const shown = periods.slice(-FORECAST_PERIODS_SHOWN);
    if (shown.length === 0) {
        return learned;
    }
    const misses = shown.map((period) => `${period.errorPts.toFixed(1)} points in the period from ${zone.day(new Date(period.start)).slice(5)}`);
    return `${learned} Its forecasts missed the status line by ${misses.join(', ')}.`;
}
/** `teamrig budget --day <day>`: that day recounted from the transcripts, with nothing written. */
export function recountLines(day, report) {
    const { sessions, outside, all, week } = report;
    const teamW = sessions.reduce((sum, session) => sum + session.w, 0);
    const teamCalls = sessions.reduce((sum, session) => sum + session.calls, 0);
    const { rows, notes } = sessionRows(sessions, all, 'that day', (session) => useLine(session.name, session.w, session.calls, undefined, '', week, 'that day'));
    const lines = [`${day} (UTC), recounted from the transcripts; nothing was written.`, useLine('The team', teamW, teamCalls, undefined, '', week, 'that day'), ...rows, ...notes];
    if (outside.sessions > 0 || outside.w > 0) {
        lines.push(`Not on the team: ${outsideSessionsText(outside, all)}, ${useText(outside.w, outside.calls)}.`);
    }
    lines.push(W_EXPLAINED);
    return lines;
}
/** `teamrig budget <session>`: its use on each stored day, its budget today and its lift. */
export function sessionLines(session, state, week, zone) {
    const days = Object.keys(state.byDay).sort().reverse();
    const lines = [`${session.name} (${session.id}), by UTC day:`];
    for (const day of days) {
        const usage = state.byDay[day];
        if (usage !== undefined) {
            const used = pctOf(usage.w, week);
            lines.push(`  ${day}  ${useText(usage.w, usage.calls)}${used === undefined ? '' : `, ${formatPct(used)} of the week`}`);
        }
    }
    if (days.length === 0) {
        lines.push('  no use in the last 8 days');
    }
    if (session.budgetPct !== undefined) {
        lines.push(`Its daily budget today is ${formatPct(session.budgetPct)} of the week${budgetMarkOf(session.lift, session.inBurst !== undefined, session.paused)}.`);
    }
    if (session.lift !== undefined) {
        lines.push(liftedLine(session.lift, session.name, session, zone));
    }
    if (session.inBurst !== undefined) {
        lines.push(`Budget: the lead started ${burstText(session.inBurst.burst, [session.name], zone, session.inBurst.floorPct)} ${MORE_BURST}`);
    }
    lines.push(W_EXPLAINED);
    return lines;
}
/** The loop patterns, biggest first in the design's ranking; see `PATTERN_FIELDS` for what each counts. */
export const LOOP_ROWS = [
    { label: 'read after read, W', count: 'readChain', w: 'readChainW' },
    { label: 'edit after edit, W saved', count: 'editChain', w: 'editChainSavedW' },
    { label: 'test after an edit, W saved', count: 'editThenTest', w: 'editThenTestSavedW' },
    { label: '  edit and test in one call', count: 'editTestJoined' },
    { label: 'rerun, piped failure, W', count: 'rerunFailedPiped', w: 'rerunFailedPipedW' },
    { label: 'rerun, full failure, W', count: 'rerunFailedFull', w: 'rerunFailedFullW' },
    { label: 'rerun after a pass, W', count: 'rerunAfterPass', w: 'rerunAfterPassW' },
    { label: 'passing test runs, rent W', count: 'passRuns', w: 'passRentW' },
    { label: '  their output tokens', count: 'passTokens' },
];
/** The sum of several days' or stores' use; one that is undefined adds nothing. */
export function sumUsage(usages) {
    const patterns = emptyPatterns();
    let w = 0;
    let calls = 0;
    for (const usage of usages) {
        if (usage === undefined) {
            continue;
        }
        w += usage.w;
        calls += usage.calls;
        for (const field of PATTERN_FIELDS) {
            patterns[field] += usage.patterns[field];
        }
    }
    return { w, calls, patterns };
}
/** The days' totals over several stores, such as every session's. */
export function sumDays(states, days) {
    return days.map((day) => sumUsage(states.map((state) => state.byDay[day])));
}
/** The turns by what started them, then the cache and compaction counters; see `BURN_FIELDS` for what each counts. */
export const TURN_ROWS = [
    { label: 'owner turns, W', count: 'ownerTurns', w: 'ownerW' },
    { label: 'peer messages, W', count: 'peerTurns', w: 'peerW' },
    { label: 'notifications, W', count: 'notificationTurns', w: 'notificationW' },
    { label: 'scheduled wakes, W', count: 'scheduledTurns', w: 'scheduledW' },
    { label: 'subagent runs, W', count: 'subagentTurns', w: 'subagentW' },
    { label: 'other turns, W', count: 'otherTurns', w: 'otherW' },
];
export const CACHE_ROWS = [
    { label: 'cold calls, cache-write W', count: 'coldCalls', w: 'coldW' },
    { label: 'compactions', count: 'compactions' },
];
/** Read after read's share of a day's W that the burn table sets as the goal to stay under. */
export const READ_CHAIN_GOAL_PCT = 12;
function countRow(row) {
    return {
        label: row.label,
        cell: (usage) => {
            const count = formatCount(usage.patterns[row.count]);
            return row.w === undefined ? count : `${count} ${formatW(usage.patterns[row.w])}`;
        },
    };
}
const ALL_CALLS_ROW = { label: 'all calls', cell: (usage) => `${formatCount(usage.calls)} ${formatW(usage.w)}` };
const NOTHING_METERED = 'nothing metered';
const BEFORE_SORTING = 'metered before teamrig 0.34.0';
/**
 * A table with the days as columns. `leftOut` gives the reason a day is left out, or undefined to show it;
 * the days left out are named under the table by reason, each with the `--day` that reads one.
 */
function dayTable(header, rows, days, totals, leftOut) {
    const shown = [];
    const skipped = new Map();
    for (const [index, day] of days.entries()) {
        const usage = totals[index] ?? { w: 0, calls: 0, patterns: emptyPatterns() };
        const reason = leftOut(usage);
        if (reason === undefined) {
            shown.push({ day, usage });
        }
        else {
            skipped.set(reason, [...(skipped.get(reason) ?? []), day]);
        }
    }
    const notes = [...skipped].map(([reason, each]) => `Left out, ${reason}: ${each.map((day) => day.slice(5)).join(', ')} (add --day ${each[0]} to read one).`);
    if (shown.length === 0) {
        return [header, ...notes];
    }
    const table = [['', ...shown.map(({ day }) => day.slice(5))], ...rows.map((row) => [row.label, ...shown.map(({ usage }) => row.cell(usage))])];
    return [header, ...aligned(table), ...notes];
}
/**
 * A table's rows as lines, each column lined up by its `align`: by default the first on the left, the others on
 * the right. A column empty in every row, its head too, is left out.
 */
function aligned(table, align = []) {
    const columns = Math.max(...table.map((row) => row.length));
    const widths = Array.from({ length: columns }, (_, index) => Math.max(...table.map((row) => (row[index] ?? '').length)));
    const alignOf = (index) => align[index] ?? (index === 0 ? 'left' : 'right');
    return table.map((row) => row
        .flatMap((text, index) => {
        const width = widths[index] ?? 0;
        return width === 0 ? [] : [alignOf(index) === 'left' ? text.padEnd(width) : text.padStart(width)];
    })
        .join('  ')
        .trimEnd());
}
/**
 * `teamrig budget --loops`: each pattern's count and W per day, the days as columns. From the meter's store
 * a day with no calls was never metered (before the meter started, or outside its window), so its column
 * is left out and named under the table; a recounted day (`--day`) was read, so its zeros are shown.
 */
export function loopLines(who, days, totals, source) {
    const leftOut = (usage) => (source === 'metered' && usage.calls === 0 ? NOTHING_METERED : undefined);
    return dayTable(`Loop patterns, ${who}: count, then W (UTC days)`, [...LOOP_ROWS.map(countRow), ALL_CALLS_ROW], days, totals, leftOut);
}
/** The W of a day's turns sorted by what started them; 0 for a day metered before 0.34.0 sorted them. */
function sortedW(usage) {
    return TURN_TRIGGERS.reduce((sum, trigger) => sum + usage.patterns[`${trigger}W`], 0);
}
/**
 * `teamrig budget --burn`: where each day's W came from, the days as columns: the turns each trigger
 * started and their W, calls that re-wrote most of their context to the cache, compactions, and read after
 * read's share of the W. A stored day metered before 0.34.0 sorted its turns is left out and named, like one
 * with nothing metered; on the day of the upgrade the W metered before it shows as not sorted.
 */
export function burnLines(who, days, totals, source) {
    const leftOut = (usage) => {
        if (source === 'recounted') {
            return undefined;
        }
        if (usage.calls === 0) {
            return NOTHING_METERED;
        }
        return sortedW(usage) === 0 ? BEFORE_SORTING : undefined;
    };
    const readShare = (usage) => (usage.w > 0 ? formatPct((usage.patterns.readChainW / usage.w) * 100) : '-');
    const rows = [
        ...TURN_ROWS.map(countRow),
        { label: 'not sorted (before 0.34.0), W', cell: (usage) => formatW(Math.max(0, usage.w - sortedW(usage))) },
        ...CACHE_ROWS.map(countRow),
        { label: `read after read, % of W (goal < ${READ_CHAIN_GOAL_PCT}%)`, cell: readShare },
        ALL_CALLS_ROW,
    ];
    return dayTable(`Burn, ${who}: count, then W (UTC days)`, rows, days, totals, leftOut);
}
/** The version that began counting rule misses: a day metered before it has none to show. */
const MISSES_SINCE = '0.87.0';
const BEFORE_MISSES = `metered before teamrig ${MISSES_SINCE}`;
/** `misses/chances`: the misses of a rule out of the times it applied. */
function ratioCell(misses, chances) {
    return (usage) => `${formatCount(usage.patterns[misses])}/${formatCount(usage.patterns[chances])}`;
}
/** Helpers' W as a share of all W, rule 8's measure of work handed to helpers. */
function helperShare(usage) {
    return usage.w > 0 ? formatPct((usage.patterns.subagentW / usage.w) * 100) : '-';
}
/** The rule misses, by rule; see `MISS_FIELDS` for what each counts. */
export const MISS_ROWS = [
    { short: `${ruleNumberOf('register')} start`, label: `${ruleLabel('register')}: work blocks without teamrig start`, cell: ratioCell('missNoStart', 'workBlocks') },
    {
        short: `${ruleNumberOf('register')} followups`,
        label: `${ruleLabel('register')}: --followups none, work left named`,
        cell: ratioCell('missFollowupWords', 'followupsNone'),
    },
    {
        short: `${ruleNumberOf('worktrees')} worktree`,
        label: `${ruleLabel('worktrees')}: plain git worktree remove`,
        cell: ratioCell('missGitWorktreeRemove', 'worktreeRemoves'),
    },
    { short: `${ruleNumberOf('lean-calls')} helpers`, label: `${ruleLabel('lean-calls')}: helpers' share of W`, cell: helperShare },
    { short: 'heavy', label: 'tests and builds outside teamrig heavy', cell: ratioCell('missHeavyOutside', 'heavySteps') },
    { short: 'npx', label: 'npx or dlx that fetches a package', cell: (usage) => formatCount(usage.patterns.missAdHocFetch) },
];
/** The calls read for misses out of all calls: fewer on a day metered partly before `MISSES_SINCE`. */
function readCell(usage) {
    return `${formatCount(usage.patterns.missCalls)}/${formatCount(usage.calls)}`;
}
/**
 * `teamrig budget <session> --misses`: each rule's misses out of its chances per day, the days as columns.
 * A day the meter never read is left out like `--loops` leaves it, and so is one metered before misses
 * were counted, whose zeros would read as no miss; a recounted day (`--day`) shows what it read.
 */
export function missLines(who, days, totals, source) {
    const leftOut = (usage) => {
        if (source === 'recounted') {
            return undefined;
        }
        if (usage.calls === 0) {
            return NOTHING_METERED;
        }
        return usage.patterns.missCalls === 0 ? BEFORE_MISSES : undefined;
    };
    const rows = [...MISS_ROWS, { label: 'calls read for misses', cell: readCell }, ALL_CALLS_ROW];
    return dayTable(`Rule misses, ${who}: misses/chances (UTC days)`, rows, days, totals, leftOut);
}
/**
 * `teamrig budget --misses`: each session's misses out of its chances, summed over `days`, one row per
 * session that made a call. Its last column is the calls read for misses out of all calls, so a session
 * metered partly before `MISSES_SINCE` shows how much of it was read.
 */
export function missMatrixLines(days, sessions) {
    const first = days[0] ?? '';
    const last = days[days.length - 1] ?? first;
    const span = first === last ? first : `${first} to ${last}`;
    const header = `Rule misses per session, misses/chances, ${span} (UTC)`;
    const active = sessions.filter((session) => session.usage.calls > 0);
    if (active.length === 0) {
        return [header, 'Nothing metered.'];
    }
    const table = [['', ...MISS_ROWS.map((row) => row.short), 'read'], ...active.map(({ name, usage }) => [name, ...MISS_ROWS.map((row) => row.cell(usage)), readCell(usage)])];
    const legend = MISS_ROWS.map((row) => `${row.short} = ${row.label}`).join('; ');
    return [header, ...aligned(table), `${legend}; read = calls read for misses. One session by day: teamrig budget <session> --misses.`];
}
/**
 * `teamrig budget --task T<n>` (T734): the W each session's turns spent on a task per UTC day, the most first,
 * then how much of today's W went to some task.
 */
export function taskLines(use, reading) {
    const { week, today } = reading;
    const window = `the ${DAYS_KEPT} UTC days the meter keeps`;
    const lines = [];
    if (use.sessions.length === 0) {
        lines.push(`${use.task}: no W in ${window}; a turn counts for it when a call names it: ${use.task} in a command, t${use.task.slice(1)}- in a branch or path.`);
    }
    else {
        const pct = pctOf(use.w, week);
        const share = pct === undefined ? '' : `, ${formatPct(pct)} of the week`;
        lines.push(`${use.task}: ${formatW(use.w)} W${share}, in ${window}, open turns' share included:`);
        const rows = use.sessions.map(({ session, byDay, w }) => {
            const sessionPct = pctOf(w, week);
            const days = Object.entries(byDay)
                .map(([day, dayW]) => `${day.slice(5)} ${formatW(dayW)}`)
                .join(', ');
            return [`  ${reading.nameOf(session)}`, `${formatW(w)} W`, ...(sessionPct === undefined ? [] : [formatPct(sessionPct)]), days];
        });
        lines.push(...aligned(rows));
    }
    if (today.w > 0) {
        lines.push(`Today turns that named a task spent ${formatPct((today.attributed / today.w) * 100)} of all metered W; the rest went to turns that named none and to helpers.`);
    }
    return [...lines, W_EXPLAINED];
}
