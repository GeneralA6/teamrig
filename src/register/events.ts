import { isRecord, type JsonRecord } from '../core/guards.ts';
import type { JsonlRecord } from '../core/jsonl.ts';
import { parseUtcDeadline } from '../core/time.ts';
import { isTaskStatus, LEGACY_WAITING_STATUS, TASK_ID, WAIT_STATUSES, type TaskStatus } from './model.ts';
import { parseCard, type DecisionCard } from './card.ts';
import { parseWaits, type WaitReason } from './waits.ts';

/**
 * The register's event format. Version 0 lines have no `v`; version 1 adds `"v": 1` and nothing
 * else; version 2 names the task field `priority` where older lines wrote `tier`. All three parse
 * the same way: an old line's `tier` reads as its priority and the line is never rewritten.
 * Version 2 later gained, without a new number, a task's `after` list and the `waiting` status with its
 * `waits`, which replaced `blocked`: an older reader ignores the new fields and skips a `waiting` line as
 * a newer teamrig's, and a `blocked` line reads here as `waiting` with no reasons. It also gained a
 * `verifying` status's `proof`, a task's `description` (0.44.0) and its `size` (0.47.0), and a `waiting` status's
 * decision `card` (0.79.0), the same `waits` and `card` on a `verifying` line for what its proof waits for
 * (0.109.0), and an update's approval `verdict` (0.112.0), which an older reader ignores: each reads there as none
 * (an answered update as a note alone), and an older teamrig's `compact` drops it from the snapshot it rewrites (the
 * archive keeps the lines as written).
 * Parsing checks the FORMAT only (any positive priority, any goal string): team policy is applied
 * on write, so changing the config never erases history.
 */
export const EVENT_VERSION = 2;

/** The name lines before version 2 gave the `priority` field; still read, never written. */
export const LEGACY_PRIORITY_FIELD = 'tier';

export interface TaskFields {
  readonly title: string;
  /** What the task is and why, in plain words for a person; newlines kept. Absent on older lines: none. */
  readonly description: string | null;
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
  /** What the task still costs, in percent of the weekly usage limit (above 0, at most 100). Absent on older lines: not sized. */
  readonly size: number | null;
}

export const TASK_FIELD_NAMES = ['title', 'description', 'owner', 'source', 'ref', 'priority', 'due', 'goals', 'week', 'after', 'size'] as const;

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
  /**
   * What a `waiting` task waits for, or what a `verifying` one's proof does (WAIT_STATUSES); written only with those
   * statuses, and absent on a `blocked` line read as one.
   */
  readonly waits?: readonly WaitReason[];
  /** What a wait on a decision or an approval asks of whoever decides (card.ts); written only with WAIT_STATUSES. */
  readonly card?: DecisionCard;
  /** What will prove a `verifying` task works; written only with that status, and absent on lines from before `--proof`. */
  readonly proof?: string;
  /**
   * On a start the verifying tasks it needs held: what shows their proof exists (`--met`). Written only with
   * `in-progress`, apart from the evidence, which a task keeps until it is done and would then prove the wrong task.
   */
  readonly met?: string;
  /** The tasks the work leaves, empty for `--followups none`; absent when the change named none, and on lines from before `--followups`. */
  readonly followups?: readonly string[];
}

/** The lead's answer to the approval a waiting task asks of it (T684): given, or declined with the note saying why. */
export const APPROVAL_VERDICTS = ['approved', 'declined'] as const;

export type ApprovalVerdict = (typeof APPROVAL_VERDICTS)[number];

export function isApprovalVerdict(value: unknown): value is ApprovalVerdict {
  return APPROVAL_VERDICTS.some((verdict) => verdict === value);
}

