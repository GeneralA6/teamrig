import { NOW_PRIORITY } from '../config/priorities.ts';
import { takesShipSlot, type LineRequest } from './process-request.ts';
import type { WaitCause } from './wait-cause.ts';

/**
 * How the host lock's line is ordered (`delivery.queue.admission`): `pipeline` orders it by urgency, class turn, aged
 * priority and arrival, with a cap on each session's running steps (T2210); `serial` keeps the line in arrival order with
 * no cap, as before T2210, so a team can switch back with one edit.
 */
export const ADMISSION_MODES = ['pipeline', 'serial'] as const;

export type AdmissionMode = (typeof ADMISSION_MODES)[number];

export function isAdmissionMode(value: unknown): value is AdmissionMode {
  return ADMISSION_MODES.some((mode) => mode === value);
}

/** What orders the host lock's line: the team's `delivery.queue` admission keys and its `focus.defaultClass`. */
export interface AdmissionRules {
  readonly mode: AdmissionMode;
  /** A waiting step's priority rises one level per this many minutes waited, never to p0; 0 ages nothing. */
  readonly agingMinutes: number;
  /**
   * A later step passes one waiting on the host's memory or commit charge: always while no queued step runs, and for
   * this many minutes of that wait while some do; 0 passes no one ({@link placeInLine}).
   */
  readonly memoryPassMinutes: number;
  /**
   * A session with this many heavy steps running (the lock or a heavy share) waits for one to end, and later steps pass
   * it; its small steps are neither counted nor held, as they wait in their own line; 0 caps nothing.
   */
  readonly perSessionRunning: number;
  /** In pipeline mode, how many heavy steps share the host at once, memory allowing; serial mode runs one at a time. */
  readonly maxHeavyParallel: number;
  /** In pipeline mode, how many small steps share the host at once, memory allowing (T3286). */
  readonly maxSmallParallel: number;
  /** The class a ticket that names none counts as: an older kit's, or one written without a request. */
  readonly defaultClass: string;
}

/**
 * Where the host lock reads the rules its line is ordered by, once per look (T2942): a step waits in line for hours, so
 * rules read once at its launch would keep it on a cap the team has since raised.
 */
export interface AdmissionSource {
  rules(): Promise<AdmissionRules>;
}

/** The priority a step counts at when its ticket names none: one with no task, the register lacking its task, or an older kit's. */
export const UNNAMED_PRIORITY = 2;

const MINUTE_MS = 60_000;

/**
 * A step's priority after `waitedMs` in line: one level more urgent per `agingMinutes` waited, so a long wait is not
 * passed for ever, but never p0, which is kept for work that must be done right now; a p0 step stays p0.
 */
export function agedPriority(priority: number | undefined, waitedMs: number, agingMinutes: number): number {
  const named = priority ?? UNNAMED_PRIORITY;
  if (named <= NOW_PRIORITY.id) {
    return named;
  }
  const levels = agingMinutes > 0 ? Math.floor(Math.max(0, waitedMs) / (agingMinutes * MINUTE_MS)) : 0;
  return Math.max(NOW_PRIORITY.id + 1, named - levels);
}

/**
 * Each work class's virtual time in the class turns (`class-turns.ts`): the minutes its steps ran times 100 over its
 * allocation percent, a 0% class counting as 1%. The class with the least goes next among the classes with a step
 * waiting.
 */
export type ClassTurns = ReadonlyMap<string, number>;

/** A ticket in the line as admission reads it: its name, which sorts in arrival order, and its waiter's session, arrival and request. */
export interface InLine {
  readonly name: string;
  readonly waiter: {
    readonly session: string;
    readonly arrivedAt: string;
    /** Its line request, and whether its step is heavy (`heavy`, which its ticket says; left out, the step counts as heavy). */
    readonly request?: Pick<LineRequest, 'priority' | 'class'> & Partial<Pick<LineRequest, 'kind' | 'frontAt'>> & { readonly heavy?: boolean };
    /** What its last look found it waiting on, and since when; left out before its first look. */
    readonly waitingOn?: { readonly reason: WaitCause; readonly since: string };
  };
}

