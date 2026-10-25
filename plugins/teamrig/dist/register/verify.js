import { parseDeadline, showStored } from "../core/time.js";
import { taskNumber } from "./fold.js";
import { needsOf, NO_TASKS_ELSEWHERE } from "./tree.js";
import { allReady, waitContext } from "./waits.js";
/** `Proof: ...` or `Proof = ...` in a note written before `--proof` existed: what follows names the proof. */
const NOTE_PROOF = /\bproof\s*[:=]\s*(.+)$/i;
/** How many due verifies a held start names before it counts the rest. */
const NAMED_DUE = 3;
/**
 * What will prove a verifying task works: its `--proof`; for a task set verifying before `--proof` existed,
 * what its note says after `Proof:`, else the whole note. Read side only: old lines are never rewritten.
 */
export function proofOf(task) {
    if (task.proof !== null || task.note === null) {
        return task.proof;
    }
    const named = NOTE_PROOF.exec(task.note)?.[1]?.trim();
    return named === undefined || named === '' ? task.note : named;
}
/**
 * The tasks a task needs first that are still verifying: its plan dependencies (`after`), then the tasks
 * it waits on, each once. A shipped change is not proven yet, so work built on it waits for the proof.
 */
export function verifyingNeeds(task, tasks) {
    return needsOf(task).flatMap((id) => {
        const needed = tasks.get(id);
        return needed?.status === 'verifying' ? [needed] : [];
    });
}
/** The verifying tasks that hold a status change: only a move into in-progress from another status is held. */
export function startHolds(task, status, tasks) {
    return status === 'in-progress' && task.status !== 'in-progress' ? verifyingNeeds(task, tasks) : [];
}
/** `T2 needs T1, still verifying (proof: ..., owner bravo)`: what holds the start, for the refusal or the warning. */
export function heldStart(task, holds) {
    const named = holds.map((held) => `${held.id}, still verifying (proof: ${proofText(held)}, owner ${held.owner})`);
    return `${task.id} needs ${named.join(', and ')}`;
}
/** The inbox line a held start leaves the verifying task's owner. */
export function heldStartNotice(task, held) {
    return `${task.id} waits on your verifying ${held.id}: ${proofText(held)}`;
}
/** The inbox line a start that named its held proof as met (`--met`) leaves the verifying task's owner. */
export function metStartNotice(task, held, met) {
    return `${task.id} started on your verifying ${held.id}, its proof met: ${met}; set ${held.id} done if that holds, else reopen it`;
}
/** The proof as a line names it: `no proof named` for a task set verifying with neither proof nor note. */
export function proofText(task) {
    return proofOf(task) ?? 'no proof named';
}
/** A session's verifying tasks, oldest first: the order to prove them in. */
export function verifyQueue(tasks, owner) {
    return [...tasks]
        .filter((task) => task.status === 'verifying' && task.owner === owner)
        .sort((a, b) => Date.parse(a.statusAt) - Date.parse(b.statusAt) || taskNumber(a.id) - taskNumber(b.id));
}
/** True once the day of the task's verify-by date, its due date, has come in the team's `zone`. */
export function verifyByArrived(task, now, zone) {
    const by = task.due === null ? undefined : parseDeadline(task.due, zone);
    return by !== undefined && zone.day(by) <= zone.day(now);
}
/**
 * Session `owner`'s verify steps that are due, oldest first. Only a task its owner can act on is due: one whose
 * proof waits on nothing, or on reasons all cleared; one still waiting on another party's work, a time to come or
 * the owner is that party's to move. Such a task is due once its proof's waits cleared (the proof event happened),
 * once its verify-by day has come, or while `owner` holds more than `max` verifying tasks (0: no limit), as one of
 * the oldest it can act on, as many as it holds over `max`.
 */
export function dueVerifies(tasks, owner, context, max) {
    const queue = verifyQueue(tasks, owner);
    const actionable = queue.filter((task) => task.waits.length === 0 || allReady(task.waits, context));
    const over = max > 0 ? queue.length - max : 0;
    return actionable.flatMap((task, index) => {
        const why = dueWhy(task, context) ?? (index < over ? `${queue.length} verifying, over ${max}` : undefined);
        return why === undefined ? [] : [{ task, why }];
    });
}
/** Why an actionable verifying task is due by itself: its proof's waits cleared, or its verify-by day came in the team's zone. */
function dueWhy(task, context) {
    if (task.waits.length > 0) {
        return "proof's waits cleared";
    }
    return task.due !== null && verifyByArrived(task, new Date(context.now), context.zone) ? `verify by ${showStored(task.due, context.zone)}` : undefined;
}
/**
 * The due verify steps that hold a task's first start: new work waits until its owner has verified, reopened,
 * asked for or re-dated each one. Resuming a task already started is never held, nor is any other status. A proof
 * that waits on a task of another register of the team tree reads it in `elsewhere`.
 */
export function dueStartHolds(task, status, tasks, now, zone, max, elsewhere = NO_TASKS_ELSEWHERE) {
    return status === 'in-progress' && task.startedAt === null ? dueVerifies(tasks.values(), task.owner, waitContext(tasks, now, zone, elsewhere), max) : [];
}
/**
 * `T9 is new work; T3 (verify by 01-08), T4 (proof's waits cleared) are due to verify first: ...`, naming up to
 * three of them, then how many more, and the ways to clear each, for the refusal or the warning.
 */
export function dueVerifyHold(task, due) {
    const named = due.slice(0, NAMED_DUE).map((held) => `${held.task.id} (${held.why})`);
    const more = due.length > NAMED_DUE ? ` and ${due.length - NAMED_DUE} more` : '';
    const verb = due.length === 1 ? 'is' : 'are';
    return (`${task.id} is new work; ${named.join(', ')}${more} ${verb} due to verify first (teamrig verify): set each done with its proof, ` +
        'in-progress if it failed, or verifying with --ask or --waits for what its proof waits on; a verify-by date moves with --due and a --note saying why');
}
