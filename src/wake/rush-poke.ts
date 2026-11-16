import type { Rush } from '../budget/burst.ts';
import { KIT_NAME } from '../core/home.ts';
import type { DetachedRunRecord } from '../delivery/detached-runs.ts';
import type { LedgerRecord } from '../delivery/ledger.ts';
import { taskOfLabel } from '../delivery/process-request.ts';
import type { Task } from '../register/fold.ts';
import { costText, type WakeCost } from './decide.ts';

/**
 * The poke (T2865): while a rush is on, a tab that sits idle with work left is woken to go on with it, so the team
 * keeps working the goal at full speed without a person watching every tab. The check is code the mod runs at an idle
 * prompt (`hook wake-check`), so it costs no tokens while every tab is busy.
 * Pure.
 */

/** What the poke judges a tab by. */
export interface PokeInput {
  /** The rush in force, if any: without one nothing is poked. */
  readonly rush: Rush | undefined;
  /** The session's tasks it can go on with now (`startableTasks`), most urgent first. */
  readonly startable: readonly Task[];
  /** When the tab last wrote its transcript (its last turn), epoch ms; undefined: unknown, never poked. */
  readonly lastTurnAt: number | undefined;
  readonly now: number;
  /** `rush.pokeAfterMinutes`, in ms. */
  readonly idleMs: number;
  /** The last poke of the session, epoch ms (`SettledMoments.poke`). */
  readonly lastPokeAt: number | undefined;
  /** The tasks a queued run of the session is for, waiting for its turn or running (`queuedTasksOf`). */
  readonly queued: ReadonlySet<string>;
}

export type PokeVerdict =
  | { readonly kind: 'none' }
  | { readonly kind: 'later'; readonly at: number }
  | { readonly kind: 'poke'; readonly task: Task; readonly idleMs: number };

/**
 * The owner's "work left": an open or in-progress task, not one waiting or verifying whose waits cleared, since a
 * verifying task's proof time passing is not a reason to wake a tab in a rush.
 */
function isWorkLeft(task: Task): boolean {
  return task.status === 'open' || task.status === 'in-progress';
}

/** The task a poke names: the most urgent one tagged with the rush's goal, else the most urgent. */
function topTaskOf(tasks: readonly Task[], goal: string): Task | undefined {
  return tasks.find((task) => task.goals.includes(goal)) ?? tasks[0];
}

/**
 * Whether to poke the tab now, later, or not at all. One poke per idle stretch: a poke at or after the tab's last turn
 * blocks another until the tab has a new turn, so a tab that ignores a poke (or whose poke was dropped) is not poked
 * again and again. Nothing is due past the rush's end. A task with a queued run of the session is not poked for: its
 * next move is that run's end, whose line wakes the tab anyway. Poking for one cost a tab about 281k W each idle
 * stretch while its ship gate waited in line and it had nothing else to do (T3168); its other work is still poked for.
 */
export function decideRushPoke(input: PokeInput): PokeVerdict {
  const { rush, lastTurnAt, now, idleMs, lastPokeAt, queued } = input;
  if (rush === undefined || lastTurnAt === undefined) {
    return { kind: 'none' };
  }
  const task = topTaskOf(input.startable.filter((candidate) => isWorkLeft(candidate) && !queued.has(candidate.id)), rush.goal);
  if (task === undefined || (lastPokeAt !== undefined && lastPokeAt >= lastTurnAt)) {
    return { kind: 'none' };
  }
  const dueAt = lastTurnAt + idleMs;
  if (dueAt >= rush.endsAt) {
    return { kind: 'none' };
  }
  return now < dueAt ? { kind: 'later', at: dueAt } : { kind: 'poke', task, idleMs: now - lastTurnAt };
}

/** What a session had at its last poke, kept with that poke (`SettledMoments.pokeMark`), so a later check sees what changed. */
export interface PokeMark {
  /** The lines in its inbox. */
  readonly lines: number;
  /** The ids of the tasks it could start. */
  readonly startable: readonly string[];
}