/** The class a waiter counts in: the one its request names, else the rules' `defaultClass` (an older kit's ticket, or one written without a request). */
export function classOf(waiter: InLine['waiter'], rules: Pick<AdmissionRules, 'defaultClass'>): string {
  return waiter.request?.class ?? rules.defaultClass;
}

/**
 * The two lines of `pipeline` admission (T3286): small steps (`teamrig queue --small`, a lint or a spec run of a minute
 * or two) and the rest, the heavy steps and those that take the whole host. A small step waits only behind small ones,
 * so a long heavy line never holds a lint for hours.
 */
export type Lane = 'small' | 'heavy';

/** The line a waiter waits in: small when its ticket says its step is not heavy; a ticket naming no request (an older kit's, or one with none) waits in the heavy line, as all did before T3286. */
export function laneOf(waiter: InLine['waiter']): Lane {
  return waiter.request?.heavy === false ? 'small' : 'heavy';
}

/** A step running now as admission counts it: its session, and whether it is a small step's share (T3286). */
export interface RunningStep {
  readonly session: string;
  readonly small: boolean;
}

function byName(a: InLine, b: InLine): number {
  if (a.name === b.name) {
    return 0;
  }
  return a.name < b.name ? -1 : 1;
}

/** How one ticket ranks: when its task was put at the front (ms; undefined when it was not), p0 or not, its class's turn, its aged priority. */
interface Rank {
  readonly front: number | undefined;
  readonly urgent: boolean;
  readonly turn: number;
  readonly priority: number;
}

/** When a waiter's task was put at the front of the line, in ms; undefined for one never put there, or a time that does not parse. */
function frontOf(waiter: InLine['waiter']): number | undefined {
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
export function admissionOrder<T extends InLine>(line: readonly T[], now: number, rules: AdmissionRules | undefined, turns: ClassTurns): T[] {
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
    const rank: Rank = {
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
function compareRanks(a: Rank, b: Rank): number {
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

/**
 * Where a ticket stands in the admission order: the waiters ahead of it that it may not pass (`inLine`), or, when its own
 * session already runs its cap of steps, that it waits for one of them to end (`sessionCap`) while later steps pass it.
 */
export type Place<T> =
  | { readonly kind: 'inLine'; readonly ahead: readonly T[] }
  | { readonly kind: 'sessionCap'; readonly ahead: readonly T[]; readonly running: number; readonly cap: number };

/** The waits on the host's room a step that fits may pass: its free memory, or its commit charge, too short. */
const ROOM_CAUSES: ReadonlySet<WaitCause> = new Set<WaitCause>(['memory', 'commit']);

/**
 * Whether a later step may pass `waiter`, which its last look found waiting on the host's room: always while no queued
 * step runs (`idle`), as only memory outside the queue holds it then and no queued step's end frees room for it; while
 * some run, only for the first `memoryPassMinutes` of that wait, after which it holds the line so that the room their
 * ends free goes to it, and a long wait is not passed for ever. 0 passes no one.
 */
function passesOnRoom(waiter: InLine['waiter'], idle: boolean, now: number, memoryPassMinutes: number): boolean {
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
function passedOnShipSlot(before: readonly InLine[], mine: boolean): ReadonlySet<number> {
  const passed = new Set<number>();
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
export function placeInLine<T extends InLine>(order: readonly T[], name: string, running: readonly RunningStep[], rules: AdmissionRules | undefined, now: number): Place<T> | undefined {
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
  const runs = (session: string): number => running.filter((step) => !step.small && step.session === session).length;
  const capped = (session: string): boolean => cap > 0 && runs(session) >= cap;
  // Idle means no queued step at all runs: a small step's end frees room too, so it counts here.
  const idle = running.length === 0;
  const onSlot = passedOnShipSlot(before, takesShipSlot(mine.waiter.request?.kind));
  const ahead = before.filter(({ waiter }, at) => !capped(waiter.session) && !passesOnRoom(waiter, idle, now, rules.memoryPassMinutes) && !onSlot.has(at));
  const own = runs(mine.waiter.session);
  return capped(mine.waiter.session) ? { kind: 'sessionCap', ahead, running: own, cap } : { kind: 'inLine', ahead };
}
