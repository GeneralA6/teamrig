import { NOW_PRIORITY, priorityLevels } from '../config/priorities.ts';
import type { PriorityConfig } from '../config/types.ts';
import type { Files } from '../core/files.ts';
import { isRecord, recordField } from '../core/guards.ts';
import { parseObject, recordVersion, VERSION_FIELD } from '../core/jsonl.ts';
import type { Task } from '../register/fold.ts';
import { layoutPaths } from '../register/layout.ts';
import type { TaskStatus } from '../register/model.ts';
import { JsonlEventLog } from '../register/store.ts';

/** The statuses whose tasks are a session's queued work: what it can work on now. */
const QUEUED: ReadonlySet<TaskStatus> = new Set<TaskStatus>(['open', 'in-progress']);

/** A session's queued work: its weight by priority id, so a short day can fund it in priority order. */
export type WorkByPriority = ReadonlyMap<number, number>;

/** A session's top queued task as `workWeights` weighs it. */
interface TopTask {
  readonly priority: number;
  readonly weight: number;
}

/**
 * Each session's queued work, the weight of its part of the team's daily budget: its top queued (open or in-progress)
 * task alone, weighed by its priority, p0 as many as there are levels (teamrig's p0 and the config's) and the last 1
 * (p0..p5: 6..1), under that priority's id. A priority the config does not list weighs 1; of two tasks that weigh the
 * same, the lower priority id is the top. A session works one task at a time, so how many it has queued does not raise
 * what it spends: a session with 40 queued p1 tasks weighs as one with a single p1, and one whose most important work
 * is low priority weighs low (T1588). A session with no queued work is not in the map.
 */
export function workWeights(tasks: Iterable<Pick<Task, 'owner' | 'status' | 'priority'>>, priorities: readonly PriorityConfig[]): ReadonlyMap<string, WorkByPriority> {
  const ranked = priorityLevels(priorities).map((priority) => priority.id).sort((a, b) => a - b);
  const weightOf = (priority: number): number => {
    const rank = ranked.indexOf(priority);
    return rank === -1 ? 1 : ranked.length - rank;
  };
  const tops = new Map<string, TopTask>();
  for (const task of tasks) {
    if (!QUEUED.has(task.status)) {
      continue;
    }
    const weight = weightOf(task.priority);
    const top = tops.get(task.owner);
    if (top === undefined || weight > top.weight || (weight === top.weight && task.priority < top.priority)) {
      tops.set(task.owner, { priority: task.priority, weight });
    }
  }
  return new Map([...tops].map(([owner, top]): [string, WorkByPriority] => [owner, new Map([[top.priority, top.weight]])]));
}

/** A session's queued work weighed whole: its weights summed over its priorities (from `workWeights`, its top task's alone), 0 with none. */
export function workWeightOf(work: WorkByPriority | undefined): number {
  let sum = 0;
  for (const weight of work?.values() ?? []) {
    sum += weight;
  }
  return sum;
}

/** The sessions' queued work: what weighs each one's part of the daily budget, and the p0 work that goes on past it. */
export interface QueuedWork {
  /** Each session's top queued task's weight under its priority (`workWeights`); a session with no queued work is not in it. */
  readonly weights: ReadonlyMap<string, WorkByPriority>;
  /** Each session's queued p0 task ids, in the register's order; a session with none is not in it. */
  readonly urgent: ReadonlyMap<string, readonly string[]>;
}

/** No queued work: every part falls back to its session's `share`, and no session has p0 work. */
export const NO_WORK: QueuedWork = { weights: new Map(), urgent: new Map() };

/** The sessions' queued work: `workWeights`, and each session's open and in-progress p0 tasks. */
export function queuedWork(tasks: Iterable<Pick<Task, 'id' | 'owner' | 'status' | 'priority'>>, priorities: readonly PriorityConfig[]): QueuedWork {
  const queued = [...tasks].filter((task) => QUEUED.has(task.status));
  const urgent = new Map<string, string[]>();
  for (const task of queued) {
    if (task.priority === NOW_PRIORITY.id) {
      urgent.set(task.owner, [...(urgent.get(task.owner) ?? []), task.id]);
    }
  }
  return { weights: workWeights(queued, priorities), urgent };
}

/** The tasks of the register's working set at `eventsPath`; undefined when it cannot be read, so a damaged register never stops the budget. */
export async function readTasks(files: Files, eventsPath: string): Promise<readonly Task[] | undefined> {
  try {
    const { state } = await new JsonlEventLog(files, eventsPath).read();
    return [...state.tasks.values()];
  } catch {
    return undefined;
  }
}

/** The sessions' queued work, read from the register at `eventsPath`; none when the register cannot be read, so every part falls back to its session's `share`. */
export async function readWork(files: Files, eventsPath: string, priorities: readonly PriorityConfig[]): Promise<QueuedWork> {
  const tasks = await readTasks(files, eventsPath);
  return tasks === undefined ? NO_WORK : queuedWork(tasks, priorities);
}

/** The work cache's file in the usage folder: a name no session id can have, so it is never taken for a session's usage file. */
export const WORK_CACHE_FILE = 'work.cache.json';
/**
 * The work cache's format (2: with each session's p0 ids; 3: each session's weights by priority id; 4: its top task's
 * weight only, T1588, so a format-3 cache of every task's weights is read again); a cache in any other reads as
 * missing and is written again.
 */
const WORK_CACHE_FORMAT = 4;

