import { isRecord, type JsonRecord } from '../core/guards.ts';
import type { JsonlRecord } from '../core/jsonl.ts';
import { parseUtcDeadline } from '../core/time.ts';
import { isTaskStatus, LEGACY_WAITING_STATUS, TASK_ID, type TaskStatus } from './model.ts';
import { parseWaits, type WaitReason } from './waits.ts';

/**
 * The register's event format. Version 0 lines have no `v`; version 1 adds `"v": 1` and nothing
 * else; version 2 names the task field `priority` where older lines wrote `tier`. All three parse
 * the same way: an old line's `tier` reads as its priority and the line is never rewritten.
 * Version 2 later gained, without a new number, a task's `after` list and the `waiting` status with its
 * `waits`, which replaced `blocked`: an older reader ignores the new fields and skips a `waiting` line as
 * a newer teamrig's, and a `blocked` line reads here as `waiting` with no reasons. It also gained a
 * `verifying` status's `proof`, which an older reader ignores.
 * Parsing checks the FORMAT only (any positive priority, any goal string): team policy is applied
 * on write, so changing the config never erases history.
 */
export const EVENT_VERSION = 2;

/** The name lines before version 2 gave the `priority` field; still read, never written. */
export const LEGACY_PRIORITY_FIELD = 'tier';

export interface TaskFields {
  readonly title: string;
  readonly owner: string;
  /** Who asked for the task; the config's `ownerSource` marks the human owner. */
  readonly source: string;
  /** Where the ask came from: a message, a file and line, a ticket. */
  readonly ref: string | null;
  /** 1 is the most urgent; printed `p1`. */
  readonly priority: number;
  /** `YYYY-MM-DD` or `YYYY-MM-DD HH:MM`, UTC; a bare day means its end. */
  readonly due: string | null;
  readonly goals: readonly string[];
  /** The `YYYY-MM-DD` start of the planning week the task belongs to. */
  readonly week: string | null;
  /** The plan dependency: tasks to finish before this one starts (`after T5`). Absent on older lines: none. */
  readonly after: readonly string[];
}

export const TASK_FIELD_NAMES = ['title', 'owner', 'source', 'ref', 'priority', 'due', 'goals', 'week', 'after'] as const;

export type TaskFieldName = (typeof TASK_FIELD_NAMES)[number];

interface EventBase {
  readonly v: number;
  readonly id: string;
  /** ISO instant the event was written. */
  readonly at: string;
  /** The session that wrote it. */
  readonly by: string;
}

export interface CreateEvent extends EventBase {
  readonly type: 'create';
  readonly task: TaskFields;
}

export interface StatusEvent extends EventBase {
  readonly type: 'status';
  readonly status: TaskStatus;
  readonly note: string | null;
  readonly evidence: string | null;
  /** The skill written or updated when the task closed, or `none`; absent before skills were tracked. */
  readonly skill: string | null;
  /** What a `waiting` task waits for; written only with that status, and absent on a `blocked` line read as one. */
  readonly waits?: readonly WaitReason[];
  /** What will prove a `verifying` task works; written only with that status, and absent on lines from before `--proof`. */
  readonly proof?: string;
}

export interface UpdateEvent extends EventBase {
  readonly type: 'update';
  readonly changes: Partial<TaskFields>;
  readonly note: string | null;
}

export type RegisterEvent = CreateEvent | StatusEvent | UpdateEvent;

export type EventParse =
  | { readonly kind: 'event'; readonly event: RegisterEvent }
  /**
   * Written by a newer release: a line in a newer format, or a status event naming a status this code does
   * not know. Kept on disk and skipped by this code, so its task keeps the status read before it; a newer
   * format blocks every write, and any newer line blocks a rotation, which would drop it (rotate.ts).
   */
  | { readonly kind: 'newer' }
  | { readonly kind: 'unreadable'; readonly reason: string };

const WEEK = /^\d{4}-\d{2}-\d{2}$/;

/** How a status is spelled (`in-progress`): a well-spelled one this code does not know is a newer teamrig's. */
const STATUS_NAME = /^[a-z]+(?:-[a-z]+)*$/;

/** Parses one JSONL record. Unknown extra fields are ignored so later minor additions stay readable. */
/**
 * The record an event is written as. A create line leaves out an empty `after`, which reads back as none, so a
 * task with no plan dependency costs no bytes and its line is the one an older teamrig wrote.
 */
export function eventRecord(event: RegisterEvent): JsonRecord {
  if (event.type !== 'create' || event.task.after.length > 0) {
    return { ...event };
  }
  return { ...event, task: Object.fromEntries(Object.entries(event.task).filter(([name]) => name !== 'after')) };
}

