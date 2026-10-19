import { parseDeadline, showStored, storedText } from "../core/time.js";
import { cardLines } from "./card.js";
import { ACTIVE_STATUSES, GITHUB_SOURCE, priorityText } from "./model.js";
import { planOrder } from "./tree.js";
import { waitsText, weekdayText } from "./waits.js";
import { proofOf, proofText } from "./verify.js";
/** A size as printed: percent of the weekly limit, at most two decimals (`1.5%`). */
export function sizeText(size) {
    return `${Number(size.toFixed(2))}%`;
}
/**
 * The task's own deadline in ms, a stored day read as a day of the team's `zone`; undefined when it has none.
 * {@link TaskTree.dueTime} gives the effective one.
 */
export function dueTime(task, zone) {
    return task.due === null ? undefined : parseDeadline(task.due, zone)?.getTime();
}
/**
 * Plan order on the tasks' own due dates: priority, then due date (undated last), then id. For rows no effective due
 * reaches (finished tasks) and readers with no tree; {@link TaskTree.byPlanOrder} orders active work.
 */
export function byPlanOrder(a, b, zone) {
    return planOrder({ id: a.id, priority: a.priority, at: dueTime(a, zone) }, { id: b.id, priority: b.priority, at: dueTime(b, zone) });
}
/** The tasks that match the filter in plan order; `dueBefore` and the order read the effective due of `tree`. */
export function selectTasks(tasks, filter, tree) {
    const statuses = filter.statuses ?? ACTIVE_STATUSES;
    const dueBefore = filter.dueBefore?.getTime();
    return [...tasks]
        .filter((task) => {
        const due = tree.dueTime(task);
        return (statuses.includes(task.status) &&
            (filter.owner === undefined || task.owner === filter.owner) &&
            (filter.source === undefined || task.source === filter.source) &&
            (filter.priorities === undefined || filter.priorities.includes(task.priority)) &&
            (dueBefore === undefined || (due !== undefined && due < dueBefore)) &&
            (filter.week === undefined || task.week === filter.week) &&
            (filter.goal === undefined || task.goals.includes(filter.goal)));
    })
        .sort((a, b) => tree.byPlanOrder(a, b));
}
/** The task's id, or `<team>/<id>` when a roll-up over a tree of teams names its team. */
export function taskLabel(task, team) {
    return team === undefined ? task.id : `${team}/${task.id}`;
}
/**
 * The fields every task row starts with: `T12 in-progress`, `p2`, `owner alpha`, then `due 01-15` and
 * `after T5,T6` (its plan dependency) when it has them. The due is the effective one of `tree`, in its zone: an
 * earlier due of a task that needs it names that task (`due 01-10 (from T194)`).
 */
function rowHead(task, team, tree) {
    const parts = [`${taskLabel(task, team)} ${task.status}`, priorityText(task.priority), `owner ${task.owner}`];
    const inherited = tree.effectiveDue(task.id);
    if (inherited !== undefined && inherited.from !== null) {
        parts.push(`due ${showStored(inherited.due, tree.zone)} (from ${inherited.from})`);
    }
    else if (task.due !== null) {
        parts.push(`due ${showStored(task.due, tree.zone)}`);
    }
    if (task.after.length > 0) {
        parts.push(`after ${task.after.join(',')}`);
    }
    return parts;
}
/** How long a proof runs in the one-line verify queue before it is cut. */
const SUMMARY_PROOF_CHARS = 60;
/** `VERIFY 2: T1 (proof: ...), T3 (proof: ...)`: a verify queue in one line, each proof cut short; undefined when empty. */
export function formatVerifySummary(queue) {
    const named = queue.map((task) => `${task.id} (proof: ${cut(proofText(task), SUMMARY_PROOF_CHARS)})`);
    return queue.length === 0 ? undefined : `VERIFY ${queue.length}: ${named.join(', ')}`;
}
/** A row of `verify`, times in the team's `zone`: `T1 since 01-07 12:00 IST, verify by 01-09 | <title> (proof: ...)`. */
export function formatVerifyRow(task, zone) {
    const by = task.due === null ? 'no verify-by date' : `verify by ${showStored(task.due, zone)}`;
    return `${task.id} since ${zone.shortMinute(new Date(task.statusAt))}, ${by} | ${task.title} (proof: ${proofText(task)})`;
}
/** The Stop hook's line once a verifying task's verify-by day has come, its time in the team's `zone`. */
export function formatVerifyByLine(task, zone) {
    return `VERIFY ${task.id} was to be verified by ${showStored(task.due ?? '', zone)} (proof: ${proofText(task)}): done with the proof, or back to in-progress`;
}
/** `text` cut to `max` characters, counted in code points so a character is never split, ending in `…` when cut. */
export function cut(text, max) {
    const chars = [...text];
    return chars.length <= max ? text : `${chars.slice(0, max - 1).join('').trimEnd()}…`;
}
/**
 * The short row of `list` and `check`: `T12 in-progress, p2, owner alpha, due 01-15 | <title cut to titleChars>`,
 * what a waiting task waits for: `(waiting: decision owner · on T5 ready)`, and which task of another session needs
 * it (`· needed by T194 (beta, due 01-10) +1`). It keeps what orders and assigns the work, and the issue of a task
 * imported from GitHub (`from gh:acme/web#7`) so it can be found there; it leaves the week, other sources, goals and
 * status note to `show`. `tree` gives the effective due, the ready reasons, the tasks that need it and the zone
 * times show in.
 */
