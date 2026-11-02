import { isRecord, type JsonRecord } from '../core/guards.ts';
import { ID_PATTERN } from '../core/ids.ts';
import type { JsonlRecord } from '../core/jsonl.ts';
import { parseUtcDeadline } from '../core/time.ts';
import { isTaskStatus, LEGACY_WAITING_STATUS, TASK_ID, WAIT_STATUSES, type TaskStatus } from './model.ts';
import { parseCard, type DecisionCard } from './card.ts';
import { parseReview, type ProblemReview } from './review.ts';
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
 * (0.109.0), an update's approval `verdict` (0.126.0), a task's `kind` (0.147.0), its `pin` (T637), a status line's
 * `review` (T916), a task's `type` and `critical` mark (T1252), which replaced `kind`, and a `done` status's `watch`
 * (T1306), an update's `waits` (T1295), a task's `noGoal` mark (T1730) and an update's `decided` mark (T1366), which an older reader ignores:
 * each reads there as none (an answered update as a note alone). An older teamrig re-serialized the events of the snapshot a rotation or
 * `compact` rewrites, so it dropped such a field there (the archive keeps the lines as written); this one copies
 * each kept line as written (compaction.ts).
 * Version 3 adds the `moved` record (T1144), and only a moved line carries it: an older teamrig reads that line as a
 * newer format and writes to the register no more, so no session of it changes a task that moved to another team.
 * Parsing checks the FORMAT only (any priority from 0, any goal string): team policy is applied
 * on write, so changing the config never erases history.
 */
export const EVENT_VERSION = 3;

/** The version every line but a moved one is written with, so a reader of version 2 reads them all. */
export const TASK_LINE_VERSION = 2;

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
  /**
   * Whether the task was said to serve no goal (`--goals none`, T1730), with empty `goals`; an empty `goals` without it
   * is "not said". Absent on older lines: not said.
   */
  readonly noGoal: boolean;
  /** The `YYYY-MM-DD` start of the planning week the task belongs to. */
  readonly week: string | null;
  /** The plan dependency: tasks to finish before this one starts (`after T5`). Absent on older lines: none. */
  readonly after: readonly string[];
  /** What the task still costs, in percent of the weekly usage limit (above 0, at most 100). Absent on older lines: not sized. */
  readonly size: number | null;
  /**
   * What the item is (ITEM_TYPES); null when no one set it, read as a task. A type a newer teamrig writes reads as a
   * task here. Absent on older lines: their `kind` (LEGACY_KIND_FIELD), else not set.
   */
  readonly type: ItemType | null;
  /** Whether the item sits in a critical area, which only a type with a review takes (item-types.ts). Absent on older lines: a `kind` of critical. */
  readonly critical: boolean;
  /** The leader who pinned the task to the top of its owner's list, above priority; null: not pinned. Absent on older lines: not pinned. */
  readonly pin: string | null;
}

/**
 * What a register item is (`--type`): a `task`, the default, or a `bug`, such as a fix, an incident, the investigation
 * of a failure, a bug's design or the decision about one. What each type does is its row in item-types.ts.
 */
export const ITEM_TYPES = ['task', 'bug'] as const;

export type ItemType = (typeof ITEM_TYPES)[number];

export function isItemType(value: unknown): value is ItemType {
  return ITEM_TYPES.some((type) => type === value);
}

/** How a type is spelled (`bug`): a well-spelled one this code does not know is a newer teamrig's, read as a task. */
const TYPE_NAME = /^[a-z]+(?:-[a-z]+)*$/;

/** The field lines before T1252 marked a task with (`work`, `problem` or `critical`); read as a type and critical mark, never written. */
export const LEGACY_KIND_FIELD = 'kind';

/** What each `kind` an older line wrote reads as. */
const LEGACY_KINDS: ReadonlyMap<unknown, Pick<TaskFields, 'type' | 'critical'>> = new Map([
  ['work', { type: 'task', critical: false }],
  ['problem', { type: 'bug', critical: false }],
  ['critical', { type: 'bug', critical: true }],
]);

export const TASK_FIELD_NAMES = ['title', 'description', 'owner', 'source', 'ref', 'priority', 'due', 'goals', 'noGoal', 'week', 'after', 'size', 'type', 'critical', 'pin'] as const;

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
  /** What a sighting shows once a `done` change runs live (`--watch`); written only with that status. */
  readonly watch?: string;
  /**
   * On a start the verifying tasks it needs held: what shows their proof exists (`--met`). Written only with
   * `in-progress`, apart from the evidence, which a task keeps until it is done and would then prove the wrong task.
   */
  readonly met?: string;
  /** The tasks the work leaves, empty for `--followups none`; absent when the change named none, and on lines from before `--followups`. */
  readonly followups?: readonly string[];
  /** The parts of a bug's review this change gave (review.ts); absent when it gave none. */
  readonly review?: ProblemReview;
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
  /**
   * The waits an update gives a waiting or verifying task: a Later's (T1295), its waits with the time the owner put it
   * off to, or without one; or a Decided's (T1366), its waits without the owner's. Only `defer` and `decide` write it.
   */
  readonly waits?: readonly WaitReason[];
  /** A Decided (T1366): the owner's decision on the task's card, which its note says, recorded by `by`; only `decide` writes it. */
  readonly decided?: true;
}