/** What a reading of the work was read from: the stamps of the register files the working set folds, and the priority ids that weighed it. */
interface WorkKey {
  readonly tail: string | null;
  readonly snapshot: string | null;
  readonly priorities: readonly number[];
}

interface CachedWork {
  readonly key: WorkKey;
  readonly work: QueuedWork;
}

function sameKey(a: WorkKey, b: WorkKey): boolean {
  return a.tail === b.tail && a.snapshot === b.snapshot && a.priorities.length === b.priorities.length && a.priorities.every((id, index) => id === b.priorities[index]);
}

/** A stored stamp: its text, or null for a file that was missing; undefined when the value is neither. */
function storedStamp(value: unknown): string | null | undefined {
  return value === null || typeof value === 'string' ? value : undefined;
}

function isNumberArray(value: unknown): value is readonly number[] {
  return Array.isArray(value) && value.every((each) => typeof each === 'number');
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((each) => typeof each === 'string');
}

/** The stored p0 ids by session; undefined when any entry is not a list of ids. */
function storedUrgent(value: Record<string, unknown>): ReadonlyMap<string, readonly string[]> | undefined {
  const urgent = new Map<string, readonly string[]>();
  for (const [session, ids] of Object.entries(value)) {
    if (!isStringArray(ids)) {
      return undefined;
    }
    urgent.set(session, ids);
  }
  return urgent;
}

/** A session's stored weights by priority id; undefined when it is not a record of whole priority ids to finite weights. */
function storedByPriority(value: unknown): WorkByPriority | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const byPriority = new Map<number, number>();
  for (const [priority, weight] of Object.entries(value)) {
    const id = Number(priority);
    if (!Number.isInteger(id) || String(id) !== priority || typeof weight !== 'number' || !Number.isFinite(weight)) {
      return undefined;
    }
    byPriority.set(id, weight);
  }
  return byPriority;
}

/** The cache file's key and work; undefined when it is missing, damaged or in another format. */
function parseWorkCache(text: string | undefined): CachedWork | undefined {
  const stored = text === undefined ? undefined : parseObject(text);
  const key = stored === undefined ? undefined : recordField(stored, 'key');
  const work = stored === undefined ? undefined : stored['work'];
  const urgentField = stored === undefined ? undefined : recordField(stored, 'urgent');
  const urgent = urgentField === undefined ? undefined : storedUrgent(urgentField);
  if (stored === undefined || recordVersion(stored) !== WORK_CACHE_FORMAT || key === undefined || !isRecord(work) || urgent === undefined) {
    return undefined;
  }
  const tail = storedStamp(key['tail']);
  const snapshot = storedStamp(key['snapshot']);
  const priorities = key['priorities'];
  if (tail === undefined || snapshot === undefined || !isNumberArray(priorities)) {
    return undefined;
  }
  const weights = new Map<string, WorkByPriority>();
  for (const [session, stored] of Object.entries(work)) {
    const byPriority = storedByPriority(stored);
    if (byPriority === undefined) {
      return undefined;
    }
    weights.set(session, byPriority);
  }
  return { key: { tail, snapshot, priorities }, work: { weights, urgent } };
}

function formatWorkCache(key: WorkKey, work: QueuedWork): string {
  const weights = Object.fromEntries([...work.weights].map(([session, byPriority]) => [session, Object.fromEntries(byPriority)]));
  return JSON.stringify({ [VERSION_FIELD]: WORK_CACHE_FORMAT, key, work: weights, urgent: Object.fromEntries(work.urgent) });
}

/** The key of a reading taken now; undefined when a stamp cannot be taken. */
async function workKeyOf(files: Pick<Files, 'stamp'>, eventsPath: string, priorities: readonly PriorityConfig[]): Promise<WorkKey | undefined> {
  const { tail, snapshot } = layoutPaths(eventsPath);
  try {
    return { tail: (await files.stamp(tail)) ?? null, snapshot: (await files.stamp(snapshot)) ?? null, priorities: priorities.map((priority) => priority.id) };
  } catch {
    return undefined;
  }
}

/**
 * The sessions' queued work as `readWork` reads it, replayed only when it can have changed. The reading is kept
 * at `cachePath` with what it was read from: the stamps (size and change time) of the register's tail and
 * snapshot, which every write and every rotation changes, and the priority ids that weighed it. While they stay
 * the same the cache is the answer, so a hook takes two stamps and reads one small file, however long the
 * register's history. The stamps are taken before the register is read, so a write between the two leaves a
 * newer stamp and the next call reads again. A missing, damaged or other-format cache, or a changed key, reads
 * the register and writes the cache again. A register that cannot be read is no work, as with `readWork`,
 * and is not cached, nor is a reading whose stamps could not be taken; a cache that cannot be read is missing,
 * and one that cannot be written is left for the next call. It never throws, so the cache never stops the budget.
 */
export async function cachedWork(files: Files, eventsPath: string, cachePath: string, priorities: readonly PriorityConfig[]): Promise<QueuedWork> {
  const key = await workKeyOf(files, eventsPath, priorities);
  if (key === undefined) {
    return readWork(files, eventsPath, priorities);
  }
  const cached = parseWorkCache(await files.read(cachePath).catch(() => undefined));
  if (cached !== undefined && sameKey(cached.key, key)) {
    return cached.work;
  }
  const tasks = await readTasks(files, eventsPath);
  if (tasks === undefined) {
    return NO_WORK;
  }
  const work = queuedWork(tasks, priorities);
  await files.write(cachePath, formatWorkCache(key, work)).catch(() => undefined);
  return work;
}
