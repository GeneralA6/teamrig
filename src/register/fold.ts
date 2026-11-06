import type { DecisionCard } from './card.ts';
import type { ProblemReview } from './review.ts';
import type { ApprovalVerdict, RegisterEvent, SizeBase, TaskFields, UpdateEvent } from './events.ts';
import { WAIT_STATUSES, type TaskStatus } from './model.ts';
import { namesNewWait, type WaitReason } from './waits.ts';

/** The lead's answer to a task's approval wait (T684), as `approve` wrote it. */
export interface ApprovalAnswer {
  readonly verdict: ApprovalVerdict;
  readonly by: string;
  readonly at: string;
  /** What the lead checked, or why it declined. */
  readonly note: string | null;
}

/** The owner's decision on a task's card (T1366), as a leader recorded it with `decide`. */
export interface OwnerDecision {
  /** The leader who recorded it. */
  readonly by: string;
  readonly at: string;
  /** What the owner decided. */
  readonly note: string | null;
}

/** A task as the event log describes it after replaying every event in write order. */
export interface Task extends TaskFields {
  readonly id: string;
  readonly status: TaskStatus;
  /** The note, evidence and skill of the latest status change; evidence carries over when a change gives none. */
  readonly note: string | null;
  readonly evidence: string | null;
  readonly skill: string | null;
  /**
   * What the task waits for while `waiting`, or what its proof waits for while `verifying` (WAIT_STATUSES), from its
   * latest status change; empty in any other status.
   */
  readonly waits: readonly WaitReason[];
  /** What a wait on a decision or an approval asks (card.ts), from its latest status change; null otherwise. */
  readonly card: DecisionCard | null;
  /**
   * The lead's latest answer to the approval the task waits on, since its latest status change; null otherwise. A new
   * status clears it with the waits, so an approval covers the push or merge asked for and nothing after it.
   */
  readonly answer: ApprovalAnswer | null;
  /**
   * The owner's decision on the task's card, recorded by a leader since its latest status change (T1366); null
   * otherwise. Its waits lost the owner's, so the next meeting asks it no more, and its owner goes on from the
   * decision; a new status clears it with the waits.
   */
  readonly decided: OwnerDecision | null;
  /**
   * What will prove a `verifying` task works, from its latest status change; null in any other status, and on a
   * task set verifying before `--proof` existed, whose note says it (`proofOf` in verify.ts reads both).
   */
  readonly proof: string | null;
  /**
   * What a sighting shows once the change runs live, from its latest status change when that closed it `done` with
   * `--watch` (T1306): `verify` lists it until the owner sets it done again without one, or reopens it; null otherwise.
   */
  readonly watch: string | null;
  /**
   * How many times in a row its proof was put off: a verifying status on a task already verifying with waits, naming a
   * wait it did not have, adds one (a task naming its first waits is parked, not re-parked, and one dropping a cleared
   * wait puts nothing off); any other status starts again at 0.
   */
  readonly reparks: number;
  /** Every task its status changes named as left by the work (`--followups`), in the order first named. */
  readonly followups: readonly string[];
  /** A bug's review (review.ts): every part its status changes gave, a later one replacing it; empty when none. */
  readonly review: ProblemReview;
  /**
   * What the task had cost when the update that gave its current size was written (T649), which OVER-SIZE counts
   * from; null when it got its size at creation, or from a teamrig before T649, when all it cost counts.
   */
  readonly sizeBase: SizeBase | null;
  /** When the task first went in progress (or verifying): only a started task can wait on another task. */
  readonly startedAt: string | null;
  readonly createdAt: string;
  readonly createdBy: string;
  /** The newest event on the task, and who wrote it. */
  readonly updatedAt: string;
  readonly updatedBy: string;
  /** When the current owner got the task: its creation, or the latest owner change. */
  readonly assignedAt: string;
  /** When the task took its current status: its creation, or the latest status event that changed it. */
  readonly statusAt: string;
  /**
   * When the task last asked for something new: its creation, or the latest event naming a wait it did not hold, or
   * naming its waits again after an answer, since that status clears the answer and asks anew (T2089). `statusAt` cannot
   * say this: a task waiting days on another task that adds a leader's approval keeps its status, and an update replaces
   * waits with no status at all. A wait dropped leaves it. Read from the log, never stored, so it needs no event format.
   */
  readonly waitsAt: string;
  /** When the task took its current priority: its creation, or the latest update that changed it. */
  readonly priorityAt: string;
  /** The current owner's newest event on the task since it was assigned, if any. */
  readonly ownerSeenAt: string | null;
}

