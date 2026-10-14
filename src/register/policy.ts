import type { KitConfig } from '../config/types.ts';
import { ADDRESS_PATTERN } from '../core/address.ts';
import { SecretScanner } from '../core/secrets.ts';
import { parseUtcDay, parseUtcDeadline } from '../core/time.ts';
import type { TaskFieldName, TaskFields } from './events.ts';
import type { RegisterState, Task } from './fold.ts';
import { ACTIVE_STATUSES, SESSION_NAME, type TaskStatus } from './model.ts';

/** Team policy, applied on WRITE only: the parser accepts any well-formed history. */
export type Verdict<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };

/** The skill name that closes a task which produced no reusable procedure. */
export const NO_SKILL = 'none';

/** Fields the lead may change on a task someone else owns. */
export const LEAD_FIELDS: readonly TaskFieldName[] = ['owner', 'tier', 'due', 'week'];

export interface AddInput {
  readonly title: string;
  readonly owner: string;
  readonly source: string;
  readonly ref?: string;
  readonly tier: number;
  readonly due?: string;
  readonly goals?: readonly string[];
  readonly week?: string;
}

export interface StatusInput {
  readonly status: TaskStatus;
  readonly note?: string;
  readonly evidence?: string;
  readonly skill?: string;
}

export interface StatusChange {
  readonly status: TaskStatus;
  readonly note: string | null;
  readonly evidence: string | null;
  readonly skill: string | null;
}

export interface UpdateChange {
  readonly changes: Partial<TaskFields>;
  readonly note: string | null;
}

function ok<T>(value: T): Verdict<T> {
  return { ok: true, value };
}

function refuse<T>(error: string): Verdict<T> {
  return { ok: false, error };
}

/** Why a task's source is refused, or undefined when it is fine. */
type SourceRule = (source: string) => string | undefined;

export class RegisterPolicy {
  private readonly config: KitConfig;
  private readonly secrets: SecretScanner;

  constructor(config: KitConfig) {
    this.config = config;
    this.secrets = new SecretScanner(config.register.secretPatterns);
  }

  /** The caller must be on the roster before writing anything. */
  checkCaller(session: string): string | undefined {
    return this.config.sessions.includes(session)
      ? undefined
      : `${session} is not a session on this team (sessions: ${this.config.sessions.join(', ')})`;
  }

  add(input: AddInput, state: RegisterState): Verdict<TaskFields> {
    return this.create(input, state, (source) => this.teamSourceProblem(source));
  }

  /**
   * A task the parent team's lead hands this team: its source is that lead's `<team>/<id>`, and it
   * goes to this team's lead, who plans it in.
   */
  addFromParent(input: AddInput, state: RegisterState): Verdict<TaskFields> {
    const { lead } = this.config.roles;
    if (input.owner !== lead) {
      return refuse(`a task from the parent team goes to this team's lead (${lead}), not ${input.owner}`);
    }
    return this.create(input, state, (source) =>
      ADDRESS_PATTERN.test(source) ? undefined : `source ${source} is not the parent team lead's <team>/<id>`,
    );
  }

  private create(input: AddInput, state: RegisterState, sourceRule: SourceRule): Verdict<TaskFields> {
    const fields: TaskFields = {
      title: input.title.trim(),
      owner: input.owner,
      source: input.source,
      ref: input.ref ?? null,
      tier: input.tier,
      due: input.due ?? null,
      goals: input.goals ?? [],
      week: input.week ?? null,
    };
    const problem = this.checkFields(fields, sourceRule);
    if (problem !== undefined) {
      return refuse(problem);
    }
    const duplicate = [...state.tasks.values()].find(
      (task) => ACTIVE_STATUSES.includes(task.status) && normaliseTitle(task.title) === normaliseTitle(fields.title),
    );
    return duplicate === undefined ? ok(fields) : refuse(`${duplicate.id} already tracks this (${duplicate.status}, owner ${duplicate.owner})`);
  }

  setStatus(task: Task, caller: string, input: StatusInput, skillExists: boolean): Verdict<StatusChange> {
    if (caller !== task.owner) {
      return refuse(`only the owner (${task.owner}) sets the status of ${task.id}`);
    }
    const { register } = this.config;
    const note = blankToNull(input.note);
    const evidence = blankToNull(input.evidence);
    const skill = blankToNull(input.skill);
    if (input.status === task.status && note === null) {
      return refuse(`${task.id} is already ${task.status}; add --note to record why you set it again`);
    }
    if (register.requireNoteOn.includes(input.status) && note === null) {
      return refuse(`${input.status} needs --note`);
    }
    if (input.status === 'done') {
      if (register.requireEvidenceOnDone && evidence === null && task.evidence === null) {
        return refuse('done needs --evidence: a commit, test count, path or number that proves it');
      }
      if (register.requireSkillOnDone && skill === null) {
        return refuse(`done needs --skill <name> (the skill written or updated) or --skill ${NO_SKILL}`);
      }
      if (skill !== null && skill !== NO_SKILL && !skillExists) {
        return refuse(`no skill named ${skill}; write it first or use --skill ${NO_SKILL}`);
      }
    } else if (skill !== null) {
      return refuse('--skill goes only with done');
    }
    const problem = this.checkText('note', note) ?? this.checkText('evidence', evidence);
    return problem === undefined ? ok({ status: input.status, note, evidence, skill }) : refuse(problem);
  }

