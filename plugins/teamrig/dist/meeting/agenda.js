import { MS_PER_DAY } from "../core/time.js";
import { cardLines, cardTexts, GATE_FLAG, namedTaskIds } from "../register/card.js";
import { ACTIVE_STATUSES } from "../register/model.js";
import { asksOwner, isUngated, ownerLater } from "../register/owner-waits.js";
import { cut, formatShortTask } from "../register/views.js";
/**
 * The register's part of the daily meeting's agenda, gathered in one call so the lead spends no turn per item:
 * the owner's decisions as card facts, the late tasks and what finished since the meeting before. The CLI adds
 * the stats' top lines above it, and the lead's inbox and the week's use and fit below (src/cli/commands/meeting.ts).
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
/** Text on one line: line breaks and runs of spaces become one space. */
export function oneLine(text) {
    return text.replace(/\s+/g, ' ').trim();
}
function rowOf(task, tree, team) {
    return `  ${formatShortTask(task, TITLE_CHARS, team, tree)}`;
}
/** A list's heading, its first AGENDA_ROWS rows and a `+N more` line naming the command that lists them all. */
export function listed(head, rows, all) {
    const more = rows.length > AGENDA_ROWS ? [`  +${rows.length - AGENDA_ROWS} more: ${all}`] : [];
    return [head, ...rows.slice(0, AGENDA_ROWS), ...more];
}
/**
 * Each other task a decision's texts name, by its title, so no number stands alone: `T5: <title>` (`web/T5` for
 * another team's), or `T5: not in the working set` for one a compaction retired (`show T5` still finds it in the archive).
 */
function namedLines(task, texts, tree, team) {
    return namedTaskIds(texts)
        .filter((id) => id !== task.id)
        .map((id) => {
        const named = tree.task(id);
        return `    ${team === undefined ? id : `${team}/${id}`}: ${named === undefined ? 'not in the working set' : cut(oneLine(named.title), TITLE_CHARS)}`;
    });
}
/** The line of a decision with no card: its owner is asked for one, through its team's lead for another team's. */
function noCardLine(task, team) {
    return team === undefined
        ? `    no card yet: ask ${task.owner} for one (check flags it NO-CARD)`
        : `    no card yet: ${task.owner} owes one, and team ${team}'s check flags it NO-CARD to its lead`;
}
/**
 * A decision's card facts: its row, then what and why, then its card (card.ts) or that it has none, then since when
 * it waits with its newest note, where it was asked, and the title of each other task these name. `tree` is the read
 * of the register that holds the task, and `team` names that register when it is another team's (`web/T5`).
 */
export function cardFacts(task, tree, team) {
    const note = task.note === null ? '' : `: ${cut(oneLine(task.note), NOTE_CHARS)}`;
    const texts = [task.title, task.description ?? '', task.note ?? '', ...(task.card === null ? [] : cardTexts(task.card))];
    return [
        rowOf(task, tree, team),
        ...(task.description === null ? [] : [`    what and why: ${cut(oneLine(task.description), DESCRIPTION_CHARS)}`]),
        ...(task.card === null ? [noCardLine(task, team)] : cardLines(task.card, '    ')),
        `    waiting since ${tree.zone.shortMinute(new Date(task.statusAt))}${note}`,
        ...(task.ref === null ? [] : [`    asked at: ${task.ref}`]),
        ...namedLines(task, texts, tree, team),
    ];
}
/** The card facts of a register's tasks the lead asks the owner now, in its plan order; `team` labels a register under the lead's. */
function decisionCards(tasks, tree, ownerMarker, requireGate, team) {
    return tree.inPlanOrder(tasks.filter((task) => asksOwner(task, ownerMarker, requireGate, tree.context))).map((task) => cardFacts(task, tree, team));
}
/**
 * How the lead, or a session `meet` brings to the owner (src/meeting/meet.ts), asks the owner the cards it read: in
 * plain text, the owner answering in their own words, unless the team asks for the question picker (`decisions.askWith`, T1278).
 */
export function askLine(askWith, ownerMarker) {
    return askWith === 'picker'
        ? "  Ask the choices with the question picker (AskUserQuestion), at most 4 a call: each card's options as its choices, your recommendation first."
        : `  Ask in plain text, never with the question picker: each card's options numbered, your recommendation first; ${ownerMarker} answers in their own words.`;
}
/**
 * How the lead records a card the owner puts off to a date, in place of an answer (T1295); `until` says where it waits
 * meanwhile: the agenda's LATER block, or out of the batches.
 */
export function laterLine(command, ownerMarker, lead, until) {
    return `  A card ${ownerMarker} puts off to a date: ${command} update <id> --later <date> --note "${ownerMarker} put it off: <why>" --session ${lead}; ${until}.`;
}
/**
 * DECISIONS: the tasks waiting on the owner, the lead's team's first, then those of each team under it (T1018), each
 * with its card facts, then how to card, ask and record them. The card form is the owner's: each item readable alone,
 * with the numbers to decide by and one exact action.
 */