export interface RegisterState {
  readonly tasks: ReadonlyMap<string, Task>;
  /** Events for an unknown id or a second create for an id: kept on disk, ignored here. */
  readonly orphans: number;
  /** The id the next create gets. */
  readonly nextId: string;
  /** Tasks that moved to another team (T1144), by id: the team whose register holds them now. */
  readonly moved: ReadonlyMap<string, string>;
}

/** The numeric part of a task id (`T12` → 12). */
export function taskNumber(id: string): number {
  return Number(id.slice(1));
}

/**
 * Replays events in write order, one at a time. A task's state depends on its own events only, so
 * replaying one task's events gives the same task as replaying the whole log: a compaction keeps the
 * events of the tasks it keeps and nothing else (compaction.ts). A moved event takes its task out of the
 * register: the id is the other team's from then on, and any event on it here is an orphan, a create too.
 */
export class RegisterFold {
  private readonly tasks: Map<string, Task>;
  private readonly moved: Map<string, string>;
  private orphans: number;
  private maxId: number;

  /**
   * `from`: the state to go on from (its tasks are copied, never changed). `seenIds` are ids found on
   * lines that did not parse (damaged or newer records): they still count towards the next id, so an
   * id is never handed out twice.
   */
  constructor(from?: RegisterState, seenIds: readonly string[] = []) {
    this.tasks = new Map(from?.tasks);
    this.moved = new Map(from?.moved);
    this.orphans = from?.orphans ?? 0;
    const floor = from === undefined ? 0 : taskNumber(from.nextId) - 1;
    this.maxId = seenIds.reduce((max, id) => Math.max(max, taskNumber(id)), floor);
  }

  /** Applies one event; false when it names no task, creates one twice or names one that moved: an orphan, counted and ignored. */
  apply(event: RegisterEvent): boolean {
    this.maxId = Math.max(this.maxId, taskNumber(event.id));
    if (this.moved.has(event.id)) {
      return this.orphan();
    }
    const current = this.tasks.get(event.id);
    if (event.type === 'create') {
      if (current !== undefined) {
        return this.orphan();
      }
      this.tasks.set(event.id, created(event.id, event.task, event.at, event.by));
      return true;
    }
    if (current === undefined) {
      return this.orphan();
    }
    if (event.type === 'moved') {
      this.tasks.delete(event.id);
      this.moved.set(event.id, event.to);
      return true;
    }
    this.tasks.set(event.id, event.type === 'status' ? withStatus(current, event) : withChanges(current, event));
    return true;
  }

  /** The state so far. Its maps are copies, so later events never change a state already handed out. */
  state(): RegisterState {
    return { tasks: new Map(this.tasks), orphans: this.orphans, nextId: `T${this.maxId + 1}`, moved: new Map(this.moved) };
  }

  private orphan(): false {
    this.orphans += 1;
    return false;
  }
}

/** Replays events in write order, from an empty register or from `from`; `seenIds` as in RegisterFold. */
export function foldEvents(events: readonly RegisterEvent[], seenIds: readonly string[] = [], from?: RegisterState): RegisterState {
  const fold = new RegisterFold(from, seenIds);
  events.forEach((event) => fold.apply(event));
  return fold.state();
}

function created(id: string, fields: TaskFields, at: string, by: string): Task {
  return {
    ...fields,
    id,
    status: 'open',
    note: null,
    evidence: null,
    skill: null,
    waits: [],
    card: null,
    answer: null,
    decided: null,
    proof: null,
    watch: null,
    reparks: 0,
    followups: [],
    review: {},
    sizeBase: null,
    startedAt: null,
    createdAt: at,
    createdBy: by,
    updatedAt: at,
    updatedBy: by,
    assignedAt: at,
    statusAt: at,
    waitsAt: at,
    priorityAt: at,
    ownerSeenAt: by === fields.owner ? at : null,
  };
}

