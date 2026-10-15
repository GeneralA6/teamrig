import { isDeepStrictEqual } from 'node:util';
import { toJsonlLine } from "../core/jsonl.js";
import { compactRegister } from "./compaction.js";
import { assemble, historyPlan, readPlan, readSnapshotText, workingSetPlan } from "./layout.js";
import { markerRecord } from "./marker.js";
import { isWritable, readEvents } from "./snapshot.js";
/**
 * A tail this long makes a write rotate a register rotated before (about 1,500 events, a few days of a busy
 * team), so a read costs at most about this much beyond the working set, unless the team set
 * `register.autoArchive` to false. The first rotation is always a person's, with `teamrig compact`: every
 * session must run a teamrig that reads the rotated layout first.
 */
export const AUTO_ROTATE_CHARS = 512 * 1024;
/** A rotation refused for the problems its plan found; nothing was written. */
export class RotationRefusedError extends Error {
    problems;
    constructor(problems) {
        super(`the rotation is refused, nothing was written: ${problems.join('; ')}`);
        this.name = 'RotationRefusedError';
        this.problems = problems;
    }
}
function taskIds(snapshot) {
    return new Set(snapshot.state.tasks.keys());
}
/** The counts a reader warns about or plans from, which a working set must carry as the history has them. */
function countsOf(snapshot) {
    const { state, read } = snapshot;
    return { nextId: state.nextId, orphans: state.orphans, unreadable: read.unreadable, newer: read.newer, newestVersion: read.newestVersion };
}
function countProblems(what, actual, expected) {
    const want = countsOf(expected);
    return Object.entries(countsOf(actual))
        .filter(([key, value]) => want[key] !== value)
        .map(([key, value]) => `${what} has ${key} ${String(value)} where ${String(want[key])} is expected`);
}
/**
 * The new files read back as a reader reads them (the snapshot, then the marker alone as the tail), held
 * against the source on every task and count: any difference is a problem that refuses the rotation.
 */
export function readBack(source, compaction, markerText) {
    const snapshot = readSnapshotText(compaction.text);
    if (snapshot.kind !== 'usable') {
        return { unchanged: 0, problems: [`the new snapshot does not read back: ${snapshot.kind === 'unusable' ? snapshot.reason : 'it is not there'}`] };
    }
    const tail = readEvents(markerText);
    const plan = workingSetPlan(snapshot, tail);
    const rebuilt = assemble(plan, [], tail);
    const retired = new Set(compaction.retiredNow);
    const problems = countProblems('the new working set', rebuilt, source);
    let unchanged = 0;
    for (const [id, task] of source.state.tasks) {
        const after = rebuilt.state.tasks.get(id);
        if (retired.has(id)) {
            if (after !== undefined)
                problems.push(`${id} is retired and still in the new working set`);
        }
        else if (isDeepStrictEqual(after, task)) {
            unchanged += 1;
        }
        else {
            problems.push(`${id} folds otherwise from the new files`);
        }
    }
    const extra = [...taskIds(rebuilt)].filter((id) => !source.state.tasks.has(id));
    problems.push(...extra.map((id) => `${id} is in the new working set and not in the old`));
    return { unchanged, problems };
}
/** The working set held against the whole history: equal on every task it keeps; the rest finished and counted as retired. */
function historyProblems(working, history) {
    const problems = countProblems('the working set', working, history);
    for (const [id, task] of history.state.tasks) {
        const kept = working.state.tasks.get(id);
        if (kept === undefined) {
            if (task.status !== 'done' && task.status !== 'dropped')
                problems.push(`${id} is ${task.status} in the history and missing from the working set`);
        }
        else if (!isDeepStrictEqual(kept, task)) {
            problems.push(`${id} folds otherwise in the working set than in the history`);
        }
    }
    const missing = history.state.tasks.size - working.state.tasks.size;
    if (missing !== (working.retired?.count ?? 0)) {
        problems.push(`the working set counts ${working.retired?.count ?? 0} retired task(s) where the history has ${missing} outside it`);
    }
    return problems;
}
/**
 * Lines from a newer teamrig refuse a rotation: the new snapshot holds only the events this code reads, so
 * it would drop them from the working set, and the next reader would fold their tasks to an older status.
 */
function newerProblems(read) {
    if (!isWritable(read)) {
        return [`the register has lines from a newer teamrig (v${read.newestVersion}): update teamrig before rotating it`];
    }
    return read.newer === 0 ? [] : [`the register has ${read.newer} line(s) from a newer teamrig: update teamrig before rotating it`];
}
/** The segment file the tail would become, when one is there already: a leftover, or a problem. */
async function segmentProblem(files, path, tailText) {
    const existing = await files.read(path);
    if (existing === undefined) {
        return { leftover: false, problem: null };
    }
    if (tailText.startsWith(existing)) {
        return { leftover: true, problem: null };
    }
    return { leftover: true, problem: `${path} is there and is not the start of the tail: move it aside by hand, then rotate again` };
}
/**
 * Reads the register and plans its rotation, writing nothing: a dry run is this plan alone. `tailText`,
 * when given, is the tail as the caller just read it under the lock, so it is not read twice.
 */
export async function planRotation(files, paths, options, tailText) {
    const snapshotRead = readSnapshotText(await files.read(paths.snapshot));
    const text = tailText ?? (await files.read(paths.tail)) ?? '';
    const tail = readEvents(text);
    const working = workingSetPlan(snapshotRead, tail);
    const readPlanUsed = working.skipped === undefined ? working : historyPlan(tail);
    const source = await readPlan(files, paths, readPlanUsed, tail);
    const segment = tail.rotatedAfter + 1;
    const compaction = compactRegister(source, { covered: segment, now: options.now, retainDays: options.retainDays, keep: options.keep });
    const markerText = toJsonlLine(markerRecord(segment, options.now.toISOString()));
    const back = readBack(source, compaction, markerText);
    const existing = await segmentProblem(files, paths.segment(segment), text);
    const fromHistory = readPlanUsed.base === undefined;
    const history = options.checkHistory && !fromHistory ? await readPlan(files, paths, historyPlan(tail), tail) : null;
    const problems = [
        ...newerProblems(source.read),
        ...(existing.problem === null ? [] : [existing.problem]),
        ...back.problems,
        ...(history === null ? [] : historyProblems(source, history)),
    ];
    const checked = history ?? (options.checkHistory ? source : null);
    return {
        segment,
        tailText: text,
        tailEvents: tail.events.length,
        source: fromHistory ? 'history' : 'working set',
        skippedSnapshot: working.skipped?.reason ?? null,
        sourceEvents: source.read.events.length,
        compaction,
        markerText,
        unchanged: back.unchanged,
        leftover: existing.leftover,
        history: checked === null ? null : { tasks: checked.state.tasks.size, events: checked.read.events.length },
        idle: tail.events.length === 0 && compaction.retiredNow.length === 0 && (!fromHistory || source.read.events.length === 0),
        problems,
    };
}
/** Writes a plan's rotation in the order that keeps every step readable; refused, with nothing written, when the plan found problems. */
export async function applyRotation(files, paths, plan) {
    if (plan.problems.length > 0) {
        throw new RotationRefusedError(plan.problems);
    }
    const segment = paths.segment(plan.segment);
    if (plan.leftover) {
        await files.write(segment, plan.tailText);
    }
    else if (!(await files.createExclusive(segment, plan.tailText))) {
        throw new RotationRefusedError([`${segment} appeared while the rotation ran: another writer is not taking the register's lock`]);
    }
    await files.write(paths.tail, plan.markerText);
    await files.write(paths.snapshot, plan.compaction.text);
}