/** What a check sees of the session now, weighed against its last poke's mark. */
export interface PokeNow {
  readonly session: string;
  /** The lines in its inbox. */
  readonly lines: number;
  /** The tasks it can start now (`startableTasks`). */
  readonly startable: readonly Task[];
  /** The tasks it owns. */
  readonly own: readonly Task[];
}

/** The mark a poke keeps: what the session had when it was poked. */
export function pokeMarkOf(now: PokeNow): PokeMark {
  return { lines: now.lines, startable: now.startable.map((task) => task.id) };
}

/**
 * Whether something changed for the session since its last poke at `pokedAt`: a line posted to its inbox (a queued
 * run's end posts one), a register event on one of its tasks by anyone else (a new task, a handover, an answer, an
 * approval), or a task it can start that it could not then (a time wait or an `after` cleared). Its own note or
 * status write is no change. A session that answered a poke with "nothing can move" and left its task open was poked
 * again every idle span, a full wake each time, for the same state (T3407). With no mark (a poke kept before marks
 * were), anything counts as a change, as before.
 */
export function changedSincePoke(mark: PokeMark | undefined, pokedAt: number, now: PokeNow): boolean {
  if (mark === undefined) {
    return true;
  }
  const before = new Set(mark.startable);
  return (
    now.lines !== mark.lines ||
    now.own.some((task) => task.updatedBy !== now.session && Date.parse(task.updatedAt) > pokedAt) ||
    now.startable.some((task) => !before.has(task.id))
  );
}

/**
 * True when a queued step of the session holds the host now: its start is in the ledger with no end, started within
 * `maxRunMs` (a step is killed by then, so an older open start is one whose process died without its end). A step
 * still waiting in line for the host has no start yet, so it does not count: the tab can work on meanwhile.
 */
export function stepRunningFor(records: readonly LedgerRecord[], session: string, now: number, maxRunMs: number): boolean {
  const ended = new Set<string>();
  const started = new Map<string, number>();
  for (const record of records) {
    if (record.type !== 'heavy' || record.session !== session) {
      continue;
    }
    if (record.endedAt === null) {
      started.set(record.id, Date.parse(record.startedAt));
    } else {
      ended.add(record.id);
    }
  }
  return [...started].some(([id, at]) => !ended.has(id) && now - at < maxRunMs);
}

/**
 * The tasks `session`'s queued runs are for: the task each run's label names (`taskOfLabel`), the one
 * `teamrig queue --task` defaults to. A run whose label names no task is for none.
 */
export function queuedTasksOf(runs: readonly DetachedRunRecord[], session: string): ReadonlySet<string> {
  const tasks = new Set<string>();
  for (const run of runs) {
    const task = run.session === session ? taskOfLabel(run.what) : undefined;
    if (task !== undefined) {
      tasks.add(task);
    }
  }
  return tasks;
}

function minutesText(ms: number): string {
  return `${Math.round(ms / 60_000)} min`;
}

/** The prompt a poke submits: why the tab was woken, and the task to go on with. */
export function rushPokePrompt(session: string, rush: Rush, task: Task, idleMs: number, cost: WakeCost): string {
  return [
    `Rush on ${rush.goal}: this tab sat idle ${minutesText(idleMs)} with work left and no queued step of its own running.`,
    `Start or continue ${task.id} (${task.title}) now, or your top task if another comes first; a run still waiting in the queue is no reason to wait.`,
    `If nothing can move, set it waiting with its reason (\`${KIT_NAME} set ${task.id} --session ${session} --status waiting --waits <reason> --note "..."\`): no poke comes again until something changes for you. This poke costs ${costText(cost)}.`,
  ].join(' ');
}

/** The person's toast for a poke. */
export function rushPokeToast(rush: Rush, task: Task, idleMs: number, cost: WakeCost): string {
  return `${KIT_NAME} poked this tab (rush on ${rush.goal}, idle ${minutesText(idleMs)}): ${task.id} (${costText(cost)})`;
}