function withStatus(task: Task, event: Extract<RegisterEvent, { type: 'status' }>): Task {
  const waits = WAIT_STATUSES.includes(event.status) ? (event.waits ?? []) : [];
  return {
    ...task,
    status: event.status,
    statusAt: event.status === task.status ? task.statusAt : event.at,
    waitsAt: namesNewWait(task.answer === null ? task.waits : [], waits) ? event.at : task.waitsAt,
    note: event.note,
    evidence: event.evidence ?? task.evidence,
    skill: event.skill,
    waits,
    card: WAIT_STATUSES.includes(event.status) ? (event.card ?? null) : null,
    answer: null,
    decided: null,
    proof: event.status === 'verifying' ? (event.proof ?? null) : null,
    watch: event.status === 'done' ? (event.watch ?? null) : null,
    reparks: reparksAfter(task, event),
    followups: event.followups === undefined ? task.followups : [...new Set([...task.followups, ...event.followups])],
    review: event.review === undefined ? task.review : { ...task.review, ...event.review },
    startedAt: task.startedAt ?? (event.status === 'in-progress' || event.status === 'verifying' ? event.at : null),
    updatedAt: event.at,
    updatedBy: event.by,
    ownerSeenAt: event.by === task.owner ? event.at : task.ownerSeenAt,
  };
}

/** True when setting `status` with `waits` re-parks the task's proof, as {@link Task.reparks} counts it. */
export function isRepark(task: Task, status: TaskStatus, waits: readonly WaitReason[]): boolean {
  return status === 'verifying' && task.status === 'verifying' && task.waits.length > 0 && namesNewWait(task.waits, waits);
}

function reparksAfter(task: Task, event: Extract<RegisterEvent, { type: 'status' }>): number {
  if (event.status !== 'verifying') {
    return 0;
  }
  return isRepark(task, event.status, event.waits ?? []) ? task.reparks + 1 : task.reparks;
}

/**
 * An update's note from the task's owner is its note from then on, as a restated one on `set` is, so show and the
 * waiting text print it at once; a note from any other session adds context to the history only, since the note a
 * task shows is its owner's (T630). An update with a `verdict` is the lead's answer to the task's approval wait, its
 * note what the lead checked (T684). An update's `waits` (a Later, T1295, or a Decided, T1366) replace a waiting or
 * verifying task's, so the time the owner put it off to is one of its waits, or the owner's wait is gone; a Decided
 * marks the task `decided`. On a task in any other status they mean nothing. A pin holds for the owner it was set for:
 * handing the task on clears it, unless the same update pins it (T637). An update that gives a size, or clears it,
 * gives its size base too (T649).
 */
function withChanges(task: Task, { changes, note, at, by, verdict, waits, decided, sizeBase }: UpdateEvent): Task {
  const priorityAt = changes.priority === undefined || changes.priority === task.priority ? task.priorityAt : at;
  const shown = note !== null && by === task.owner ? note : task.note;
  const answer = verdict === undefined ? task.answer : { verdict, by, at, note };
  const waitable = WAIT_STATUSES.includes(task.status);
  const kept = waits !== undefined && waitable ? waits : task.waits;
  const decision = decided === true && waitable ? { by, at, note } : task.decided;
  const base = changes.size === undefined ? task.sizeBase : (sizeBase ?? null);
  const next: Task = {
    ...task,
    ...changes,
    note: shown,
    answer,
    decided: decision,
    waits: kept,
    waitsAt: namesNewWait(task.waits, kept) ? at : task.waitsAt,
    sizeBase: base,
    updatedAt: at,
    updatedBy: by,
    priorityAt,
  };
  if (next.owner !== task.owner) {
    return { ...next, pin: changes.pin ?? null, assignedAt: at, ownerSeenAt: by === next.owner ? at : null };
  }
  return { ...next, ownerSeenAt: by === next.owner ? at : task.ownerSeenAt };
}
