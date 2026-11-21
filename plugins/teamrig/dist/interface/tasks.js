import { refOf } from "./ref.js";
import { sourceOf } from "./source.js";
import { ServedText } from "./text.js";
/**
 * The `tasks` document's body. It makes its own `ServedText`, so `cuts` lists this document's cuts and no other's;
 * a task left out by `owner` is never scanned, so it adds no cut.
 */
export function tasksBody(input) {
    const served = new ServedText(input.shapes);
    const tasks = [];
    for (const task of input.tasks) {
        if (input.owner === null || task.owner === input.owner) {
            tasks.push(servedTask(task, served, input));
        }
    }
    return { tasks, cuts: served.cuts };
}
function servedTask(task, served, input) {
    const source = sourceOf(served, task.id, task.source, input.names);
    // A tracker's import carries its author's words: only the title and the description hold them, the rest is the team's.
    const wrote = source.kind === 'connector' ? 'outside' : 'team';
    return {
        id: task.id,
        title: served.marked(task.id, 'title', task.title, wrote),
        description: served.markedOrNull(task.id, 'description', task.description, wrote),
        owner: task.owner,
        priority: task.priority,
        type: task.type,
        critical: task.critical,
        due: task.due,
        status: task.status,
        note: served.plainOrNull(task.id, 'note', task.note),
        proof: served.plainOrNull(task.id, 'proof', task.proof),
        evidence: served.plainOrNull(task.id, 'evidence', task.evidence),
        skill: served.plainOrNull(task.id, 'skill', task.skill),
        statusAt: task.statusAt,
        source,
        ref: refOf(served, task.id, task.ref, input.connectors),
        goals: [...task.goals],
        week: task.week,
        size: task.size,
        pin: task.pin,
        workClass: task.workClass,
        createdBy: task.createdBy,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
        updatedBy: task.updatedBy,
        priorityAt: task.priorityAt,
        assignedAt: task.assignedAt,
        ownerSeenAt: task.ownerSeenAt,
        waits: task.waits.map(servedWait),
        answer: task.answer === null
            ? null
            : { verdict: task.answer.verdict, by: task.answer.by, at: task.answer.at, note: served.plainOrNull(task.id, 'answer.note', task.answer.note) },
        decided: task.decided === null ? null : { by: task.decided.by, at: task.decided.at, note: served.plainOrNull(task.id, 'decided.note', task.decided.note) },
        after: [...task.after],
    };
}
/** A wait written out field by field, so a field the register adds to a reason is not served by accident. */
export function servedWait(reason) {
    switch (reason.kind) {
        case 'decision':
        case 'approval':
            return { kind: reason.kind, who: reason.who };
        case 'task':
            return { kind: 'task', id: reason.id };
        case 'time':
            return { kind: 'time', at: reason.at };
    }
}
