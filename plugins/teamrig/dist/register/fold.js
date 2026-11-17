import { withAudit } from "./hand-step.js";
import { namesApprovedHead, namesUnapprovedCommit } from "./head-sha.js";
import { WAIT_STATUSES } from "./model.js";
import { namesNewWait, sameWait } from "./waits.js";
/** The numeric part of a task id (`T12` → 12). */
export function taskNumber(id) {
    return Number(id.slice(1));
}
/**
 * Replays events in write order, one at a time. A task's state depends on its own events only, so
 * replaying one task's events gives the same task as replaying the whole log: a compaction keeps the
 * events of the tasks it keeps and nothing else (compaction.ts). A moved event takes its task out of the
 * register: the id is the other team's from then on, and any event on it here is an orphan, a create too.
 */
export class RegisterFold {
    tasks;
    moved;
    orphans;
    maxId;
    /**
     * `from`: the state to go on from (its tasks are copied, never changed). `seenIds` are ids found on
     * lines that did not parse (damaged or newer records): they still count towards the next id, so an
     * id is never handed out twice.
     */
    constructor(from, seenIds = []) {
        this.tasks = new Map(from?.tasks);
        this.moved = new Map(from?.moved);
        this.orphans = from?.orphans ?? 0;
        const floor = from === undefined ? 0 : taskNumber(from.nextId) - 1;
        this.maxId = seenIds.reduce((max, id) => Math.max(max, taskNumber(id)), floor);
    }
    /** Applies one event; false when it names no task, creates one twice or names one that moved: an orphan, counted and ignored. */
    apply(event) {
        this.maxId = Math.max(this.maxId, taskNumber(event.id));
        if (this.moved.has(event.id)) {
            return this.orphan();
        }
        const current = this.tasks.get(event.id);
        if (event.type === 'create') {
            if (current !== undefined) {
                return this.orphan();
            }
            this.tasks.set(event.id, created(event.id, event.task, event.at, event.by));
            return true;
        }
        if (current === undefined) {
            return this.orphan();
        }
        if (event.type === 'moved') {
            this.tasks.delete(event.id);
            this.moved.set(event.id, event.to);
            return true;
        }
        this.tasks.set(event.id, event.type === 'status' ? withStatus(current, event) : withChanges(current, event));
        return true;
    }
    /** The state so far. Its maps are copies, so later events never change a state already handed out. */
    state() {
        return { tasks: new Map(this.tasks), orphans: this.orphans, nextId: `T${this.maxId + 1}`, moved: new Map(this.moved) };
    }
    orphan() {
        this.orphans += 1;
        return false;
    }
}
/** Replays events in write order, from an empty register or from `from`; `seenIds` as in RegisterFold. */
export function foldEvents(events, seenIds = [], from) {
    const fold = new RegisterFold(from, seenIds);
    events.forEach((event) => fold.apply(event));
    return fold.state();
}
function created(id, fields, at, by) {
    return {
        ...fields,
        id,
        status: 'open',
        note: null,
        evidence: null,
        skill: null,
        waits: [],
        card: null,
        answer: null,
        decided: null,
        proof: null,
        watch: null,
        reparks: 0,
        followups: [],
        review: {},
        sizeBase: null,
        audits: [],
        securityVerdict: null,
        startedAt: null,
        createdAt: at,
        createdBy: by,
        updatedAt: at,
        updatedBy: by,
        assignedAt: at,
        statusAt: at,
        waitsAt: at,
        priorityAt: at,
        ownerSeenAt: by === fields.owner ? at : null,
    };
}
/**
 * The answer a status keeps: an approval, when the task stays waiting and names the approved wait again. A new hold
 * behind another task or a time (T2117) keeps it while its note names no commit the approval's note does not, and
 * `check` flags the task READY once the hold clears, the owner's wake to merge. The same waits set again keep it only
 * when the note names the approved head (T3044, T3094): say a merge a classifier
 * refused, logged with the head. A restated wait with no head in its note reads as "new head ready, please
 * re-approve", the way to ask anew, so it clears the answer and the lead is asked; a note naming another head is a new
 * ask too, as `ship.ts merge` takes only the head the answer's note names. Any other status, a new decision or
 * approval wait, or a declined answer clears it.
 */
function keptAnswer(task, status, waits, note) {
    const { answer } = task;
    if (answer === null || answer.verdict !== 'approved' || status !== 'waiting' || task.status !== 'waiting') {
        return null;
    }
    const approved = { kind: 'approval', who: answer.by };
    const holds = [task.waits, waits].every((each) => each.some((reason) => sameWait(reason, approved)));
    const added = waits.filter((reason) => !task.waits.some((held) => sameWait(held, reason)));
    const sameHead = added.length === 0 ? namesApprovedHead(note, answer.note) : !namesUnapprovedCommit(note, answer.note);
    return holds && sameHead && added.every((reason) => reason.kind === 'task' || reason.kind === 'time') ? answer : null;
}
/** The statuses that end the step an approval was for: the change merged and waits on its proof, landed, or was given up. */
const STEP_ENDS = ['verifying', 'done', 'dropped'];
/**
 * The approval a status change would clear before its step ends (T3207): a set that only records progress, such as
 * in-progress with a note once the approved merge is queued, clears the approval as any new status does, and the merge
 * is then refused. Null when the task holds no approval, the status ends its step, or it keeps the answer (`keptAnswer`,
 * which reads the set's note for a head the approval does not name).
 */
