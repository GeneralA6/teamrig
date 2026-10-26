import { isRecord } from "../core/guards.js";
import { parseObject, toJsonlLine } from "../core/jsonl.js";
import { EVENT_VERSION, TASK_LINE_VERSION } from "../register/events.js";
/**
 * The registers of a team split (T1144). The moving tasks' lines go to the child's register as they were written,
 * under the same ids, each naming a session that stays as `<parent>/<id>`; the parent's register keeps them and gets a
 * moved line for each, after which its readers send a reader of the task to the child. A staying task that names a
 * moved session as who asked or who pinned it gets an update naming it as `<child>/<id>`.
 */
/** The fields of a task's fields that name a session. */
const NAMING_FIELDS = ['owner', 'source', 'pin'];
/** The waits that name who must give them. */
const PERSON_WAITS = ['decision', 'approval'];
/** `record[key]` as a moving task names it from the child, when that differs from what it holds. */
function crossedName(record, key, border) {
    const name = record[key];
    const to = typeof name === 'string' ? border.crossing(true, name) : undefined;
    return to === undefined ? {} : { [key]: to };
}
/** The task's fields at `key`, a create's task or an update's changes, with the sessions they name crossed. */
function crossedFields(record, key, border) {
    const fields = record[key];
    if (!isRecord(fields)) {
        return {};
    }
    return { [key]: NAMING_FIELDS.reduce((crossed, field) => ({ ...crossed, ...crossedName(fields, field, border) }), fields) };
}
/** A status line's waits, with who must give a decision or an approval crossed. */
function crossedWaits(record, border) {
    const waits = record['waits'];
    if (!Array.isArray(waits)) {
        return {};
    }
    return { waits: waits.map((wait) => (isRecord(wait) && PERSON_WAITS.includes(wait['kind']) ? { ...wait, ...crossedName(wait, 'who', border) } : wait)) };
}
/**
 * One line of a moving task as the child's register holds it: who wrote it, the owner, who asked and who pinned it in
 * its task's fields, and who must give what it waits on, each crossed. A line that names no session across the border
 * stays byte for byte as written, and a crossed one keeps every field this code does not know.
 */
export function childLineOf(raw, border) {
    const record = parseObject(raw);
    if (record === undefined) {
        return raw;
    }
    const crossed = { ...record, ...crossedName(record, 'by', border), ...crossedFields(record, 'task', border), ...crossedFields(record, 'changes', border), ...crossedWaits(record, border) };
    const line = toJsonlLine(crossed).trimEnd();
    return line === toJsonlLine(record).trimEnd() ? raw : line;
}
/** The child's register: every line of the moving tasks the parent's working set holds, crossed, in write order. */
export function childRegisterOf(read, moving, border) {
    return read.events
        .flatMap((event, index) => {
        const line = read.lines[index];
        return moving.has(event.id) && line !== undefined ? [`${childLineOf(line, border)}\n`] : [];
    })
        .join('');
}
/** The change a staying task's crossed name makes: who asked it or who pinned it; undefined for a field no update writes. */
function stayingChange(rewrite) {
    if (rewrite.field === 'source') {
        return { source: rewrite.to };
    }
    return rewrite.field === 'pin' ? { pin: rewrite.to } : undefined;
}
/**
 * The parent's events of the split, written by `by` at `at`: an update for each staying task that names a moved
 * session as who asked or who pinned it, then a moved line for each moving task.
 */
export function parentEventsOf(split, child, by, at) {
    const updates = new Map();
    for (const rewrite of split.rewrites.filter((each) => !each.moves)) {
        const change = stayingChange(rewrite);
        if (change !== undefined) {
            const update = updates.get(rewrite.task) ?? { changes: {}, moved: [] };
            updates.set(rewrite.task, { changes: { ...update.changes, ...change }, moved: update.moved.includes(rewrite.from) ? update.moved : [...update.moved, rewrite.from] });
        }
    }
    const named = [...updates].map(([id, { changes, moved }]) => ({ v: TASK_LINE_VERSION, id, at, by, type: 'update', changes, note: `${moved.join(', ')} moved to team ${child}` }));
    const moves = split.moving.map((task) => ({ v: EVENT_VERSION, id: task.id, at, by, type: 'moved', to: child }));
    return [...named, ...moves];
}
/** The fields a split must leave as they were on every task it moves. */
const KEPT_FIELDS = ['status', 'title', 'owner', 'priority', 'due'];
/**
 * What the two registers read after the split gets wrong, empty when nothing: the child must hold exactly the tasks
 * that moved, each as it was, and the parent must send each to the child.
 */
export function splitProblems(moving, child, parent, team) {
    const problems = [];
    const ids = new Set(moving.map((task) => task.id));
    const stray = [...child.tasks.keys()].filter((id) => !ids.has(id));
    if (stray.length > 0) {
        problems.push(`team ${team}'s register holds ${stray.join(', ')}, which did not move`);
    }
    for (const task of moving) {
        const moved = child.tasks.get(task.id);
        if (moved === undefined) {
            problems.push(`${task.id} is missing from team ${team}'s register`);
        }
        else {
            const changed = KEPT_FIELDS.filter((field) => moved[field] !== task[field]);
            if (changed.length > 0) {
                problems.push(`${task.id} reads with another ${changed.join(', ')} in team ${team}'s register`);
            }
        }
        if (parent.moved.get(task.id) !== team) {
            problems.push(`${task.id} does not read as moved to team ${team} in the parent's register`);
        }
    }
    return problems;
}
