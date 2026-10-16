import { formatWeekdayMinute } from "../budget/format.js";
import { formatUtcMinute, MS_PER_DAY, shortUtc } from "../core/time.js";
import { ACTIVE_STATUSES } from "../register/model.js";
import { byPlanOrder, cut, dueTime, formatShortTask } from "../register/views.js";
/**
 * The register's part of the daily meeting's agenda, gathered in one call so the lead spends no turn per item:
 * the owner's decisions as card facts, the late tasks and what finished since the meeting before. The CLI adds
 * the lead's inbox and the week's use and fit (src/cli/commands/meeting.ts).
 */
/** Each list shows at most this many rows, then a `+N more` line with the command that lists them all. */
export const AGENDA_ROWS = 10;
/** A row cuts the task title to this many characters, as the short `list` does. */
export const TITLE_CHARS = 60;
/** A card cuts a task's description and its newest note to these many characters; `show <id>` prints them whole. */
export const DESCRIPTION_CHARS = 400;
export const NOTE_CHARS = 200;
/**
 * The finished work goes back at most this many days, inside the working set's finished tasks (a compaction
 * keeps them 8 days, src/register/compaction.ts), so the agenda never reads the whole history.
 */
export const DONE_WINDOW_DAYS = 7;
/** When the agenda's finished work starts: the meeting before's end, else a day back, and never past DONE_WINDOW_DAYS. */
export function agendaSince(previousEnd, now) {
    return Math.max(previousEnd ?? now - MS_PER_DAY, now - DONE_WINDOW_DAYS * MS_PER_DAY);
}
/** Whether a waiting task waits for a decision or an approval from the owner. */
export function waitsOnOwner(task, ownerMarker) {
    return task.status === 'waiting' && task.waits.some((reason) => (reason.kind === 'decision' || reason.kind === 'approval') && reason.who === ownerMarker);
}
/** Text on one line: line breaks and runs of spaces become one space. */
export function oneLine(text) {
    return text.replace(/\s+/g, ' ').trim();
}
function rowOf(task, context) {
    return `  ${formatShortTask(task, TITLE_CHARS, undefined, context)}`;
}
/** A list's heading, its first AGENDA_ROWS rows and a `+N more` line naming the command that lists them all. */
function listed(head, rows, all) {
    const more = rows.length > AGENDA_ROWS ? [`  +${rows.length - AGENDA_ROWS} more: ${all}`] : [];
    return [head, ...rows.slice(0, AGENDA_ROWS), ...more];
}
/** A decision's card facts: its row, then what and why, then since when it waits with its newest note, then where it was asked. */
function cardFacts(task, context) {
    const note = task.note === null ? '' : `: ${cut(oneLine(task.note), NOTE_CHARS)}`;
    return [
        rowOf(task, context),
        ...(task.description === null ? [] : [`    what and why: ${cut(oneLine(task.description), DESCRIPTION_CHARS)}`]),
        `    waiting since ${shortUtc(formatUtcMinute(new Date(task.statusAt)))}${note}`,
        ...(task.ref === null ? [] : [`    asked at: ${task.ref}`]),
    ];
}
/**
 * DECISIONS: the tasks waiting on the owner, each with its card facts, then how to card and record them. The
 * card form is the owner's: each item readable alone, with the numbers to decide by and one exact action.
 */
function decisionLines(input) {
    const waiting = input.tasks.filter((task) => waitsOnOwner(task, input.ownerMarker)).sort(byPlanOrder);
    const head = `DECISIONS ${waiting.length} waiting on ${input.ownerMarker} (decision or approval)`;
    if (waiting.length === 0) {
        return [head];
    }
    return [
        head,
        ...waiting.flatMap((task) => cardFacts(task, input.context)),
        `  Card each so ${input.ownerMarker} decides from it alone: what it is and why it matters (1-2 plain lines); the options with their numbers, each figure explained; your recommendation and why; the exact action and what each result leads to. Never point to a doc; \`${input.command} show <id>\` prints a task whole.`,
        `  Record each answer in the same turn: ${input.command} update <id> --note "${input.ownerMarker} decided: <decision>" --session ${input.lead}; meeting end tells each task's owner.`,
    ];
}
/** LATE: the active tasks past their due date, in plan order. */
function lateLines(input) {
    const late = input.tasks.filter((task) => ACTIVE_STATUSES.includes(task.status) && (dueTime(task) ?? Number.POSITIVE_INFINITY) < input.now).sort(byPlanOrder);
    return listed(`LATE ${late.length} past their due date`, late.map((task) => rowOf(task, input.context)), `${input.command} check`);
}
/** DONE: the tasks done or dropped since the agenda's start, in plan order. */
function doneLines(input) {
    const done = input.tasks.filter((task) => (task.status === 'done' || task.status === 'dropped') && Date.parse(task.statusAt) >= input.since).sort(byPlanOrder);
    return listed(`DONE ${done.length} done or dropped since ${formatWeekdayMinute(input.since)}`, done.map((task) => rowOf(task, input.context)), `${input.command} list --status done,dropped`);
}
/** The register's agenda: the owner's decisions first, as they are what the meeting is for, then the late tasks, then the finished ones. */
export function agendaLines(input) {
    return [...decisionLines(input), ...lateLines(input), ...doneLines(input)];
}
