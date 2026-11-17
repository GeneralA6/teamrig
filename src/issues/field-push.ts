import type { IssueFieldsConfig, IssueKind } from '../config/types.ts';
import { parseUtcDay, parseUtcDeadline } from '../core/time.ts';
import type { TimeZone } from '../core/zone.ts';
import type { Task } from '../register/fold.ts';
import { DESIGN_LABEL } from './design-label.ts';
import type { FieldKind, FieldValue, HostField, HostFieldRead } from './fields.ts';
import type { IssueTarget } from './host.ts';
import { heldIssue, isGoal } from './status-push.ts';

/** A fields read that found fields or types. */
export type FieldsRead = Extract<HostFieldRead, { readonly kind: 'read' }>;

/** One write the field push plans: a field's value, or the issue's type, with what the issue held before. */
export type FieldWrite =
  | { readonly kind: 'field'; readonly task: string; readonly target: IssueTarget; readonly field: HostField; readonly value: FieldValue; readonly was: FieldValue | undefined }
  | { readonly kind: 'type'; readonly task: string; readonly target: IssueTarget; readonly type: string; readonly was: string | undefined };

/** The field push of one repository: the writes it sends now, how many wait for a later run, and what it skipped. */
export interface FieldPlan {
  readonly writes: readonly FieldWrite[];
  readonly deferred: number;
  readonly notes: readonly string[];
}

/** What one repository's field push is planned from. */
export interface FieldPushInput {
  readonly repo: string;
  readonly read: FieldsRead;
  readonly tasks: Iterable<Task>;
  /** The labels each open issue of the repository carries, by number, as the list read found them. */
  readonly labelsOf: (number: number) => readonly string[];
  readonly config: IssueFieldsConfig;
  /** The team's zone, the clock a start day is read on. */
  readonly zone: TimeZone;
  /** A task's score in its tree's ranking now; undefined when it has none. */
  readonly scoreOf: (task: Task) => number | undefined;
  /** The writes this repository may send, what the run left. */
  readonly writes: number;
}

/** Each value the push writes: the config key that names its field, the kind that field must be, and the task's value for it. */
interface FieldRule {
  readonly key: 'priority' | 'startDate' | 'targetDate' | 'score';
  readonly kind: FieldKind;
  readonly value: (task: Task, field: HostField) => FieldValue | undefined;
}

/**
 * Plans the field push of one repository (T3406): for each open issue a task holds, its priority, start day, due day
 * and score into the fields the config names, and its type, each only where it differs from what the issue holds.
 * One way: the register is the truth, so a value set by hand on the issue is set back, and nothing is cleared. A
 * field the repository lacks, of another kind, or with no option for a priority, is skipped and noted once. Past
 * `writes`, the rest is counted as deferred for the next run.
 */
export function planFieldPush(input: FieldPushInput): FieldPlan {
  const { repo, read, config } = input;
  const notes = new Set<string>();
  const rules: readonly FieldRule[] = [
    { key: 'priority', kind: 'single-select', value: (task, field) => priorityOption(task.priority, field, config.priorityOptions, repo, notes) },
    { key: 'startDate', kind: 'date', value: (task) => (task.startedAt === null ? undefined : input.zone.day(new Date(task.startedAt))) },
    { key: 'targetDate', kind: 'date', value: (task) => (task.due === null ? undefined : dueDay(task.due, input.zone)) },
    { key: 'score', kind: 'number', value: (task) => roundedScore(input.scoreOf(task)) },
  ];
  const fields = rules.flatMap((rule) => {
    const field = fieldFor(read.fields, config[rule.key], rule.kind, repo, notes);
    return field === undefined ? [] : [{ rule, field }];
  });
  const issues = new Map(read.issues.map((issue) => [issue.number, issue]));
  const planned: FieldWrite[] = [];
  for (const task of input.tasks) {
    const target = heldIssue(task);
    const issue = target === undefined || target.repo.toLowerCase() !== repo.toLowerCase() ? undefined : issues.get(target.number);
    if (target === undefined || issue === undefined) {
      continue;
    }
    for (const { rule, field } of fields) {
      const value = rule.value(task, field);
      const was = issue.values.get(field.name.toLowerCase());
      if (value !== undefined && value !== was) {
        planned.push({ kind: 'field', task: task.id, target, field, value, was });
      }
    }
    const type = typeFor(kindOf(task, input.labelsOf(issue.number)), config, read.types, repo, notes);
    if (type !== undefined && type.toLowerCase() !== issue.type?.toLowerCase()) {
      planned.push({ kind: 'type', task: task.id, target, type, was: issue.type });
    }
  }
  const room = Math.max(0, input.writes);
  return { writes: planned.slice(0, room), deferred: Math.max(0, planned.length - room), notes: [...notes] };
}