export interface UpdateEvent extends EventBase {
  readonly type: 'update';
  readonly changes: Partial<TaskFields>;
  readonly note: string | null;
  /** The lead's answer to the task's approval wait, its note saying what it checked or why not; only `approve` writes it. */
  readonly verdict?: ApprovalVerdict;
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

/** The largest size a task can have: the whole weekly limit. */
export const MAX_SIZE_PCT = 100;

/** Why `value` is not a size, or undefined: a size is a finite number above 0 and at most MAX_SIZE_PCT. */
export function sizeProblem(value: number): string | undefined {
  return Number.isFinite(value) && value > 0 && value <= MAX_SIZE_PCT ? undefined : `size ${value} is not above 0 and at most ${MAX_SIZE_PCT}`;
}

/** How a status is spelled (`in-progress`): a well-spelled one this code does not know is a newer teamrig's. */
const STATUS_NAME = /^[a-z]+(?:-[a-z]+)*$/;

/**
 * The record an event is written as. A create line leaves out an empty `after`, a null `description` and a null
 * `size`, which read back as none, so a task without them costs no bytes and its line is the one an older teamrig wrote.
 */
export function eventRecord(event: RegisterEvent): JsonRecord {
  if (event.type !== 'create') {
    return { ...event };
  }
  const { task } = event;
  const left = (name: string): boolean => (name === 'after' && task.after.length === 0) || (name === 'description' && task.description === null) || (name === 'size' && task.size === null);
  return { ...event, task: Object.fromEntries(Object.entries(task).filter(([name]) => !left(name))) };
}

/** Parses one JSONL record. Unknown extra fields are ignored so later minor additions stay readable. */
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
      const problem = textProblem(record, ['note', 'evidence', 'skill', 'proof', 'met']);
      if (problem !== undefined) {
        return unreadable(problem);
      }
      const waits = WAIT_STATUSES.includes(status) && record['waits'] !== undefined ? parseWaits(record['waits']) : undefined;
      if (typeof waits === 'string') {
        return unreadable(waits);
      }
      const card = WAIT_STATUSES.includes(status) ? parseCard(record['card']) : undefined;
      if (typeof card === 'string') {
        return unreadable(card);
      }
      const proof = status === 'verifying' ? textOrNull(record, 'proof') : null;
      const met = status === 'in-progress' ? textOrNull(record, 'met') : null;
      const followups = parseFollowups(record['followups']);
      if (typeof followups === 'string') {
        return unreadable(followups);
      }
      const event: StatusEvent = {
        ...base,
        type: 'status',
        status,
        note: textOrNull(record, 'note'),
        evidence: textOrNull(record, 'evidence'),
        skill: textOrNull(record, 'skill'),
        ...(waits === undefined ? {} : { waits }),
        ...(card === undefined ? {} : { card }),
        ...(proof === null ? {} : { proof }),
        ...(met === null ? {} : { met }),
        ...(followups === undefined ? {} : { followups }),
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
      const verdict = record['verdict'];
      if (verdict !== undefined && !isApprovalVerdict(verdict)) {
        return unreadable(`unknown approval verdict ${JSON.stringify(verdict)}`);
      }
      return { kind: 'event', event: { ...base, type: 'update', changes, note: textOrNull(record, 'note'), ...(verdict === undefined ? {} : { verdict }) } };
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

/** A status line's follow-ups: undefined when absent or null, else a list of task ids, or the reason it is not one. */
function parseFollowups(value: unknown): readonly string[] | undefined | string {
  if (value === undefined || value === null) {
    return undefined;
  }
  return Array.isArray(value) && value.every((id): id is string => typeof id === 'string' && TASK_ID.test(id)) ? value : 'followups is not a list of task ids';
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
    case 'description':
      if (value !== undefined && value !== null && typeof value !== 'string') {
        return `${name} is not text`;
      }
      fields[name] = typeof value === 'string' ? value : null;
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
    case 'size':
      if (value === undefined || value === null) {
        fields.size = null;
        return undefined;
      }
      if (typeof value !== 'number' || sizeProblem(value) !== undefined) {
        return `bad size ${JSON.stringify(value)}`;
      }
      fields.size = value;
      return undefined;
  }
}
