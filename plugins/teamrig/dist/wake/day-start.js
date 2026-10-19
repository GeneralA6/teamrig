import { burstText } from "../budget/burst-lines.js";
import { KIT_NAME } from "../core/home.js";
import { formatUtcMinute, MS_PER_DAY, MS_PER_MINUTE, utcMinuteOf } from "../core/time.js";
import { waitContext } from "../register/waits.js";
import { byUrgency, costText, idsText, isWakeWorthy, taskListText } from "./decide.js";
/** The latest day start at or before `now`, epoch ms; undefined for a malformed time. */
export function dayStartAt(dayStartUtc, now) {
    const minute = utcMinuteOf(dayStartUtc);
    if (minute === undefined) {
        return undefined;
    }
    const today = now - (now % MS_PER_DAY) + minute * MS_PER_MINUTE;
    return today <= now ? today : today - MS_PER_DAY;
}
/** The first day start after `now`, epoch ms; undefined for a malformed time. */
export function nextDayStartAt(dayStartUtc, now) {
    const latest = dayStartAt(dayStartUtc, now);
    return latest === undefined ? undefined : latest + MS_PER_DAY;
}
/** The moments reached at `now` and not settled yet: the day start (when set) and the burst the session is in. */
export function dueMoments(now, dayStartUtc, burst, settled) {
    const due = [];
    const dayStart = dayStartUtc === undefined ? undefined : dayStartAt(dayStartUtc, now);
    if (dayStart !== undefined && (settled.dayStart ?? Number.NEGATIVE_INFINITY) < dayStart) {
        due.push({ kind: 'day-start', at: dayStart });
    }
    if (burst !== undefined && burst.at <= now && settled.burst !== burst.at) {
        due.push({ kind: 'burst', at: burst.at, burst });
    }
    return due;
}
/** The session's work it can start now, of any priority, most urgent first. */
export function startableTasks(tasks, session, now) {
    const context = waitContext(tasks, new Date(now));
    return [...tasks.values()].filter((task) => isWakeWorthy(task, session, Number.POSITIVE_INFINITY, context)).sort(byUrgency);
}
function settle(settled, moments) {
    return moments.reduce((kept, moment) => (moment.kind === 'day-start' ? { ...kept, dayStart: moment.at } : { ...kept, burst: moment.at }), settled);
}
/**
 * Whether the due moments wake the session now, later or not, and what is settled. A moment the session had a turn
 * after is settled with no wake. The rest wake it at once, together, unless it rests (quiet hours, past its daily
 * budget) or has no work it can start: then they stay due for a later check. Wakes stay `wake.minGapMinutes` apart.
 */
export function decideDayStart(input) {
    const { due, lastTurnAt, rest, now } = input;
    const hadTurn = (moment) => lastTurnAt !== undefined && lastTurnAt >= moment.at;
    const settled = settle(input.settled, due.filter(hadTurn));
    const open = due.filter((moment) => !hadTurn(moment));
    if (open.length === 0 || rest.quiet || rest.over || input.startable.length === 0) {
        return { verdict: { kind: 'none' }, settled };
    }
    const gapEnd = input.lastWakeAt === undefined ? Number.NEGATIVE_INFINITY : input.lastWakeAt + input.minGapMs;
    if (now < gapEnd) {
        return { verdict: { kind: 'later', at: gapEnd }, settled };
    }
    return { verdict: { kind: 'wake', moments: open, tasks: input.startable }, settled: settle(settled, open) };
}
/** `06:00`: a moment's minute of the day, UTC. */
function minuteText(at) {
    return formatUtcMinute(new Date(at)).slice(11);
}
function momentLine(moment, name) {
    return moment.kind === 'day-start'
        ? `The day started at ${minuteText(moment.at)} UTC and this tab has had no turn since.`
        : `The lead started ${burstText(moment.burst, [name])}`;
}
/** The prompt the session reads, under the plugin's name; `name` is the session's name in the burst's line. */
export function dayStartPrompt(session, name, moments, tasks, cost) {
    return [
        ...moments.map((moment) => momentLine(moment, name)),
        `Work you can start: ${taskListText(tasks)}.`,
        `Start a work block (\`${KIT_NAME} start --session ${session}\`) and work your list in priority order. This wake costs ${costText(cost)}.`,
    ].join(' ');
}
const MOMENT_NAMES = { 'day-start': 'the day start', burst: 'the burst' };
/** The person's toast: which moments woke the tab, for which tasks, and what it costs. */
export function dayStartToast(moments, tasks, cost) {
    const why = moments.map((moment) => MOMENT_NAMES[moment.kind]).join(' and ');
    return `${KIT_NAME} woke this tab for ${why}: ${idsText(tasks)} (${costText(cost)})`;
}