export function parseEvent(line: JsonlRecord): EventParse {
  if (line.version > EVENT_VERSION) {
    return { kind: 'newer' };
  }
  const { record } = line;
  const base = parseBase(record, line.version);
  if (typeof base === 'string') {
    return unreadable(base);
  }
  switch (record['type']) {
    case 'create': {
      const task = isRecord(record['task']) ? parseTaskFields(record['task'], true) : 'task is not an object';
      return typeof task === 'string' ? unreadable(task) : { kind: 'event', event: { ...base, type: 'create', task } };
    }
    case 'status': {
      const status = record['status'] === LEGACY_WAITING_STATUS ? 'waiting' : record['status'];
      if (!isTaskStatus(status)) {
        return typeof status === 'string' && STATUS_NAME.test(status) ? { kind: 'newer' } : unreadable(`unknown status ${JSON.stringify(status)}`);
      }
      const problem = textProblem(record, ['note', 'evidence', 'skill', 'proof']);
      if (problem !== undefined) {
        return unreadable(problem);
      }
      const waits = status === 'waiting' && record['waits'] !== undefined ? parseWaits(record['waits']) : undefined;
      if (typeof waits === 'string') {
        return unreadable(waits);
      }
      const proof = status === 'verifying' ? textOrNull(record, 'proof') : null;
      const event: StatusEvent = {
        ...base,
        type: 'status',
        status,
        note: textOrNull(record, 'note'),
        evidence: textOrNull(record, 'evidence'),
        skill: textOrNull(record, 'skill'),
        ...(waits === undefined ? {} : { waits }),
        ...(proof === null ? {} : { proof }),
      };
      return { kind: 'event', event };
    }
    case 'update': {
      const changes = isRecord(record['changes']) ? parseTaskFields(record['changes'], false) : 'changes is not an object';
      if (typeof changes === 'string') {
        return unreadable(changes);
      }
      const problem = textProblem(record, ['note']);
      if (problem !== undefined) {
        return unreadable(problem);
      }
      return { kind: 'event', event: { ...base, type: 'update', changes, note: textOrNull(record, 'note') } };
    }
    default:
      return unreadable(`unknown event type ${JSON.stringify(record['type'])}`);
  }
}

function unreadable(reason: string): EventParse {
  return { kind: 'unreadable', reason };
}

function parseBase(record: JsonRecord, v: number): EventBase | string {
  const { id, at, by } = record;
  if (typeof id !== 'string' || !TASK_ID.test(id)) {
    return `bad task id ${JSON.stringify(id)}`;
  }
  if (typeof at !== 'string' || Number.isNaN(Date.parse(at))) {
    return `bad time ${JSON.stringify(at)}`;
  }
  if (typeof by !== 'string' || by === '') {
    return 'missing author';
  }
  return { v, id, at, by };
}

/** The first of `keys` that is present but neither text nor null. */
function textProblem(record: JsonRecord, keys: readonly string[]): string | undefined {
  const bad = keys.find((key) => {
    const value = record[key];
    return value !== undefined && value !== null && typeof value !== 'string';
  });
  return bad === undefined ? undefined : `${bad} is not text`;
}

/** An optional text field: absent and null both read as null. */
function textOrNull(record: JsonRecord, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' ? value : null;
}

/**
 * Reads task fields. For a create every field must be present (optional ones may be null or
 * missing); for an update only the fields present are read.
 */
function parseTaskFields(record: JsonRecord, complete: true): TaskFields | string;
function parseTaskFields(record: JsonRecord, complete: false): Partial<TaskFields> | string;
function parseTaskFields(record: JsonRecord, complete: boolean): Partial<TaskFields> | string {
  const fields: { -readonly [K in TaskFieldName]?: TaskFields[K] } = {};
  for (const name of TASK_FIELD_NAMES) {
    const value = name === 'priority' ? priorityOf(record) : record[name];
    if (value === undefined && !complete) {
      continue;
    }
    const problem = readField(fields, name, value);
    if (problem !== undefined) {
      return problem;
    }
  }
  return fields;
}

/** The line's priority: `priority`, else the `tier` of a line written before version 2; `priority` wins when a line has both. */
function priorityOf(record: JsonRecord): unknown {
  return 'priority' in record ? record['priority'] : record[LEGACY_PRIORITY_FIELD];
}

function readField(fields: { -readonly [K in TaskFieldName]?: TaskFields[K] }, name: TaskFieldName, value: unknown): string | undefined {
  switch (name) {
    case 'title':
    case 'owner':
    case 'source':
      if (typeof value !== 'string' || value === '') {
        return `${name} is not text`;
      }
      fields[name] = value;
      return undefined;
    case 'ref':
      if (value !== undefined && value !== null && typeof value !== 'string') {
        return 'ref is not text';
      }
      fields.ref = typeof value === 'string' ? value : null;
      return undefined;
    case 'priority':
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
        return `bad priority ${JSON.stringify(value)}`;
      }
      fields.priority = value;
      return undefined;
    case 'due':
      if (value !== undefined && value !== null && (typeof value !== 'string' || parseUtcDeadline(value) === undefined)) {
        return `bad due ${JSON.stringify(value)}`;
      }
      fields.due = typeof value === 'string' ? value : null;
      return undefined;
    case 'week':
      if (value !== undefined && value !== null && (typeof value !== 'string' || !WEEK.test(value))) {
        return `bad week ${JSON.stringify(value)}`;
      }
      fields.week = typeof value === 'string' ? value : null;
      return undefined;
    case 'goals':
      if (value === undefined || value === null) {
        fields.goals = [];
        return undefined;
      }
      if (!Array.isArray(value) || !value.every((goal): goal is string => typeof goal === 'string')) {
        return 'goals is not a list of text';
      }
      fields.goals = value;
      return undefined;
    case 'after':
      if (value === undefined || value === null) {
        fields.after = [];
        return undefined;
      }
      if (!Array.isArray(value) || !value.every((id): id is string => typeof id === 'string' && TASK_ID.test(id))) {
        return 'after is not a list of task ids';
      }
      fields.after = value;
      return undefined;
  }
}
