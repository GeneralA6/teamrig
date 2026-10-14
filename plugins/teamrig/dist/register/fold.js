/** The numeric part of a task id (`T12` → 12). */
export function taskNumber(id) {
    return Number(id.slice(1));
}
/**
 * Replays events in write order. `seenIds` are ids found on lines that did not parse (damaged or
 * newer records): they still count towards the next id, so an id is never handed out twice.
 */
export function foldEvents(events, seenIds = []) {
    const tasks = new Map();
    let orphans = 0;
    let maxId = seenIds.reduce((max, id) => Math.max(max, taskNumber(id)), 0);
    for (const event of events) {
        maxId = Math.max(maxId, taskNumber(event.id));
        const current = tasks.get(event.id);
        if (event.type === 'create') {
            if (current === undefined) {
                tasks.set(event.id, created(event.id, event.task, event.at, event.by));
            }
            else {
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
function created(id, fields, at, by) {
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
function withStatus(task, event) {
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
function withChanges(task, changes, at, by) {
    const next = { ...task, ...changes, updatedAt: at, updatedBy: by };
    if (next.owner !== task.owner) {
        return { ...next, assignedAt: at, ownerSeenAt: by === next.owner ? at : null };
    }
    return { ...next, ownerSeenAt: by === next.owner ? at : task.ownerSeenAt };
}