/**
 * The task went to team `to` (T1144): its lines live in that team's register from then on, under the same id, and a
 * later event on the id here is an orphan. Written with EVENT_VERSION, never with TASK_LINE_VERSION.
 */
export interface MovedEvent extends EventBase {
  readonly type: 'moved';
  readonly to: string;
}

export type RegisterEvent = CreateEvent | StatusEvent | UpdateEvent | MovedEvent;

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
 * The record an event is written as. A create line leaves out an empty `after`, a null `description`, `size`, `type`
 * or `pin` and a false `critical` or `noGoal`, which read back as none, so a task without them costs no bytes and its
 * line is the one an older teamrig wrote.
 */
export function eventRecord(event: RegisterEvent): JsonRecord {
  if (event.type !== 'create') {
    return { ...event };
  }
  const { task } = event;
  const left = (name: string): boolean =>
    (name === 'after' && task.after.length === 0) ||
    (name === 'description' && task.description === null) ||
    (name === 'size' && task.size === null) ||
    (name === 'type' && task.type === null) ||
    (name === 'critical' && !task.critical) ||
    (name === 'noGoal' && !task.noGoal) ||
    (name === 'pin' && task.pin === null);
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
      const problem = textProblem(record, ['note', 'evidence', 'skill', 'proof', 'watch', 'met']);
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
      const watch = status === 'done' ? textOrNull(record, 'watch') : null;
      const met = status === 'in-progress' ? textOrNull(record, 'met') : null;
      const followups = parseFollowups(record['followups']);
      if (typeof followups === 'string') {
        return unreadable(followups);
      }
      const review = parseReview(record['review']);
      if (typeof review === 'string') {
        return unreadable(review);
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
        ...(watch === null ? {} : { watch }),
        ...(met === null ? {} : { met }),
        ...(followups === undefined ? {} : { followups }),
        ...(review === undefined ? {} : { review }),
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
      const waits = record['waits'] === undefined ? undefined : parseWaits(record['waits']);
      if (typeof waits === 'string') {
        return unreadable(waits);
      }
      const decided = record['decided'];
      if (decided !== undefined && decided !== true) {
        return unreadable(`decided is ${JSON.stringify(decided)}, not true`);
      }
      const event: UpdateEvent = {
        ...base,
        type: 'update',
        changes,
        note: textOrNull(record, 'note'),
        ...(verdict === undefined ? {} : { verdict }),
        ...(waits === undefined ? {} : { waits }),
        ...(decided === undefined ? {} : { decided }),
      };
      return { kind: 'event', event };
    }
    case 'moved': {
      const to = record['to'];
      return typeof to === 'string' && ID_PATTERN.test(to) ? { kind: 'event', event: { ...base, type: 'moved', to } } : unreadable(`bad team ${JSON.stringify(to)}`);
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
  const legacy = legacyMarkOf(record);
  if (typeof legacy === 'string') {
    return legacy;
  }
  const fields: { -readonly [K in TaskFieldName]?: TaskFields[K] } = {};
  for (const name of TASK_FIELD_NAMES) {
    const value = fieldValue(record, name, legacy);
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

/** The value a line gives field `name`, reading a field an older line spelled another way (`tier`, `kind`) as its new one. */
function fieldValue(record: JsonRecord, name: TaskFieldName, legacy: Pick<TaskFields, 'type' | 'critical'> | undefined): unknown {
  if (name === 'priority') {
    return priorityOf(record);
  }
  if ((name === 'type' || name === 'critical') && !(name in record) && legacy !== undefined) {
    return legacy[name];
  }
  return record[name];
}

/** The line's priority: `priority`, else the `tier` of a line written before version 2; `priority` wins when a line has both. */
function priorityOf(record: JsonRecord): unknown {
  return 'priority' in record ? record['priority'] : record[LEGACY_PRIORITY_FIELD];
}

/**
 * The type and critical mark a line from before T1252 gave as its `kind`: undefined when it has none, a null `kind`
 * as not set; a `type` or `critical` on the same line wins over it.
 */
function legacyMarkOf(record: JsonRecord): Pick<TaskFields, 'type' | 'critical'> | undefined | string {
  const kind = record[LEGACY_KIND_FIELD];
  if (kind === undefined) {
    return undefined;
  }
  return kind === null ? { type: null, critical: false } : (LEGACY_KINDS.get(kind) ?? `bad kind ${JSON.stringify(kind)}`);
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
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
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
    case 'noGoal':
      if (value !== undefined && value !== null && typeof value !== 'boolean') {
        return `bad noGoal ${JSON.stringify(value)}`;
      }
      fields.noGoal = value === true;
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
    case 'type':
      if (value !== undefined && value !== null && (typeof value !== 'string' || !TYPE_NAME.test(value))) {
        return `bad type ${JSON.stringify(value)}`;
      }
      fields.type = typeof value !== 'string' ? null : isItemType(value) ? value : 'task';
      return undefined;
    case 'critical':
      if (value !== undefined && value !== null && typeof value !== 'boolean') {
        return `bad critical ${JSON.stringify(value)}`;
      }
      fields.critical = value === true;
      return undefined;
    case 'pin':
      if (value !== undefined && value !== null && (typeof value !== 'string' || value === '')) {
        return 'pin is not text';
      }
      fields.pin = typeof value === 'string' ? value : null;
      return undefined;
  }
}
