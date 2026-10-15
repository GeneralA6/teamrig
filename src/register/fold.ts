import type { RegisterEvent, TaskFields } from './events.ts';
import type { TaskStatus } from './model.ts';
import type { WaitReason } from './waits.ts';

/** A task as the event log describes it after replaying every event in write order. */
export interface Task extends TaskFields {
  readonly id: string;
  readonly status: TaskStatus;
  /** The note, evidence and skill of the latest status change; evidence carries over when a change gives none. */
  readonly note: string | null;
  readonly evidence: string | null;
  readonly skill: string | null;
  /** What the task waits for while `waiting`, from its latest status change; empty in any other status. */
  readonly waits: readonly WaitReason[];
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
}

/** The numeric part of a task id (`T12` → 12). */
export function taskNumber(id: string): number {
  return Number(id.slice(1));
}

/**
 * Replays events in write order, one at a time. A task's state depends on its own events only, so
 * replaying one task's events gives the same task as replaying the whole log: a compaction keeps the
 * events of the tasks it keeps and nothing else (compaction.ts).
 */
export class RegisterFold {
  private readonly tasks: Map<string, Task>;
  private orphans: number;
  private maxId: number;

  /**
   * `from`: the state to go on from (its tasks are copied, never changed). `seenIds` are ids found on
   * lines that did not parse (damaged or newer records): they still count towards the next id, so an
   * id is never handed out twice.
   */
  constructor(from?: RegisterState, seenIds: readonly string[] = []) {
    this.tasks = new Map(from?.tasks);
    this.orphans = from?.orphans ?? 0;
    const floor = from === undefined ? 0 : taskNumber(from.nextId) - 1;
    this.maxId = seenIds.reduce((max, id) => Math.max(max, taskNumber(id)), floor);
  }

  /** Applies one event; false when it names no task, or creates one twice: an orphan, counted and ignored. */
  apply(event: RegisterEvent): boolean {
    this.maxId = Math.max(this.maxId, taskNumber(event.id));
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
    this.tasks.set(event.id, event.type === 'status' ? withStatus(current, event) : withChanges(current, event.changes, event.at, event.by));
    return true;
  }

  /** The state so far. Its task map is a copy, so later events never change a state already handed out. */
  state(): RegisterState {
    return { tasks: new Map(this.tasks), orphans: this.orphans, nextId: `T${this.maxId + 1}` };
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
    startedAt: null,
    createdAt: at,
    createdBy: by,
    updatedAt: at,
    updatedBy: by,
    assignedAt: at,
    statusAt: at,
    priorityAt: at,
    ownerSeenAt: by === fields.owner ? at : null,
  };
}

function withStatus(task: Task, event: Extract<RegisterEvent, { type: 'status' }>): Task {
  return {
    ...task,
    status: event.status,
    statusAt: event.status === task.status ? task.statusAt : event.at,
    note: event.note,
    evidence: event.evidence ?? task.evidence,
    skill: event.skill,
    waits: event.status === 'waiting' ? (event.waits ?? []) : [],
    startedAt: task.startedAt ?? (event.status === 'in-progress' || event.status === 'verifying' ? event.at : null),
    updatedAt: event.at,
    updatedBy: event.by,
    ownerSeenAt: event.by === task.owner ? event.at : task.ownerSeenAt,
  };
}

function withChanges(task: Task, changes: Partial<TaskFields>, at: string, by: string): Task {
  const priorityAt = changes.priority === undefined || changes.priority === task.priority ? task.priorityAt : at;
  const next: Task = { ...task, ...changes, updatedAt: at, updatedBy: by, priorityAt };
  if (next.owner !== task.owner) {
    return { ...next, assignedAt: at, ownerSeenAt: by === next.owner ? at : null };
  }
  return { ...next, ownerSeenAt: by === next.owner ? at : task.ownerSeenAt };
}