function decisionLines(input) {
    const own = decisionCards(input.tasks, input.tree, input.ownerMarker, input.requireGate);
    const below = input.below.flatMap((team) => decisionCards(team.tasks, team.tree, team.ownerMarker, team.requireGate, team.team));
    const head = `DECISIONS ${own.length + below.length} waiting on ${input.ownerMarker} (decision or approval)`;
    if (own.length + below.length === 0) {
        return [head];
    }
    const labelled = below.length === 0 ? '' : ' (<team>/<id> for a task of a team under yours, as its row names it)';
    const handed = below.length === 0 ? '' : ' (and --team <team> for a team under yours)';
    return [
        head,
        ...[...own, ...below].flat(),
        `  Read each card to ${input.ownerMarker} as it stands, each figure explained; where one says no card yet, ask its owner for it (check flags it NO-CARD). Never point to a doc; \`${input.command} show <id>\` prints a task whole.`,
        askLine(input.askWith, input.ownerMarker),
        `  A question a card does not answer is its task owner's to find: ${input.command} add --owner <id>${handed} --due <date> --session ${input.lead}, then relay the answer; never look it up yourself.`,
        `  Record each answer in the same turn: ${input.command} update <id>${labelled} --note "${input.ownerMarker} decided: <decision>" --session ${input.lead}; meeting end tells each task's owner.`,
        laterLine(input.command, input.ownerMarker, input.lead, 'it waits in LATER until then'),
    ];
}
/** The rows of a register's waits the owner put off (ownerLater), in its plan order; `team` labels a register under the lead's. */
function laterRows(tasks, tree, ownerMarker, requireGate, team) {
    return tree.inPlanOrder(tasks.filter((task) => ownerLater(task, ownerMarker, requireGate, tree.context) !== undefined)).map((task) => rowOf(task, tree, team));
}
/**
 * LATER: the waits on the owner put off to a time still to come (T1295), the lead's team's first, then those of each
 * team under it, each row with its time; none is read out, and each comes back to DECISIONS once its time passed. No
 * block when none is put off.
 */
function laterLines(input) {
    const rows = [
        ...laterRows(input.tasks, input.tree, input.ownerMarker, input.requireGate),
        ...input.below.flatMap((team) => laterRows(team.tasks, team.tree, team.ownerMarker, team.requireGate, team.team)),
    ];
    return rows.length === 0
        ? []
        : listed(`LATER ${rows.length} put off by ${input.ownerMarker}: asked once their time passed, never read out before`, rows, `${input.command} list --status waiting`);
}
/**
 * UNGATED: the waits on the owner's decision whose card names no owner gate or business decision (isUngated), each
 * its session's or its leader's to decide, so the lead never reads one out; none while `requireGate` is off, and
 * no block when none waits.
 */
function ungatedLines(input) {
    const ungated = input.requireGate ? input.tree.inPlanOrder(input.tasks.filter((task) => isUngated(task, input.ownerMarker))) : [];
    if (ungated.length === 0) {
        return [];
    }
    return [
        ...listed(`UNGATED ${ungated.length} waiting on ${input.ownerMarker}'s decision with no gate: never read to ${input.ownerMarker}`, ungated.map((task) => rowOf(task, input.tree)), `${input.command} check`),
        `  Each is its session's or its leader's to decide: decide those of the sessions you lead and send each its answer as an inbox line; where an owner gate or a business decision does apply, its owner sets it again with ${GATE_FLAG} "<the owner gate, or business>".`,
    ];
}
/** LATE: the active tasks past their effective due date (their own, or an earlier one of a task that needs them), in plan order. */
function lateLines(input) {
    const { tree } = input;
    const late = tree.inPlanOrder(input.tasks.filter((task) => ACTIVE_STATUSES.includes(task.status) && (tree.dueTime(task) ?? Number.POSITIVE_INFINITY) < input.now));
    return listed(`LATE ${late.length} past their due date`, late.map((task) => rowOf(task, tree)), `${input.command} check`);
}
/** DONE: the tasks done or dropped since the agenda's start, in plan order. */
function doneLines(input) {
    const done = input.tree.inPlanOrder(input.tasks.filter((task) => (task.status === 'done' || task.status === 'dropped') && Date.parse(task.statusAt) >= input.since));
    return listed(`DONE ${done.length} done or dropped since ${input.tree.zone.weekdayMinute(new Date(input.since))}`, done.map((task) => rowOf(task, input.tree)), `${input.command} list --status done,dropped`);
}
/**
 * The register's agenda: the owner's decisions first, as they are what the meeting is for, then those the owner put
 * off and the ungated waits, which are not, then the late tasks, then the finished ones.
 */
export function agendaLines(input) {
    return [...decisionLines(input), ...laterLines(input), ...ungatedLines(input), ...lateLines(input), ...doneLines(input)];
}
