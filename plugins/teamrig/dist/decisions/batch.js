import { MS_PER_DAY } from "../core/time.js";
import { isImprovementsDay, waitsForWeeklyBatch } from "../meeting/decision-order.js";
import { askableSince, asksOwner, isDedicated } from "../register/owner-waits.js";
import { taskLabel } from "../register/views.js";
/**
 * The owner's decisions, asked in batches: a session that needs one sets its task waiting on the owner's decision or
 * approval, with its card, and goes on with other work; the lead asks the owner the waiting ones together, at its
 * batch times (`decisions.batchTimesUtc`), at the daily meeting, or once `decisions.batchAt` of them wait unasked,
 * and at once only for one due before the next batch. A wait counts as asked when it was set at or before the last
 * batch the lead asked (`decisions asked`, or a meeting's start): a task's `statusAt` stays put while it stays
 * waiting, so setting it waiting again with a new card does not ask it again. A wait the owner put off (Later, T1295)
 * stays out of the batch until its time passed, and then counts from that time (askableSince), so it is asked again.
 * A wait whose decision frees only Improvements work (waitsForWeeklyBatch, the agenda's rule) is asked only on
 * `focus.improvementsDay`: another day it is held, out of the batch and its triggers; on that day only an ask that day
 * asks it, so it is asked again each week while it waits, as the agenda shows it each one. A wait of a session in its
 * register's `decisions.dedicatedOwners` (T868) is in no batch: the owner decides it in that session's own meeting.
 */
/** Milliseconds after midnight UTC of a valid `HH:MM`. */
function offsetOf(time) {
    const [hours = 0, minutes = 0] = time.split(':').map(Number);
    return (hours * 60 + minutes) * 60_000;
}
/** Midnight UTC that starts the day of `now`. */
function utcMidnightOf(now) {
    return Math.floor(now / MS_PER_DAY) * MS_PER_DAY;
}
/** Each batch time on the UTC day of `now` and the days either side of it, in time order. */
function timesAround(now, times) {
    const midnight = utcMidnightOf(now);
    return [midnight - MS_PER_DAY, midnight, midnight + MS_PER_DAY].flatMap((day) => times.map((time) => day + offsetOf(time))).sort((a, b) => a - b);
}
/** The latest batch time at or before `now`; undefined with no batch times. */
export function lastBatchTime(now, times) {
    return timesAround(now, times).findLast((at) => at <= now);
}
/** The first batch time after `now`; undefined with no batch times. */
export function nextBatchTime(now, times) {
    return timesAround(now, times).find((at) => at > now);
}
/** The batch the lead asks the owner next, and whether it is due now. */
export function decisionBatch(input) {
    const { now, askedAt, improvementsDay } = input;
    const today = isImprovementsDay(now, improvementsDay);
    const rows = input.registers.flatMap((register) => rowsOf(register, now, today));
    const held = rows.filter((row) => row.weekly && !today);
    const batched = rows.filter((row) => !row.weekly || today);
    const asked = (row) => askedAt !== undefined && row.since <= askedAt;
    const pending = batched.filter((row) => !asked(row));
    const overdue = batched.filter((row) => asked(row) && (row.wait.tree.dueTime(row.wait.task) ?? Number.POSITIVE_INFINITY) < now);
    const nextAt = nextBatchTime(now, input.config.batchTimesUtc);
    return {
        pending: pending.map(waitOf),
        overdue: overdue.map(waitOf),
        weekly: held.map(waitOf),
        improvementsDay,
        trigger: triggerOf(input, pending, overdue, nextAt),
        nextAt,
    };
}
function waitOf(row) {
    return row.wait;
}
/**
 * The batch's waits that the registers of `teams` hold, its trigger and next time kept: what a child team sees of the
 * batch the lead at its tree's root asks (T1018). A wait of the batch's own register is never one of them.
 */
export function waitsOfTeams(batch, teams) {
    const held = (wait) => wait.team !== undefined && teams.includes(wait.team);
    return { ...batch, pending: batch.pending.filter(held), overdue: batch.overdue.filter(held), weekly: batch.weekly.filter(held) };
}
/**
 * A register's waits the lead asks the owner now (asksOwner) but those of its dedicated sessions, in its plan order,
 * each with its {@link BatchRow} facts.
 */
function rowsOf({ team, tasks, tree, ownerMarker, requireGate, focus, dedicatedOwners }, now, today) {
    const asked = [...tasks].filter((task) => asksOwner(task, ownerMarker, requireGate, tree.context) && !isDedicated(task, dedicatedOwners));
    return tree.inPlanOrder(asked).map((task) => {
        const weekly = waitsForWeeklyBatch(task, tree, focus);
        const since = askableSince(task, tree.context);
        return { wait: { task, team, tree }, weekly, since: weekly && today ? Math.max(since, utcMidnightOf(now)) : since };
    });
}
/**
 * A task's effective due time when it falls before the next batch (a day on when no batch time is set: the next
 * meeting), so the owner must hear it at once; undefined otherwise.
 */
export function dueBeforeNextBatch(task, tree, now, nextAt) {
    const due = tree.dueTime(task);
    return due !== undefined && due < (nextAt ?? now + MS_PER_DAY) ? due : undefined;
}
/**
 * The first reason the batch is due: a pending wait due before the next batch, else `batchAt` pending, else a batch
 * time passed over a wait already pending then or over an overdue one not asked since.
 */
function triggerOf(input, pending, overdue, nextAt) {
    for (const { task, team, tree } of pending.map(waitOf)) {
        const due = dueBeforeNextBatch(task, tree, input.now, nextAt);
        if (due !== undefined) {
            return { kind: 'deadline', task, team, due };
        }
    }
    const { batchAt } = input.config;
    if (batchAt > 0 && pending.length >= batchAt) {
        return { kind: 'count', pending: pending.length, batchAt };
    }
    const last = lastBatchTime(input.now, input.config.batchTimesUtc);
    if (last === undefined) {
        return undefined;
    }
    const missed = pending.some((row) => row.since <= last) || (overdue.length > 0 && (input.askedAt ?? Number.NEGATIVE_INFINITY) < last);
    return missed ? { kind: 'time', at: last } : undefined;
}
/** Why the batch is due, for one line, its times on `zone`'s clock: `T5 is due Tue 01-08 23:59 UTC, before the next batch` (`web/T5` for another team's). */
export function triggerText(trigger, zone) {
    switch (trigger.kind) {
        case 'deadline':
            return `${taskLabel(trigger.task, trigger.team)} is due ${zone.weekdayMinute(new Date(trigger.due))}, before the next batch`;
        case 'count':
            return `${trigger.pending} not yet asked, decisions.batchAt is ${trigger.batchAt}`;
        case 'time':
            return `the ${zone.weekdayMinute(new Date(trigger.at))} batch time passed`;
    }
}
/** When the next batch is, on `zone`'s clock: `the next batch Tue 01-08 13:03 UTC`, or the daily meeting with no batch time set. */
export function nextBatchText(batch, zone) {
    return batch.nextAt === undefined ? 'the next batch at the daily meeting' : `the next batch ${zone.weekdayMinute(new Date(batch.nextAt))}`;
}