export function formatShortTask(task, titleChars, team, tree) {
    return `${shortRow(task, titleChars, team, tree)}${neededByText(task, tree)}`;
}
/** {@link formatShortTask} without what needs the task: a node of the tree and the start of a waiting-on-you row. */
function shortRow(task, titleChars, team, tree) {
    const waits = task.status === 'waiting' && task.waits.length > 0 ? ` (waiting: ${waitsText(task.waits, tree.zone, tree.context)})` : '';
    const issue = issueOf(task);
    const head = issue === undefined ? rowHead(task, team, tree) : [...rowHead(task, team, tree), `from ${issue}`];
    return `${head.join(', ')} | ${cut(task.title, titleChars)}${waits}`;
}
/**
 * ` · needed by T194 (beta, due 01-10) +1`: the active tasks of other sessions that need an active task, the first
 * the one with the earliest effective due, then in plan order. The due is left out when the row already shows it as
 * `(from T194)`. Empty for a finished task, or when only its owner's own tasks need it.
 */
function neededByText(task, tree) {
    const [first, ...rest] = tree.neededByOthers(task.id);
    if (first === undefined) {
        return '';
    }
    const due = tree.effectiveDue(first.id);
    const shown = due !== undefined && tree.effectiveDue(task.id)?.from === (due.from ?? first.id);
    const facts = due === undefined || shown ? [first.owner] : [first.owner, `due ${showStored(due.due, tree.zone)}`];
    return ` · needed by ${first.id} (${facts.join(', ')})${rest.length > 0 ? ` +${rest.length}` : ''}`;
}
/** The GitHub issue a task was imported from, as its ref (`gh:acme/web#7`); undefined for any other task. */
function issueOf(task) {
    return task.source === GITHUB_SOURCE && task.ref !== null ? task.ref : undefined;
}
/**
 * One line that names each field, so a newcomer can read it:
 * `T12 in-progress, p2, owner alpha, due 01-15, week 01-13, from lead, goals G1 | title`; a task imported from
 * GitHub is `from` its issue (`from gh:acme/web#7`).
 * With `team`, the id reads `<team>/T12`; `tree` gives the effective due, a waiting task's ready reasons and the
 * tasks of other sessions that need it, as in {@link formatShortTask}.
 */
export function formatTask(task, team, tree) {
    const parts = rowHead(task, team, tree);
    if (task.week !== null) {
        parts.push(`week ${showStored(task.week, tree.zone)}`);
    }
    parts.push(`from ${issueOf(task) ?? task.source}`);
    if (task.goals.length > 0) {
        parts.push(`goals ${task.goals.join(',')}`);
    }
    return `${parts.join(', ')} | ${task.title}${statusNote(task, tree)}${neededByText(task, tree)}`;
}
/**
 * What a row adds for a status that waits on something: a waiting task's reasons, then its note
 * (`(waiting: decision owner · on T5; the schema first)`), or what will prove a verifying one.
 */
function statusNote(task, tree) {
    if (task.status === 'waiting') {
        const parts = [task.waits.length > 0 ? waitsText(task.waits, tree.zone, tree.context) : null, task.note].filter((part) => part !== null);
        return parts.length === 0 ? '' : ` (waiting: ${parts.join('; ')})`;
    }
    const proof = task.status === 'verifying' ? proofOf(task) : null;
    return proof === null ? '' : ` (proof: ${proof})`;
}
/** How much of a description an update line in `show`'s history quotes. */
const HISTORY_DESCRIPTION_CHARS = 80;
/**
 * One field of an update, as `show` prints it: a priority reads `p2`, a list joins with commas, and a description is
 * quoted on one line, cut to HISTORY_DESCRIPTION_CHARS (`none` when cleared): `show` prints the whole one above. A due
 * time reads in the team's `zone`.
 */
