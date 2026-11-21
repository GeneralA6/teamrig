import { isNonNegativeInteger, isRecord } from "../core/guards.js";
import { parseCard } from "./card.js";
import { parseDescriptionCut } from "./description-cut.js";
import { isApprovalVerdict, parseCompleteTaskFields, parseFollowups, parseSizeBase } from "./events.js";
import { parseAuditPin } from "./hand-step.js";
import { isTaskStatus, TASK_ID } from "./model.js";
import { parseReview } from "./review.js";
import { parseSecurityVerdictPin } from "./security-verdict.js";
import { parseWaits } from "./waits.js";
// No node: import here: the layout reads task lines, and the read entry (src/read) runs without Node's modules.
/**
 * A task's folded state as one line of the snapshot (T4076): the snapshot keeps one such line per task instead of its
 * events, so its size follows the tasks kept, not their history. The line holds the task whole, `{type: 'task', task}`
 * (the task has a `type` of its own), and reads back to exactly the task written. A line missing a field this code
 * folds is no task line: a snapshot written before a new fold field existed is then skipped for the history, which
 * folds it, until the next compaction writes the field.
 */
/** The `type` of a task line. */
export const TASK_LINE_TYPE = 'task';
/** The record a task line holds, under the layout version `v` the snapshot it sits in was written at. */
export function taskLineRecord(v, task) {
    return { v, type: TASK_LINE_TYPE, task };
}
/** True for a record a task line holds, whatever it says of its task. */
export function isTaskLine(record) {
    return record['type'] === TASK_LINE_TYPE;
}
const TEXT_KEYS = ['createdAt', 'createdBy', 'updatedAt', 'updatedBy', 'assignedAt', 'statusAt', 'waitsAt', 'priorityAt'];
const NULLABLE_TEXT_KEYS = ['note', 'evidence', 'skill', 'proof', 'watch', 'startedAt', 'ownerSeenAt'];
function textsOf(record) {
    const texts = { createdAt: '', createdBy: '', updatedAt: '', updatedBy: '', assignedAt: '', statusAt: '', waitsAt: '', priorityAt: '' };
    for (const key of TEXT_KEYS) {
        const value = record[key];
        if (typeof value !== 'string') {
            return `${key} is not text`;
        }
        texts[key] = value;
    }
    return texts;
}
function nullableTextsOf(record) {
    const texts = { note: null, evidence: null, skill: null, proof: null, watch: null, startedAt: null, ownerSeenAt: null };
    for (const key of NULLABLE_TEXT_KEYS) {
        const value = record[key];
        if (value !== null && typeof value !== 'string') {
            return `${key} is neither text nor null`;
        }
        texts[key] = value;
    }
    return texts;
}
/** Who wrote a part and when, as an answer, a decision, an audit and a verdict each carry them. */
function signed(value) {
    const { by, at } = value;
    return typeof by === 'string' && typeof at === 'string' ? { by, at } : undefined;
}
function noteOf(value) {
    const note = value['note'];
    return note === null || typeof note === 'string' ? note : undefined;
}
function parseAnswer(value) {
    if (value === null) {
        return null;
    }
    const by = isRecord(value) ? signed(value) : undefined;
    const note = isRecord(value) ? noteOf(value) : undefined;
    if (!isRecord(value) || by === undefined || note === undefined || !isApprovalVerdict(value['verdict'])) {
        return `bad answer ${JSON.stringify(value)}`;
    }
    return { verdict: value['verdict'], ...by, note };
}
function parseDecided(value) {
    if (value === null) {
        return null;
    }
    const by = isRecord(value) ? signed(value) : undefined;
    const note = isRecord(value) ? noteOf(value) : undefined;
    if (by === undefined || note === undefined) {
        return `bad decision ${JSON.stringify(value)}`;
    }
    return { ...by, note };
}
function parseCardOrNull(value) {
    const card = parseCard(value);
    return card ?? null;
}
function parseSizeBaseOrNull(value) {
    return value === null ? null : parseSizeBase(value);
}
function parseAudits(value) {
    if (!Array.isArray(value)) {
        return 'audits is not a list';
    }
    const audits = [];
    for (const item of value) {
        const pin = parseAuditPin(item);
        const by = isRecord(item) ? signed(item) : undefined;
        if (typeof pin === 'string' || by === undefined) {
            return typeof pin === 'string' ? pin : `bad audit ${JSON.stringify(item)}`;
        }
        audits.push({ ...pin, ...by });
    }
    return audits;
}
function parseVerdict(value) {
    if (value === null) {
        return null;
    }
    const pin = parseSecurityVerdictPin(value);
    const by = isRecord(value) ? signed(value) : undefined;
    if (typeof pin === 'string' || by === undefined) {
        return typeof pin === 'string' ? pin : `bad security verdict ${JSON.stringify(value)}`;
    }
    return { ...pin, ...by };
}
/** The task a task line's record holds, or why it holds none. Never throws. */
export function parseTaskLine(record) {
    const task = record['task'];
    if (!isTaskLine(record) || !isRecord(task)) {
        return 'not a task line';
    }
    const { id, status, reparks } = task;
    if (typeof id !== 'string' || !TASK_ID.test(id)) {
        return `id ${JSON.stringify(id)} is not a task id`;
    }
    const problem = (text) => `${id}: ${text}`;
    if (!isTaskStatus(status)) {
        return problem(`status ${JSON.stringify(status)} is not a status`);
    }
    if (!isNonNegativeInteger(reparks)) {
        return problem('reparks is not a count');
    }
    const fields = parseCompleteTaskFields(task);
    if (typeof fields === 'string') {
        return problem(fields);
    }
    const texts = textsOf(task);
    if (typeof texts === 'string') {
        return problem(texts);
    }
    const nullable = nullableTextsOf(task);
    if (typeof nullable === 'string') {
        return problem(nullable);
    }
    const waits = parseWaits(task['waits']);
    if (typeof waits === 'string') {
        return problem(waits);
    }
    const card = parseCardOrNull(task['card']);
    if (typeof card === 'string') {
        return problem(card);
    }
    const answer = parseAnswer(task['answer']);
    if (typeof answer === 'string') {
        return problem(answer);
    }
    const decided = parseDecided(task['decided']);
    if (typeof decided === 'string') {
        return problem(decided);
    }
    const followups = parseFollowups(task['followups']) ?? 'followups is missing';
    if (typeof followups === 'string') {
        return problem(followups);
    }
    const review = parseReview(task['review']) ?? 'review is missing';
    if (typeof review === 'string') {
        return problem(review);
    }
    const sizeBase = parseSizeBaseOrNull(task['sizeBase']);
    if (typeof sizeBase === 'string') {
        return problem(sizeBase);
    }
    const audits = parseAudits(task['audits']);
    if (typeof audits === 'string') {
        return problem(audits);
    }
    const securityVerdict = parseVerdict(task['securityVerdict']);
    if (typeof securityVerdict === 'string') {
        return problem(securityVerdict);
    }
    const descriptionCut = parseDescriptionCut(task['descriptionCut']);
    if (typeof descriptionCut === 'string') {
        return problem(descriptionCut);
    }
    if (descriptionCut !== null && fields.description !== null) {
        return problem('holds a description and the mark of a cut one');
    }
    return { ...fields, id, status, descriptionCut, ...nullable, waits, card, answer, decided, reparks, followups, review, sizeBase, audits, securityVerdict, ...texts };
}
