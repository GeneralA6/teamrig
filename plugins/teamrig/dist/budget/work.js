import { NOW_PRIORITY, priorityLevels } from "../config/priorities.js";
import { isRecord, recordField } from "../core/guards.js";
import { parseObject, recordVersion, VERSION_FIELD } from "../core/jsonl.js";
import { layoutPaths } from "../register/layout.js";
import { JsonlEventLog } from "../register/store.js";
/** The statuses whose tasks are a session's queued work: what it can work on now. */
const QUEUED = new Set(['open', 'in-progress']);
/**
 * Each session's queued work, the weight of its part of the team's daily budget: its top queued (open or in-progress)
 * task alone, weighed by its priority, p0 as many as there are levels (teamrig's p0 and the config's) and the last 1
 * (p0..p5: 6..1), under that priority's id. A priority the config does not list weighs 1; of two tasks that weigh the
 * same, the lower priority id is the top. A session works one task at a time, so how many it has queued does not raise
 * what it spends: a session with 40 queued p1 tasks weighs as one with a single p1, and one whose most important work
 * is low priority weighs low (T1588). A session with no queued work is not in the map.
 */
export function workWeights(tasks, priorities) {
    const ranked = priorityLevels(priorities).map((priority) => priority.id).sort((a, b) => a - b);
    const weightOf = (priority) => {
        const rank = ranked.indexOf(priority);
        return rank === -1 ? 1 : ranked.length - rank;
    };
    const tops = new Map();
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
    return new Map([...tops].map(([owner, top]) => [owner, new Map([[top.priority, top.weight]])]));
}
/** A session's queued work weighed whole: its weights summed over its priorities (from `workWeights`, its top task's alone), 0 with none. */
export function workWeightOf(work) {
    let sum = 0;
    for (const weight of work?.values() ?? []) {
        sum += weight;
    }
    return sum;
}
/** No queued work: every part falls back to its session's `share`, and no session has p0 work. */
export const NO_WORK = { weights: new Map(), urgent: new Map() };
/** The sessions' queued work: `workWeights`, and each session's open and in-progress p0 tasks. */
export function queuedWork(tasks, priorities) {
    const queued = [...tasks].filter((task) => QUEUED.has(task.status));
    const urgent = new Map();
    for (const task of queued) {
        if (task.priority === NOW_PRIORITY.id) {
            urgent.set(task.owner, [...(urgent.get(task.owner) ?? []), task.id]);
        }
    }
    return { weights: workWeights(queued, priorities), urgent };
}
/** The sessions' queued work, replayed from the register's working set; a register that cannot be read throws. */
async function replayWork(files, eventsPath, priorities) {
    const { state } = await new JsonlEventLog(files, eventsPath).read();
    return queuedWork(state.tasks.values(), priorities);
}
/**
 * The sessions' queued work, read from the register at `eventsPath`; none when the register cannot be read, so
 * every part falls back to its session's `share` and a damaged register never stops the budget.
 */
export async function readWork(files, eventsPath, priorities) {
    try {
        return await replayWork(files, eventsPath, priorities);
    }
    catch {
        return NO_WORK;
    }
}
/** The work cache's file in the usage folder: a name no session id can have, so it is never taken for a session's usage file. */
export const WORK_CACHE_FILE = 'work.cache.json';
/**
 * The work cache's format (2: with each session's p0 ids; 3: each session's weights by priority id; 4: its top task's
 * weight only, T1588, so a format-3 cache of every task's weights is read again); a cache in any other reads as
 * missing and is written again.
 */
const WORK_CACHE_FORMAT = 4;
function sameKey(a, b) {
    return a.tail === b.tail && a.snapshot === b.snapshot && a.priorities.length === b.priorities.length && a.priorities.every((id, index) => id === b.priorities[index]);
}
/** A stored stamp: its text, or null for a file that was missing; undefined when the value is neither. */
function storedStamp(value) {
    return value === null || typeof value === 'string' ? value : undefined;
}
function isNumberArray(value) {
    return Array.isArray(value) && value.every((each) => typeof each === 'number');
}
function isStringArray(value) {
    return Array.isArray(value) && value.every((each) => typeof each === 'string');
}
/** The stored p0 ids by session; undefined when any entry is not a list of ids. */
function storedUrgent(value) {
    const urgent = new Map();
    for (const [session, ids] of Object.entries(value)) {
        if (!isStringArray(ids)) {
            return undefined;
        }
        urgent.set(session, ids);
    }
    return urgent;
}
/** A session's stored weights by priority id; undefined when it is not a record of whole priority ids to finite weights. */
function storedByPriority(value) {
    if (!isRecord(value)) {
        return undefined;
    }
    const byPriority = new Map();
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
function parseWorkCache(text) {
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
    const weights = new Map();
    for (const [session, stored] of Object.entries(work)) {
        const byPriority = storedByPriority(stored);
        if (byPriority === undefined) {
            return undefined;
        }
        weights.set(session, byPriority);
    }
    return { key: { tail, snapshot, priorities }, work: { weights, urgent } };
}
function formatWorkCache(key, work) {
    const weights = Object.fromEntries([...work.weights].map(([session, byPriority]) => [session, Object.fromEntries(byPriority)]));
    return JSON.stringify({ [VERSION_FIELD]: WORK_CACHE_FORMAT, key, work: weights, urgent: Object.fromEntries(work.urgent) });
}
/** The key of a reading taken now; undefined when a stamp cannot be taken. */
async function workKeyOf(files, eventsPath, priorities) {
    const { tail, snapshot } = layoutPaths(eventsPath);
    try {
        return { tail: (await files.stamp(tail)) ?? null, snapshot: (await files.stamp(snapshot)) ?? null, priorities: priorities.map((priority) => priority.id) };
    }
    catch {
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
export async function cachedWork(files, eventsPath, cachePath, priorities) {
    const key = await workKeyOf(files, eventsPath, priorities);
    if (key === undefined) {
        return readWork(files, eventsPath, priorities);
    }
    const cached = parseWorkCache(await files.read(cachePath).catch(() => undefined));
    if (cached !== undefined && sameKey(cached.key, key)) {
        return cached.work;
    }
    let work;
    try {
        work = await replayWork(files, eventsPath, priorities);
    }
    catch {
        return NO_WORK;
    }
    await files.write(cachePath, formatWorkCache(key, work)).catch(() => undefined);
    return work;
}
