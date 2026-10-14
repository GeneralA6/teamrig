import type { RegisterEvent, TaskFields } from './events.ts';
import type { TaskStatus } from './model.ts';

/** A task as the event log describes it after replaying every event in write order. */
export interface Task extends TaskFields {
  readonly id: string;
  readonly status: TaskStatus;
  /** The note, evidence and skill of the latest status change; evidence carries over when a change gives none. */
  readonly note: string | null;
  readonly evidence: string | null;
  readonly skill: string | null;
  readonly createdAt: string;
  readonly createdBy: string;
  /** The newest event on the task, and who wrote it. */
  readonly updatedAt: string;
  readonly updatedBy: string;
  /** When the current owner got the task: its creation, or the latest owner change. */
  readonly assignedAt: string;
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
 * Replays events in write order. `seenIds` are ids found on lines that did not parse (damaged or
 * newer records): they still count towards the next id, so an id is never handed out twice.
 */
export function foldEvents(events: readonly RegisterEvent[], seenIds: readonly string[] = []): RegisterState {
  const tasks = new Map<string, Task>();
  let orphans = 0;
  let maxId = seenIds.reduce((max, id) => Math.max(max, taskNumber(id)), 0);
  for (const event of events) {
    maxId = Math.max(maxId, taskNumber(event.id));
    const current = tasks.get(event.id);
    if (event.type === 'create') {
      if (current === undefined) {
        tasks.set(event.id, created(event.id, event.task, event.at, event.by));
      } else {
        orphans += 1;
      }
      continue;
    }
    if (current === undefined) {
      orphans += 1;
      continue;
    }
    tasks.set(event.id, event.type === 'status' ? withStatus(current, event) : withChanges(current, event.changes, event.at, event.by));
  }
  return { tasks, orphans, nextId: `T${maxId + 1}` };
}

function created(id: string, fields: TaskFields, at: string, by: string): Task {
  return {
    ...fields,
    id,
    status: 'open',
    note: null,
    evidence: null,
    skill: null,
    createdAt: at,
    createdBy: by,
    updatedAt: at,
    updatedBy: by,
    assignedAt: at,
    ownerSeenAt: by === fields.owner ? at : null,
  };
}

function withStatus(task: Task, event: Extract<RegisterEvent, { type: 'status' }>): Task {
  return {
    ...task,
    status: event.status,
    note: event.note,
    evidence: event.evidence ?? task.evidence,
    skill: event.skill,
    updatedAt: event.at,
    updatedBy: event.by,
    ownerSeenAt: event.by === task.owner ? event.at : task.ownerSeenAt,
  };
}

function withChanges(task: Task, changes: Partial<TaskFields>, at: string, by: string): Task {
  const next: Task = { ...task, ...changes, updatedAt: at, updatedBy: by };
  if (next.owner !== task.owner) {
    return { ...next, assignedAt: at, ownerSeenAt: by === next.owner ? at : null };
  }
  return { ...next, ownerSeenAt: by === next.owner ? at : task.ownerSeenAt };
}
