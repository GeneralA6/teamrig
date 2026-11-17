import { NOW_PRIORITY } from "../config/priorities.js";
import { takesShipSlot } from "./process-request.js";
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
/** The line a waiter waits in: small when its ticket says its step is not heavy; a ticket naming no request (an older kit's, or one with none) waits in the heavy line, as all did before T3286. */
export function laneOf(waiter) {
    return waiter.request?.heavy === false ? 'small' : 'heavy';
}
function byName(a, b) {
    if (a.name === b.name) {
        return 0;
    }
    return a.name < b.name ? -1 : 1;
}
/** When a waiter's task was put at the front of the line, in ms; undefined for one never put there, or a time that does not parse. */
function frontOf(waiter) {
    const at = waiter.request?.frontAt;
    const ms = at === undefined ? Number.NaN : Date.parse(at);
    return Number.isNaN(ms) ? undefined : ms;
}
/**
 * The line in admission order. `serial` (or no rules): arrival order. `pipeline`: the steps of a task its lead put at
 * the front (T4082), the earliest put first; then p0 steps, in arrival order; then
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
            front: frontOf(ticket.waiter),
            urgent: priority !== undefined && priority <= NOW_PRIORITY.id,
            turn: turns.get(classOf(ticket.waiter, rules)) ?? fresh,
            priority: agedPriority(priority, now - Date.parse(ticket.waiter.arrivedAt), rules.agingMinutes),
        };
        return { ticket, rank };
    });
    return ranked.sort((a, b) => compareRanks(a.rank, b.rank) || byName(a.ticket, b.ticket)).map(({ ticket }) => ticket);
}
/**
 * Fronted first, the earliest put there first; then urgent; between two urgent ones, neither (arrival decides); else the
 * least turn, then the most urgent aged priority.
 */
function compareRanks(a, b) {
    if (a.front !== undefined || b.front !== undefined) {
        if (a.front === undefined || b.front === undefined) {
            return a.front === undefined ? 1 : -1;
        }
        return a.front - b.front;
    }
    if (a.urgent !== b.urgent) {
        return a.urgent ? -1 : 1;
    }
    if (a.urgent) {
        return 0;
    }
    return a.turn - b.turn || a.priority - b.priority;
}
/** The waits on the host's room a step that fits may pass: its free memory, or its commit charge, too short. */
const ROOM_CAUSES = new Set(['memory', 'commit']);
/**
 * Whether a later step may pass `waiter`, which its last look found waiting on the host's room: always while no queued
 * step runs (`idle`), as only memory outside the queue holds it then and no queued step's end frees room for it; while
 * some run, only for the first `memoryPassMinutes` of that wait, after which it holds the line so that the room their
 * ends free goes to it, and a long wait is not passed for ever. 0 passes no one.
 */
function passesOnRoom(waiter, idle, now, memoryPassMinutes) {
    const wait = waiter.waitingOn;
    if (memoryPassMinutes === 0 || wait === undefined || !ROOM_CAUSES.has(wait.reason)) {
        return false;
    }
    return idle || now - Date.parse(wait.since) < memoryPassMinutes * MINUTE_MS;
}
/**
 * The places in `before` (the waiters ahead) that a later step that does (`mine`) or does not hold the ship slot passes
 * for that slot (T2727): none for a step that holds it, so ships take the slot in their order. Any other step passes
 * the first waiter its last look found waiting on the slot, for as long as the ship ahead runs, as the slot keeps the
 * waiter out whatever ends, and every slot-taking waiter after it, which waits behind that one whatever its own reason
 * (T3336: a second ship waits on the line, not the slot, yet starts no sooner, and held every build and test back).
 */
function passedOnShipSlot(before, mine) {
    const passed = new Set();
    if (mine) {
        return passed;
    }
    let shut = false;
    before.forEach(({ waiter }, at) => {
        const onSlot = waiter.waitingOn?.reason === 'shipSlot';
        shut ||= onSlot;
        if (onSlot || (shut && takesShipSlot(waiter.request?.kind))) {
            passed.add(at);
        }
    });
    return passed;
}
/**
 * The place of the ticket named `name` in `order` (from {@link admissionOrder}) at `now`, given the steps running now
 * (`running`); undefined when it is not in line. In `pipeline` mode a waiter stands only behind the waiters of its own
 * lane ({@link laneOf}, T3286), and three of them are passed: one whose session runs `perSessionRunning` heavy steps,
 * as it may not start anyway (a heavy-line cap: a small step is never held on it), one waiting on the host's memory
 * while it may be passed ({@link passesOnRoom}), as a step that fits need not wait behind one that does not (T2757),
 * and one waiting on the ship slot, with each slot-taking waiter behind it, by a step that does not take it
 * ({@link passedOnShipSlot}, T2727). The first waiter not passed is the one that may take its turn, and while it waits
 * on the lock or memory, it holds every later one of its lane back. A step that passes still waits on its own memory
 * gate. `serial` keeps one line and passes no one.
 */
export function placeInLine(order, name, running, rules, now) {
    const index = order.findIndex((ticket) => ticket.name === name);
    const mine = order[index];
    if (mine === undefined) {
        return undefined;
    }
    if (rules === undefined || rules.mode === 'serial') {
        return { kind: 'inLine', ahead: order.slice(0, index) };
    }
    const lane = laneOf(mine.waiter);
    const before = order.slice(0, index).filter(({ waiter }) => laneOf(waiter) === lane);
    const cap = lane === 'small' ? 0 : rules.perSessionRunning;
    const runs = (session) => running.filter((step) => !step.small && step.session === session).length;
    const capped = (session) => cap > 0 && runs(session) >= cap;
    // Idle means no queued step at all runs: a small step's end frees room too, so it counts here.
    const idle = running.length === 0;
    const onSlot = passedOnShipSlot(before, takesShipSlot(mine.waiter.request?.kind));
    const ahead = before.filter(({ waiter }, at) => !capped(waiter.session) && !passesOnRoom(waiter, idle, now, rules.memoryPassMinutes) && !onSlot.has(at));
    const own = runs(mine.waiter.session);
    return capped(mine.waiter.session) ? { kind: 'sessionCap', ahead, running: own, cap } : { kind: 'inLine', ahead };
}