  update(task: Task, caller: string, changes: Partial<TaskFields>, note: string | undefined): Verdict<UpdateChange> {
    const names = Object.keys(changes).filter((name): name is TaskFieldName => name in changes);
    if (names.length === 0) {
      return refuse('nothing to change');
    }
    if (caller !== task.owner) {
      if (caller !== this.config.roles.lead) {
        return refuse(`only the owner (${task.owner}) or the lead changes ${task.id}`);
      }
      const notLead = names.filter((name) => !LEAD_FIELDS.includes(name));
      if (notLead.length > 0) {
        return refuse(`the lead may change only ${LEAD_FIELDS.join(', ')} on a task it does not own (asked: ${notLead.join(', ')})`);
      }
    }
    const merged: TaskFields = { ...pickFields(task), ...changes };
    // A task keeps the source it was added with, even one from the parent team's lead.
    const sourceRule: SourceRule = (source) => (source === task.source ? undefined : this.teamSourceProblem(source));
    const problem = this.checkFields(merged, sourceRule) ?? this.checkText('note', blankToNull(note));
    return problem === undefined ? ok({ changes, note: blankToNull(note) }) : refuse(problem);
  }

  /** A source added on this team: a session id, or the owner's marker. */
  private teamSourceProblem(source: string): string | undefined {
    const { ownerSource } = this.config.register;
    return source === ownerSource || SESSION_NAME.test(source) ? undefined : `source ${source} is neither a session id nor ${ownerSource}`;
  }

  private checkFields(fields: TaskFields, sourceRule: SourceRule): string | undefined {
    const { register, sessions } = this.config;
    if (fields.title === '') {
      return 'the title is empty';
    }
    if (fields.title.length > register.maxTitle) {
      return `the title has ${fields.title.length} characters; the limit is ${register.maxTitle}`;
    }
    if (!sessions.includes(fields.owner)) {
      return `owner ${fields.owner} is not a session on this team`;
    }
    const sourceProblem = sourceRule(fields.source);
    if (sourceProblem !== undefined) {
      return sourceProblem;
    }
    if (!register.tiers.some((tier) => tier.id === fields.tier)) {
      return `tier ${fields.tier} is not one of ${register.tiers.map((tier) => tier.id).join(', ')}`;
    }
    if (fields.due !== null && parseUtcDeadline(fields.due) === undefined) {
      return `due ${fields.due} is not YYYY-MM-DD or YYYY-MM-DD HH:MM`;
    }
    if (fields.week !== null && parseUtcDay(fields.week) === undefined) {
      return `week ${fields.week} is not a YYYY-MM-DD date`;
    }
    const goalPattern = register.goalPattern === undefined ? undefined : new RegExp(register.goalPattern, 'u');
    const badGoal = goalPattern === undefined ? undefined : fields.goals.find((goal) => !goalPattern.test(goal));
    if (badGoal !== undefined) {
      return `goal ${badGoal} does not match ${register.goalPattern}`;
    }
    return this.checkText('title', fields.title) ?? this.checkText('ref', fields.ref);
  }

  private checkText(name: string, text: string | null): string | undefined {
    if (text === null) {
      return undefined;
    }
    if (name !== 'title' && text.length > this.config.register.maxText) {
      return `${name} has ${text.length} characters; the limit is ${this.config.register.maxText}`;
    }
    return this.secrets.looksSecret(text)
      ? `${name} looks like it holds a secret; refer to where it is kept instead`
      : undefined;
  }
}

function pickFields(task: Task): TaskFields {
  const { title, owner, source, ref, tier, due, goals, week } = task;
  return { title, owner, source, ref, tier, due, goals, week };
}

function blankToNull(text: string | undefined): string | null {
  return text === undefined || text.trim() === '' ? null : text.trim();
}

/** Titles compare case- and space-insensitively when looking for duplicates. */
export function normaliseTitle(title: string): string {
  return title.toLowerCase().replace(/\s+/g, ' ').trim();
}
