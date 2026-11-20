import { isNonNegativeInteger, isRecord, type JsonRecord } from '../core/guards.ts';
import { parseCard, type DecisionCard } from './card.ts';
import { parseDescriptionCut } from './description-cut.ts';
import { isApprovalVerdict, parseCompleteTaskFields, parseFollowups, parseSizeBase, type SizeBase } from './events.ts';
import type { ApprovalAnswer, OwnerDecision, Task } from './fold.ts';
import { parseAuditPin, type HandStepAudit } from './hand-step.ts';
import { isTaskStatus, TASK_ID } from './model.ts';
import { parseReview } from './review.ts';
import { parseSecurityVerdictPin, type SecurityVerdict } from './security-verdict.ts';
import { parseWaits } from './waits.ts';

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
export function taskLineRecord(v: number, task: Task): JsonRecord {
  return { v, type: TASK_LINE_TYPE, task };
}

/** True for a record a task line holds, whatever it says of its task. */
export function isTaskLine(record: JsonRecord): boolean {
  return record['type'] === TASK_LINE_TYPE;
}

type TextKey = 'createdAt' | 'createdBy' | 'updatedAt' | 'updatedBy' | 'assignedAt' | 'statusAt' | 'waitsAt' | 'priorityAt';
const TEXT_KEYS: readonly TextKey[] = ['createdAt', 'createdBy', 'updatedAt', 'updatedBy', 'assignedAt', 'statusAt', 'waitsAt', 'priorityAt'];

type NullableTextKey = 'note' | 'evidence' | 'skill' | 'proof' | 'watch' | 'startedAt' | 'ownerSeenAt';
const NULLABLE_TEXT_KEYS: readonly NullableTextKey[] = ['note', 'evidence', 'skill', 'proof', 'watch', 'startedAt', 'ownerSeenAt'];

function textsOf(record: JsonRecord): Record<TextKey, string> | string {
  const texts: Record<TextKey, string> = { createdAt: '', createdBy: '', updatedAt: '', updatedBy: '', assignedAt: '', statusAt: '', waitsAt: '', priorityAt: '' };
  for (const key of TEXT_KEYS) {
    const value = record[key];
    if (typeof value !== 'string') {
      return `${key} is not text`;
    }
    texts[key] = value;
  }
  return texts;
}

function nullableTextsOf(record: JsonRecord): Record<NullableTextKey, string | null> | string {
  const texts: Record<NullableTextKey, string | null> = { note: null, evidence: null, skill: null, proof: null, watch: null, startedAt: null, ownerSeenAt: null };
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
function signed(value: JsonRecord): { readonly by: string; readonly at: string } | undefined {
  const { by, at } = value;
  return typeof by === 'string' && typeof at === 'string' ? { by, at } : undefined;
}

function noteOf(value: JsonRecord): string | null | undefined {
  const note = value['note'];
  return note === null || typeof note === 'string' ? note : undefined;
}

function parseAnswer(value: unknown): ApprovalAnswer | null | string {
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

function parseDecided(value: unknown): OwnerDecision | null | string {
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

function parseCardOrNull(value: unknown): DecisionCard | null | string {
  const card = parseCard(value);
  return card ?? null;
}

function parseSizeBaseOrNull(value: unknown): SizeBase | null | string {
  return value === null ? null : parseSizeBase(value);
}

function parseAudits(value: unknown): readonly HandStepAudit[] | string {
  if (!Array.isArray(value)) {
    return 'audits is not a list';
  }
  const audits: HandStepAudit[] = [];
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

function parseVerdict(value: unknown): SecurityVerdict | null | string {
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
export function parseTaskLine(record: JsonRecord): Task | string {
  const task = record['task'];
  if (!isTaskLine(record) || !isRecord(task)) {
    return 'not a task line';
  }
  const { id, status, reparks } = task;
  if (typeof id !== 'string' || !TASK_ID.test(id)) {
    return `id ${JSON.stringify(id)} is not a task id`;
  }
  const problem = (text: string): string => `${id}: ${text}`;
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