/** What a task's issue is typed as: a design issue by its label, a goal by its parts, a bug by its type, else a task. */
export function kindOf(task: Pick<Task, 'after' | 'type'>, labels: readonly string[]): IssueKind {
  if (labels.some((label) => label.toLowerCase() === DESIGN_LABEL)) {
    return 'design';
  }
  if (isGoal(task)) {
    return 'goal';
  }
  return task.type === 'bug' ? 'bug' : 'task';
}

/** One line for each planned write, as the push prints it. */
export function fieldWriteLine(write: FieldWrite): string {
  const issue = `${write.target.repo}#${write.target.number} (${write.task})`;
  if (write.kind === 'type') {
    return `TYPE ${issue}: ${write.type}${write.was === undefined ? '' : `, was ${write.was}`}`;
  }
  return `FIELD ${issue}: ${write.field.name} ${write.value}${write.was === undefined ? '' : `, was ${write.was}`}`;
}

/** The field named `name` (case aside) of kind `kind`; undefined, with a note, when the repository has none such. An empty name asks for none. */
function fieldFor(fields: readonly HostField[], name: string, kind: FieldKind, repo: string, notes: Set<string>): HostField | undefined {
  if (name === '') {
    return undefined;
  }
  const field = fields.find((known) => known.name.toLowerCase() === name.toLowerCase());
  if (field === undefined) {
    notes.add(`${repo} has no issue field named ${JSON.stringify(name)}, so none is written there`);
    return undefined;
  }
  if (field.kind !== kind) {
    notes.add(`${repo}'s issue field ${JSON.stringify(field.name)} is a ${field.kind} field, not a ${kind} one, so none is written there`);
    return undefined;
  }
  return field;
}

/**
 * The option a priority level is written as: the first of the names `priorityOptions` lists for it (else `P<n>`)
 * that the field has, case aside, or an option that starts with it and goes on with no letter or digit (`P1 - high`).
 * An empty list writes no priority for that level, and says nothing of it.
 */
function priorityOption(priority: number, field: HostField, priorityOptions: IssueFieldsConfig['priorityOptions'], repo: string, notes: Set<string>): string | undefined {
  const names = priorityOptions[`p${priority}`] ?? [`P${priority}`];
  if (names.length === 0) {
    return undefined;
  }
  for (const name of names) {
    const wanted = name.toLowerCase();
    const option = field.options.find((known) => {
      const lower = known.toLowerCase();
      return lower === wanted || (lower.startsWith(wanted) && !/[0-9a-z]/.test(lower.charAt(wanted.length)));
    });
    if (option !== undefined) {
      return option;
    }
  }
  const options = field.options.length === 0 ? 'none' : field.options.join(', ');
  notes.add(`${repo}'s field ${JSON.stringify(field.name)} has none of ${names.join(', ')} for P${priority} (its options: ${options}), so tasks of that priority get none; github.fields.priorityOptions names them`);
  return undefined;
}

/** The day a due falls on: a bare day as it is, a time on the team's clock. */
function dueDay(due: string, zone: TimeZone): string | undefined {
  if (parseUtcDay(due) !== undefined) {
    return due.trim();
  }
  const at = parseUtcDeadline(due);
  return at === undefined ? undefined : zone.day(at);
}

/** A score as the field holds it: a whole number, so a score drifting with the clock is written only once it moves a whole point. */
function roundedScore(score: number | undefined): number | undefined {
  return score === undefined || !Number.isFinite(score) ? undefined : Math.round(score);
}

/** The first type of the kind's list the repository has, spelled as the repository spells it; undefined, with a note, when it has none of them. */
function typeFor(kind: IssueKind, config: IssueFieldsConfig, types: readonly string[], repo: string, notes: Set<string>): string | undefined {
  const names = config.types[kind];
  if (names.length === 0) {
    return undefined;
  }
  if (types.length === 0) {
    notes.add(`${repo} has no issue types turned on, so its issues keep their type`);
    return undefined;
  }
  for (const name of names) {
    const found = types.find((type) => type.toLowerCase() === name.toLowerCase());
    if (found !== undefined) {
      return found;
    }
  }
  notes.add(`${repo} has none of the issue types ${names.join(', ')} for a ${kind}, so its issues keep their type`);
  return undefined;
}
