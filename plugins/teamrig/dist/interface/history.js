import { refOf } from "./ref.js";
import { sourceOf } from "./source.js";
import { servedWait } from "./tasks.js";
import { ServedText } from "./text.js";
/** A cut's record: the event the text was in, as its task and its place in `events`, counted from 0. */
export function eventKeyOf(task, place) {
    return `${task}#${place}`;
}
/**
 * The `history` document's body. A title or a description is marked by the source the task had once the event was
 * written, as the `tasks` document marks the folded ones: a tracker's import carries its author's words. An event
 * with no create before it has no known source and is marked outside, the side that escapes what it prints.
 */
export function historyBody(input) {
    const served = new ServedText(input.shapes);
    const events = [];
    let source = null;
    for (const event of input.events) {
        source = sourceAfter(event, source);
        events.push(servedEvent(event, { served, record: eventKeyOf(input.task, events.length), source, input }));
    }
    return { task: input.task, events, cuts: served.cuts };
}
/** The task's source once `event` is written. */
function sourceAfter(event, before) {
    switch (event.type) {
        case 'create':
            return event.task.source;
        case 'update':
            return event.changes.source ?? before;
        case 'status':
        case 'moved':
            return before;
    }
}
function servedEvent(event, context) {
    switch (event.type) {
        case 'create':
            return servedCreate(event, context);
        case 'status':
            return servedStatus(event, context);
        case 'update':
            return servedUpdate(event, context);
        case 'moved':
            return { kind: 'moved', at: event.at, by: event.by, to: event.to };
    }
}
function servedCreate(event, context) {
    const { served, record, input } = context;
    const { task } = event;
    const wrote = wroteOf(context);
    return {
        kind: 'create',
        at: event.at,
        by: event.by,
        task: {
            title: served.marked(record, 'task.title', task.title, wrote),
            description: served.markedOrNull(record, 'task.description', task.description, wrote),
            owner: task.owner,
            priority: task.priority,
            type: task.type,
            critical: task.critical,
            due: task.due,
            source: sourceOf(served, record, task.source, input.names),
            ref: refOf(served, record, task.ref, input.connectors),
            goals: [...task.goals],
            week: task.week,
            size: task.size,
            pin: task.pin,
            workClass: task.workClass,
            after: [...task.after],
        },
    };
}
function servedStatus(event, { served, record }) {
    return {
        kind: 'status',
        at: event.at,
        by: event.by,
        status: event.status,
        note: served.plainOrNull(record, 'note', event.note),
        evidence: served.plainOrNull(record, 'evidence', event.evidence),
        skill: served.plainOrNull(record, 'skill', event.skill),
        proof: served.plainOrNull(record, 'proof', event.proof ?? null),
        watch: served.plainOrNull(record, 'watch', event.watch ?? null),
        met: served.plainOrNull(record, 'met', event.met ?? null),
        oneCommit: event.oneCommit === true,
        waits: event.waits === undefined ? null : event.waits.map(servedWait),
        followups: event.followups === undefined ? null : [...event.followups],
    };
}
function servedUpdate(event, context) {
    return {
        kind: 'update',
        at: event.at,
        by: event.by,
        changes: servedChanges(event.changes, context),
        note: context.served.plainOrNull(context.record, 'note', event.note),
        verdict: event.verdict ?? null,
        waits: event.waits === undefined ? null : event.waits.map(servedWait),
        decided: event.decided === true,
    };
}
/** Each field an update gave, written out one by one, so a field the register adds is not served by accident. */
function servedChanges(changes, context) {
    const { served, record, input } = context;
    const wrote = wroteOf(context);
    return {
        ...(changes.title === undefined ? {} : { title: served.marked(record, 'changes.title', changes.title, wrote) }),
        ...(changes.description === undefined ? {} : { description: served.markedOrNull(record, 'changes.description', changes.description, wrote) }),
        ...(changes.owner === undefined ? {} : { owner: changes.owner }),
        ...(changes.priority === undefined ? {} : { priority: changes.priority }),
        ...(changes.type === undefined ? {} : { type: changes.type }),
        ...(changes.critical === undefined ? {} : { critical: changes.critical }),
        ...(changes.due === undefined ? {} : { due: changes.due }),
        ...(changes.source === undefined ? {} : { source: sourceOf(served, record, changes.source, input.names) }),
        ...(changes.ref === undefined ? {} : { ref: refOf(served, record, changes.ref, input.connectors) }),
        ...(changes.goals === undefined ? {} : { goals: [...changes.goals] }),
        ...(changes.week === undefined ? {} : { week: changes.week }),
        ...(changes.size === undefined ? {} : { size: changes.size }),
        ...(changes.pin === undefined ? {} : { pin: changes.pin }),
        ...(changes.workClass === undefined ? {} : { workClass: changes.workClass }),
        ...(changes.after === undefined ? {} : { after: [...changes.after] }),
    };
}
/** Who wrote the event's title and description: outside the team for a tracker's import, and where no source is known. */
function wroteOf({ source, input }) {
    const known = source !== null && !input.names.connectors.some((connector) => connector.id === source);
    return known ? 'team' : 'outside';
}