function changeText(name, value, zone) {
    if (name === 'due' && typeof value === 'string') {
        return storedText(value, zone);
    }
    if (name === 'priority' && typeof value === 'number') {
        return priorityText(value);
    }
    if (name === 'description') {
        return typeof value === 'string' ? JSON.stringify(cut(value.replace(/\s+/g, ' '), HISTORY_DESCRIPTION_CHARS)) : 'none';
    }
    if (name === 'size') {
        return typeof value === 'number' ? sizeText(value) : 'none';
    }
    return Array.isArray(value) ? value.join(',') : String(value);
}
/** One line per event, for `show`, its times in the team's `zone`. */
export function formatEvent(event, zone) {
    const head = `${zone.minute(new Date(event.at))} ${event.by} ${event.type}`;
    const note = 'note' in event && event.note !== null ? ` note="${event.note}"` : '';
    switch (event.type) {
        case 'create': {
            const { task } = event;
            return [
                head,
                `owner=${task.owner}`,
                `source=${task.source}`,
                `priority=${priorityText(task.priority)}`,
                task.ref === null ? undefined : `ref=${task.ref}`,
                task.due === null ? undefined : `due=${storedText(task.due, zone)}`,
                task.week === null ? undefined : `week=${task.week}`,
                task.goals.length === 0 ? undefined : `goals=${task.goals.join(',')}`,
                task.after.length === 0 ? undefined : `after=${task.after.join(',')}`,
                task.size === null ? undefined : `size=${sizeText(task.size)}`,
            ]
                .filter((part) => part !== undefined)
                .join(' ');
        }
        case 'status':
            return [
                `${head} ${event.status}${event.waits === undefined ? '' : ` waits="${waitsText(event.waits, zone)}"`}${note}`,
                event.proof === undefined ? undefined : `proof="${event.proof}"`,
                event.met === undefined ? undefined : `met="${event.met}"`,
                event.evidence === null ? undefined : `evidence=${event.evidence}`,
                event.skill === null ? undefined : `skill=${event.skill}`,
                event.followups === undefined ? undefined : `followups=${event.followups.length === 0 ? 'none' : event.followups.join(',')}`,
            ]
                .filter((part) => part !== undefined)
                .join(' ');
        case 'update': {
            const fields = Object.entries(event.changes).map(([name, value]) => `${name}=${changeText(name, value, zone)}`);
            return `${[head, ...fields].join(' ')}${note}`;
        }
    }
}
/**
 * `show`: the task line, its description (what and why, its later lines indented two spaces), its status details,
 * then its history; `tree` reads the task line as {@link formatTask} does.
 */
export function formatTaskDetail(task, events, tree) {
    const lines = [formatTask(task, undefined, tree)];
    if (task.description !== null) {
        const [first = '', ...rest] = task.description.split('\n');
        lines.push(`description: ${first}`, ...rest.map((line) => (line.trim() === '' ? '' : `  ${line}`)));
    }
    if (task.ref !== null) {
        lines.push(`ref: ${task.ref}`);
    }
    if (task.size !== null) {
        lines.push(`size: ${sizeText(task.size)} of the weekly limit`);
    }
    if (task.note !== null) {
        lines.push(`note: ${task.note}`);
    }
    if (task.card !== null) {
        lines.push('card:', ...cardLines(task.card, '  '));
    }
    if (task.proof !== null) {
        lines.push(`proof: ${task.proof}`);
    }
    if (task.evidence !== null) {
        lines.push(`evidence: ${task.evidence}`);
    }
    if (task.skill !== null) {
        lines.push(`skill: ${task.skill}`);
    }
    if (task.followups.length > 0) {
        lines.push(`followups: ${task.followups.join(', ')}`);
    }
    lines.push('history:', ...events.filter((event) => event.id === task.id).map((event) => `  ${formatEvent(event, tree.zone)}`));
    return lines.join('\n');
}
/**
 * `show --tree`: what the task needs, down to tasks that need nothing unfinished (`needs:`), then the active tasks
 * that need it, up to those nothing needs (`needed by:`), each level indented two more spaces, then
 * {@link formatNextMove}. A finished need ends its branch, and one the read lacks reads `T3 finished` (only a
 * compaction retires a task, and only a finished one). Within a part, a task met again reads `T4 (shown above)`,
 * and one already on its own branch `T2 (loop)`. Needs come in plan order, so the first branch leads to the next move.
 */