export function droppedApproval(task, status, waits, note) {
    const { answer } = task;
    if (answer === null || answer.verdict !== 'approved' || STEP_ENDS.includes(status)) {
        return null;
    }
    return keptAnswer(task, status, waits, note) === null ? answer : null;
}
function withStatus(task, event) {
    const waits = WAIT_STATUSES.includes(event.status) ? (event.waits ?? []) : [];
    const answer = keptAnswer(task, event.status, waits, event.note);
    return {
        ...task,
        status: event.status,
        statusAt: event.status === task.status ? task.statusAt : event.at,
        waitsAt: namesNewWait(task.answer === null || answer !== null ? task.waits : [], waits) ? event.at : task.waitsAt,
        note: event.note,
        evidence: event.evidence ?? task.evidence,
        skill: event.skill,
        waits,
        card: WAIT_STATUSES.includes(event.status) ? (event.card ?? null) : null,
        answer,
        decided: null,
        proof: event.status === 'verifying' ? (event.proof ?? null) : null,
        watch: event.status === 'done' ? (event.watch ?? null) : null,
        reparks: reparksAfter(task, event),
        followups: event.followups === undefined ? task.followups : [...new Set([...task.followups, ...event.followups])],
        review: event.review === undefined ? task.review : { ...task.review, ...event.review },
        startedAt: task.startedAt ?? (event.status === 'in-progress' || event.status === 'verifying' ? event.at : null),
        updatedAt: event.at,
        updatedBy: event.by,
        ownerSeenAt: event.by === task.owner ? event.at : task.ownerSeenAt,
    };
}
/** True when setting `status` with `waits` re-parks the task's proof, as {@link Task.reparks} counts it. */
export function isRepark(task, status, waits) {
    return status === 'verifying' && task.status === 'verifying' && task.waits.length > 0 && namesNewWait(task.waits, waits);
}
function reparksAfter(task, event) {
    if (event.status !== 'verifying') {
        return 0;
    }
    return isRepark(task, event.status, event.waits ?? []) ? task.reparks + 1 : task.reparks;
}
/**
 * An update's note from the task's owner is its note from then on, as a restated one on `set` is, so show and the
 * waiting text print it at once; a note from any other session adds context to the history only, since the note a
 * task shows is its owner's (T630). An update with a `verdict` is the lead's answer to the task's approval wait, its
 * note what the lead checked (T684). An update's `waits` (a Later, T1295, or a Decided, T1366) replace a waiting or
 * verifying task's, so the time the owner put it off to is one of its waits, or the owner's wait is gone; a Decided
 * marks the task `decided`. On a task in any other status they mean nothing. A pin holds for the owner it was set for:
 * handing the task on clears it, unless the same update pins it (T637). An update that gives a size, or clears it,
 * gives its size base too (T649). An update with an `audit` pins a hand step file for the task, by the session that
 * wrote it (T2312).
 */
function withChanges(task, { changes, note, at, by, verdict, waits, decided, sizeBase, audit, securityVerdict }) {
    const priorityAt = changes.priority === undefined || changes.priority === task.priority ? task.priorityAt : at;
    const shown = note !== null && by === task.owner ? note : task.note;
    const answer = verdict === undefined ? task.answer : { verdict, by, at, note };
    const waitable = WAIT_STATUSES.includes(task.status);
    const kept = waits !== undefined && waitable ? waits : task.waits;
    const decision = decided === true && waitable ? { by, at, note } : task.decided;
    const base = changes.size === undefined ? task.sizeBase : (sizeBase ?? null);
    const next = {
        ...task,
        ...changes,
        note: shown,
        answer,
        decided: decision,
        waits: kept,
        waitsAt: namesNewWait(task.waits, kept) ? at : task.waitsAt,
        sizeBase: base,
        audits: audit === undefined ? task.audits : withAudit(task.audits, { ...audit, by, at }),
        securityVerdict: securityVerdict === undefined ? task.securityVerdict : { ...securityVerdict, by, at },
        updatedAt: at,
        updatedBy: by,
        priorityAt,
    };
    if (next.owner !== task.owner) {
        return { ...next, pin: changes.pin ?? null, assignedAt: at, ownerSeenAt: by === next.owner ? at : null };
    }
    return { ...next, ownerSeenAt: by === next.owner ? at : task.ownerSeenAt };
}
