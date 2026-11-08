import { NOW_PRIORITY } from "../config/priorities.js";
/**
 * How the host lock's line is ordered (`delivery.queue.admission`): `pipeline` orders it by urgency, class turn, aged
 * priority and arrival, with a cap on each session's running steps (T2210); `serial` keeps the line in arrival order with
 * no cap, as before T2210, so a team can switch back with one edit.
 */
export const ADMISSION_MODES = ['pipeline', 'serial'];
export function isAdmissionMode(value) {
    return ADMISSION_MODES.some((mode) => mode === value);
}
/** The priority a step counts at when its ticket names none: one with no task, the register lacking its task, or an older kit's. */
export const UNNAMED_PRIORITY = 2;
const MINUTE_MS = 60_000;
/**
 * A step's priority after `waitedMs` in line: one level more urgent per `agingMinutes` waited, so a long wait is not
 * passed for ever, but never p0, which is kept for work that must be done right now; a p0 step stays p0.
 */
export function agedPriority(priority, waitedMs, agingMinutes) {
    const named = priority ?? UNNAMED_PRIORITY;
    if (named <= NOW_PRIORITY.id) {
        return named;
    }
    const levels = agingMinutes > 0 ? Math.floor(Math.max(0, waitedMs) / (agingMinutes * MINUTE_MS)) : 0;
    return Math.max(NOW_PRIORITY.id + 1, named - levels);
}
/** The class a waiter counts in: the one its request names, else the rules' `defaultClass` (an older kit's ticket, or one written without a request). */
export function classOf(waiter, rules) {
    return waiter.request?.class ?? rules.defaultClass;
}
function byName(a, b) {
    if (a.name === b.name) {
        return 0;
    }
    return a.name < b.name ? -1 : 1;
}
/**
 * The line in admission order. `serial` (or no rules): arrival order. `pipeline`: p0 steps first, in arrival order; then
 * the class whose turn it is (least virtual time in `turns`); inside a class, the aged priority; then arrival. A ticket
 * that names no request counts as `defaultClass` at {@link UNNAMED_PRIORITY}. A class `turns` lacks starts at the least
 * virtual time of the waiting classes it has (0 when it has none), so a class that had no step waiting banks no turns.
 */
export function admissionOrder(line, now, rules, turns) {
    const byArrival = [...line].sort(byName);
    if (rules === undefined || rules.mode === 'serial') {
        return byArrival;
    }
    const known = byArrival.flatMap((ticket) => {
        const turn = turns.get(classOf(ticket.waiter, rules));
        return turn === undefined ? [] : [turn];
    });
    const fresh = known.length === 0 ? 0 : Math.min(...known);
    const ranked = byArrival.map((ticket) => {
        const priority = ticket.waiter.request?.priority;
        const rank = {
            urgent: priority !== undefined && priority <= NOW_PRIORITY.id,
            turn: turns.get(classOf(ticket.waiter, rules)) ?? fresh,
            priority: agedPriority(priority, now - Date.parse(ticket.waiter.arrivedAt), rules.agingMinutes),
        };
        return { ticket, rank };
    });
    return ranked.sort((a, b) => compareRanks(a.rank, b.rank) || byName(a.ticket, b.ticket)).map(({ ticket }) => ticket);
}
/** Urgent first; between two urgent ones, neither (arrival decides); else the least turn, then the most urgent aged priority. */
function compareRanks(a, b) {
    if (a.urgent !== b.urgent) {
        return a.urgent ? -1 : 1;
    }
    if (a.urgent) {
        return 0;
    }
    return a.turn - b.turn || a.priority - b.priority;
}
/**
 * The place of the ticket named `name` in `order` (from {@link admissionOrder}), given the steps each session runs now
 * (`running`); undefined when it is not in line. In `pipeline` mode a waiter whose session runs `perSessionRunning`
 * steps is passed, as it may not start anyway; the first waiter not passed is the one that may take its turn, and when
 * it waits on memory or the lock, it holds every later one back. `serial` passes no one.
 */
export function placeInLine(order, name, running, rules) {
    const index = order.findIndex((ticket) => ticket.name === name);
    const mine = order[index];
    if (mine === undefined) {
        return undefined;
    }
    const before = order.slice(0, index);
    if (rules === undefined || rules.mode === 'serial' || rules.perSessionRunning === 0) {
        return { kind: 'inLine', ahead: before };
    }
    const cap = rules.perSessionRunning;
    const runs = (session) => running.get(session) ?? 0;
    const ahead = before.filter((ticket) => runs(ticket.waiter.session) < cap);
    const own = runs(mine.waiter.session);
    return own < cap ? { kind: 'inLine', ahead } : { kind: 'sessionCap', ahead, running: own, cap };
}
