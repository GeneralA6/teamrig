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

/**
 * Each session's queued work, the weight of its part of the team's daily budget: its open and in-progress tasks,
 * each weighed by its priority, the top priority as many as the config lists and the last 1 (p1..p5: 5..1). A
 * priority the config does not list weighs 1. A session with no queued work is not in the map.
 */
export function workWeights(tasks: Iterable<Pick<Task, 'owner' | 'status' | 'priority'>>, priorities: readonly PriorityConfig[]): ReadonlyMap<string, number> {
  const ranked = priorities.map((priority) => priority.id).sort((a, b) => a - b);
  const weights = new Map<string, number>();
  for (const task of tasks) {
    if (!QUEUED.has(task.status)) {
      continue;
    }
    const rank = ranked.indexOf(task.priority);
    weights.set(task.owner, (weights.get(task.owner) ?? 0) + (rank === -1 ? 1 : ranked.length - rank));
  }
  return weights;
}

/** The sessions' queued work, replayed from the register's working set; a register that cannot be read throws. */
async function replayWork(files: Files, eventsPath: string, priorities: readonly PriorityConfig[]): Promise<ReadonlyMap<string, number>> {
  const { state } = await new JsonlEventLog(files, eventsPath).read();
  return workWeights(state.tasks.values(), priorities);
}

/**
 * The sessions' queued work, read from the register at `eventsPath`; empty when the register cannot be read, so
 * every part falls back to its session's `share` and a damaged register never stops the budget.
 */
export async function readWork(files: Files, eventsPath: string, priorities: readonly PriorityConfig[]): Promise<ReadonlyMap<string, number>> {
  try {
    return await replayWork(files, eventsPath, priorities);
  } catch {
    return new Map();
  }
}

/** The work cache's file in the usage folder: a name no session id can have, so it is never taken for a session's usage file. */
export const WORK_CACHE_FILE = 'work.cache.json';
/** The work cache's format; a cache in any other reads as missing and is written again. */
const WORK_CACHE_FORMAT = 1;

/** What a reading of the work was read from: the stamps of the register files the working set folds, and the priority ids that weighed it. */
interface WorkKey {
  readonly tail: string | null;
  readonly snapshot: string | null;
  readonly priorities: readonly number[];
}

interface CachedWork {
  readonly key: WorkKey;
  readonly work: ReadonlyMap<string, number>;
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

/** The cache file's key and work; undefined when it is missing, damaged or in another format. */
function parseWorkCache(text: string | undefined): CachedWork | undefined {
  const stored = text === undefined ? undefined : parseObject(text);
  const key = stored === undefined ? undefined : recordField(stored, 'key');
  const work = stored === undefined ? undefined : stored['work'];
  if (stored === undefined || recordVersion(stored) !== WORK_CACHE_FORMAT || key === undefined || !isRecord(work)) {
    return undefined;
  }
  const tail = storedStamp(key['tail']);
  const snapshot = storedStamp(key['snapshot']);
  const priorities = key['priorities'];
  if (tail === undefined || snapshot === undefined || !isNumberArray(priorities)) {
    return undefined;
  }
  const weights = new Map<string, number>();
  for (const [session, weight] of Object.entries(work)) {
    if (typeof weight !== 'number' || !Number.isFinite(weight)) {
      return undefined;
    }
    weights.set(session, weight);
  }
  return { key: { tail, snapshot, priorities }, work: weights };
}

function formatWorkCache(key: WorkKey, work: ReadonlyMap<string, number>): string {
  return JSON.stringify({ [VERSION_FIELD]: WORK_CACHE_FORMAT, key, work: Object.fromEntries(work) });
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
 * the register and writes the cache again. A register that cannot be read is empty work, as with `readWork`,
 * and is not cached, nor is a reading whose stamps could not be taken; a cache that cannot be read is missing,
 * and one that cannot be written is left for the next call. It never throws, so the cache never stops the budget.
 */
export async function cachedWork(files: Files, eventsPath: string, cachePath: string, priorities: readonly PriorityConfig[]): Promise<ReadonlyMap<string, number>> {
  const key = await workKeyOf(files, eventsPath, priorities);
  if (key === undefined) {
    return readWork(files, eventsPath, priorities);
  }
  const cached = parseWorkCache(await files.read(cachePath).catch(() => undefined));
  if (cached !== undefined && sameKey(cached.key, key)) {
    return cached.work;
  }
  let work: ReadonlyMap<string, number>;
  try {
    work = await replayWork(files, eventsPath, priorities);
  } catch {
    return new Map();
  }
  await files.write(cachePath, formatWorkCache(key, work)).catch(() => undefined);
  return work;
}