export function formatTaskTree(task, tree, titleChars) {
    const node = (id) => {
        const found = tree.task(id);
        return found === undefined ? `${id} finished` : shortRow(found, titleChars, undefined, tree);
    };
    const down = (id) => {
        const found = tree.task(id);
        if (found === undefined || (id !== task.id && !ACTIVE_STATUSES.includes(found.status))) {
            return [];
        }
        const needs = tree.needs(id);
        const known = tree.inPlanOrder(needs.flatMap((need) => tree.task(need) ?? [])).map((need) => need.id);
        return [...known, ...needs.filter((need) => tree.task(need) === undefined)];
    };
    const up = (id) => tree.neededBy(id).map((needer) => needer.id);
    const part = (name, next) => {
        const lines = branchLines(task.id, next, node, new Set([task.id]), [task.id]);
        return lines.length === 0 ? [`${name}: none`] : [`${name}:`, ...lines];
    };
    return [...part('needs', down), ...part('needed by', up), formatNextMove(task, tree)];
}
/** The lines under `id` along `next`, depth first, two spaces deeper per level; see {@link formatTaskTree}. */
function branchLines(id, next, node, shown, path) {
    const indent = '  '.repeat(path.length);
    return next(id).flatMap((child) => {
        if (path.includes(child)) {
            return [`${indent}${child} (loop)`];
        }
        if (shown.has(child)) {
            return [`${indent}${child} (shown above)`];
        }
        shown.add(child);
        return [`${indent}${node(child)}`, ...branchLines(child, next, node, shown, [...path, child])];
    });
}
/**
 * `Next move: beta (T3)`: who moves first so the task can finish, on which task ({@link TaskTree.nextMove}), with
 * `, decision` or `, approval` when the lead or the owner decides, `, from Thu 01-10` when a time must pass first,
 * and `, behind T7 (p1)` when that session works a higher-priority task first. `Next move: none` says why: the task
 * is finished, or what it needs runs in a loop.
 */
export function formatNextMove(task, tree) {
    const move = tree.nextMove(task.id);
    if (move === undefined) {
        return ACTIVE_STATUSES.includes(task.status)
            ? `Next move: none, what ${task.id} needs runs in a loop (check flags it LOOP)`
            : `Next move: none, ${task.id} is ${task.status}`;
    }
    const what = move.kind === 'work' ? '' : move.kind === 'time' ? `, from ${weekdayText(move.at, tree.zone)}` : `, ${move.kind}`;
    const behind = move.behind === undefined ? '' : `, behind ${move.behind.id} (${priorityText(move.behind.priority)})`;
    return `Next move: ${move.who} (${move.task.id})${what}${behind}`;
}
/**
 * A row of the waiting-on-you block: another session's task as its short row, then what it waits on from you:
 * ` · needs your T2, T3` and ` · waits on your decision and approval`.
 */
export function formatWaitingOnYou(entry, titleChars, tree) {
    const needs = entry.needs.length === 0 ? '' : ` · needs your ${entry.needs.map((need) => need.id).join(', ')}`;
    const asks = entry.asks.length === 0 ? '' : ` · waits on your ${entry.asks.map((ask) => ask.kind).join(' and ')}`;
    return `${shortRow(entry.task, titleChars, undefined, tree)}${needs}${asks}`;
}
/**
 * The inbox line a task's new owner gets, under the giver's name, a due time in the team's `zone`:
 * `T5 is yours (p2, due 2030-01-10): Show the signup errors`.
 */
export function assignedNotice(task, zone) {
    const due = task.due === null ? '' : `, due ${storedText(task.due, zone)}`;
    return `${task.id} is yours (${priorityText(task.priority)}${due}): ${task.title}`;
}
/**
 * The inbox line telling the lead that a task now waits on it, or on the owner, whose decision queue the lead keeps:
 * `T2 waits on your approval and the owner's decision: <note>`, the note (else the title) on one line.
 */
export function personWaitNotice(task, waits, lead) {
    const kindsOf = (onLead) => waits.filter((reason) => (reason.who === lead) === onLead).map((reason) => reason.kind);
    const yours = kindsOf(true);
    const owners = kindsOf(false);
    const whose = [yours.length === 0 ? '' : `your ${yours.join(' and ')}`, owners.length === 0 ? '' : `the owner's ${owners.join(' and ')}`];
    return `${task.id} waits on ${whose.filter((part) => part !== '').join(' and ')}: ${(task.card?.question ?? task.note ?? task.title).replace(/\s+/g, ' ')}`;
}
