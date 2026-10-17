import { MAX_DESCRIPTION } from '../config/defaults.ts';
import type { KitConfig } from '../config/types.ts';
import { ADDRESS_PATTERN } from '../core/address.ts';
import { SecretScanner } from '../core/secrets.ts';
import { parseUtcDay, parseUtcDeadline } from '../core/time.ts';
import { sizeProblem, type TaskFieldName, type TaskFields } from './events.ts';
import { taskNumber, type RegisterState, type Task } from './fold.ts';
import { ACTIVE_STATUSES, GITHUB_SOURCE, priorityText, SESSION_NAME, type TaskStatus } from './model.ts';
import { heldStart, startHolds } from './verify.ts';
import { isPeerWait, sameWait, waitSpelling, type PersonWait, type WaitReason } from './waits.ts';

/** Team policy, applied on WRITE only: the parser accepts any well-formed history. */
export type Verdict<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };

/** The skill name that closes a task which produced no reusable procedure. */
export const NO_SKILL = 'none';

/** Who the GitHub import's events are written by; its tasks carry GITHUB_SOURCE (model.ts). */
export const GITHUB_ACTOR = 'github';

/** The statuses the import sets on its own tasks: an issue's open state, or how it was closed. */
export const GITHUB_STATUSES: readonly TaskStatus[] = ['open', 'done', 'dropped'];

/** Fields the lead may change on a task someone else owns: who does it, how urgent, when, in what order and its size (the lead plans the week). */
export const LEAD_FIELDS: readonly TaskFieldName[] = ['owner', 'priority', 'due', 'week', 'after', 'size'];

export interface AddInput {
  readonly title: string;
  /** What the task is and why, in plain words; required while `register.requireDescription` is on. */
  readonly description?: string;
  readonly owner: string;
  readonly source: string;
  readonly ref?: string;
  readonly priority: number;
  readonly due?: string;
  readonly goals?: readonly string[];
  readonly week?: string;
  readonly after?: readonly string[];
  /** What the task costs, in percent of the weekly usage limit. */
  readonly size?: number;
}

/** A task for a GitHub issue: its source is GITHUB_SOURCE and its ref the issue's (github/map.ts). */
export interface ImportInput {
  readonly title: string;
  /** The issue's body, cleaned and cut to MAX_DESCRIPTION; null for an empty body. */
  readonly description: string | null;
  readonly owner: string;
  readonly ref: string;
  readonly priority: number;
}

/** The fields the import keeps in step with GitHub; the rest of a task is the team's. */
export type ImportChanges = Partial<Pick<TaskFields, 'title' | 'description' | 'priority'>>;

export interface StatusInput {
  readonly status: TaskStatus;
  readonly note?: string;
  readonly evidence?: string;
  readonly skill?: string;
  /** The reasons a `waiting` status waits for; at least one, and none with any other status. */
  readonly waits?: readonly WaitReason[];
  /** What will prove a `verifying` task works; only with that status. */
  readonly proof?: string;
  /** The date to verify by, as the task's due date; only with `verifying`. */
  readonly due?: string;
}

/**
 * What `set --ask` asks another session for: a task of its own, which the caller's task then waits on
 * (`task:<its id>`) in the same write.
 */
export interface AskInput {
  /** The session asked, as an id. */
  readonly owner: string;
  /** The work asked for: the new task's title. */
  readonly title: string;
  /** The new task's due date. */
  readonly due?: string;
}

/** What a status change is judged against besides the task: the register as read, the time, and whether a cited skill exists. */
export interface StatusContext {
  readonly state: RegisterState;
  readonly now: Date;
  readonly skillExists: boolean;
}

export interface StatusChange {
  readonly status: TaskStatus;
  readonly note: string | null;
  readonly evidence: string | null;
  readonly skill: string | null;
  /** Only with `waiting`. */
  readonly waits?: readonly WaitReason[];
  /** Only with `verifying`: the proof given, or the one the task already had when it was verifying before. */
  readonly proof?: string;
  /** Only with `verifying`, and only when it moves the task's due date: the date to verify by. */
  readonly due?: string;
}

/** The refusal of an `add` with no description while `register.requireDescription` is on. */
export const DESCRIPTION_NEEDED = 'add needs --description "<what and why, in plain words>"';

/** How `--waits` is typed, for the refusals that ask for it. */
export const WAITS_USAGE = 'decision:<who>, approval:<who>, task:T<id> or time:<YYYY-MM-DD HH:MM>, comma-separated';

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

/** The import's source rule: its tasks carry GITHUB_SOURCE, which it sets itself. */
const importSource: SourceRule = (source) => (source === GITHUB_SOURCE ? undefined : `source ${source} is not ${GITHUB_SOURCE}`);

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
      description: blankToNull(input.description),
      owner: input.owner,
      source: input.source,
      ref: input.ref ?? null,
      priority: input.priority,
      due: input.due ?? null,
      goals: input.goals ?? [],
      week: input.week ?? null,
      after: input.after ?? [],
      size: input.size ?? null,
    };
    if (fields.description === null && this.config.register.requireDescription) {
      return refuse(DESCRIPTION_NEEDED);
    }
    const problem = this.checkFields(fields, sourceRule) ?? afterProblem(state.nextId, fields.after, state);
    if (problem !== undefined) {
      return refuse(problem);
    }
    const duplicate = activeDuplicate(fields.title, state);
    return duplicate === undefined ? ok(fields) : refuse(`${duplicate.id} already tracks this (${duplicate.status}, owner ${duplicate.owner})`);
  }

  /**
   * The task `set <id> --status waiting --ask <session> --text "<the work>"` creates, which `task` then waits on:
   * the asked session's, from the caller, at `task`'s priority and with its goals (the work serves the same plan),
   * its description naming `task`. Only the owner asks for its task, only with `--status waiting` and only once
   * started: one not started stays open, planned after the asked task. An active task of the same title is waited
   * on instead.
   */
  ask(task: Task, caller: string, ask: AskInput, input: StatusInput, state: RegisterState): Verdict<TaskFields> {
    if (caller !== task.owner) {
      return refuse(ownerOnly(task));
    }
    if (input.status !== 'waiting') {
      return refuse('--ask goes only with --status waiting');
    }
    if (!hasStarted(task)) {
      return refuse(
        `${task.id} has not started, so it does not wait: ask with teamrig add --owner ${ask.owner} --title "${ask.title}", then plan ${task.id} after that task (teamrig update ${task.id} --after <its id>)`,
      );
    }
    const duplicate = activeDuplicate(ask.title, state);
    if (duplicate !== undefined) {
      return refuse(`${duplicate.id} already tracks this (${duplicate.status}, owner ${duplicate.owner}): wait on it with --waits task:${duplicate.id}`);
    }
    const asked: AddInput = {
      title: ask.title,
      description: `Asked by ${caller} for ${task.id} (${task.title}), which waits on this task.`,
      owner: ask.owner,
      source: caller,
      priority: task.priority,
      goals: task.goals,
      ...(ask.due === undefined ? {} : { due: ask.due }),
    };
    return this.create(asked, state, (source) => this.teamSourceProblem(source));
  }

  setStatus(task: Task, caller: string, input: StatusInput, context: StatusContext): Verdict<StatusChange> {
    if (caller !== task.owner) {
      return refuse(ownerOnly(task));
    }
    const { register } = this.config;
    // A start waits for the proof of the shipped changes it builds on; `warn` lets it through and the CLI warns.
    const holds = startHolds(task, input.status, context.state.tasks);
    if (holds.length > 0 && register.verifyGate === 'refuse') {
      const ids = holds.map((held) => held.id);
      return refuse(`${heldStart(task, holds)}; start ${task.id} once ${ids.join(' and ')} ${ids.length === 1 ? 'is' : 'are'} done`);
    }
    const note = blankToNull(input.note);
    const evidence = blankToNull(input.evidence);
    const skill = blankToNull(input.skill);
    const waits = this.checkWaits(task, input, context);
    if (!waits.ok) {
      return waits;
    }
    const proof = proofChange(task, input);
    if (!proof.ok) {
      return proof;
    }
    const due = dueChange(task, input);
    if (!due.ok) {
      return due;
    }
    if (input.status === task.status && note === null && proof.value === task.proof && due.value === null && sameWaits(waits.value, task.waits)) {
      return refuse(`${task.id} is already ${task.status}; add --note to record why you set it again`);
    }
    if (register.requireNoteOn.includes(input.status) && note === null) {
      return refuse(input.status === 'verifying' && !register.requireProofOnVerifying ? 'verifying needs --note saying what proves it' : `${input.status} needs --note`);
    }
    if (input.status === 'verifying' && register.requireProofOnVerifying && proof.value === null) {
      return refuse('verifying needs --proof saying what will prove the shipped change works');
    }
    if (input.status === 'done') {
      if (register.requireEvidenceOnDone && evidence === null && task.evidence === null) {
        return refuse('done needs --evidence: a commit, test count, path or number that proves it');
      }
      if (register.requireSkillOnDone && skill === null) {
        return refuse(`done needs --skill <name> (the skill written or updated) or --skill ${NO_SKILL}`);
      }
      if (skill !== null && skill !== NO_SKILL && !context.skillExists) {
        return refuse(`no skill named ${skill}; write it first or use --skill ${NO_SKILL}`);
      }
    } else if (skill !== null) {
      return refuse('--skill goes only with done');
    }
    const problem = this.checkText('note', note) ?? this.checkText('evidence', evidence) ?? this.checkText('proof', proof.value);
    const change: StatusChange = {
      status: input.status,
      note,
      evidence,
      skill,
      ...(waits.value.length > 0 ? { waits: waits.value } : {}),
      ...(proof.value === null ? {} : { proof: proof.value }),
      ...(due.value === null ? {} : { due: due.value }),
    };
    return problem === undefined ? ok(change) : refuse(problem);
  }

  /** The reasons of a status change: at least one for `waiting`, none for any other status, each one judged. */
  private checkWaits(task: Task, input: StatusInput, context: StatusContext): Verdict<readonly WaitReason[]> {
    const waits = input.waits ?? [];
    if (input.status !== 'waiting') {
      return waits.length === 0 ? ok([]) : refuse('--waits goes only with --status waiting');
    }
    if (waits.length === 0) {
      return refuse(`waiting needs --waits saying what it waits for: ${WAITS_USAGE}`);
    }
    const twice = waits.find((reason, index) => waits.findIndex((other) => sameWait(reason, other)) !== index);
    if (twice !== undefined) {
      return refuse(`--waits names ${waitSpelling(twice)} twice`);
    }
    const problem = waits.map((reason) => this.waitProblem(task, reason, context)).find((found) => found !== undefined);
    return problem === undefined ? ok(waits) : refuse(problem);
  }

  private waitProblem(task: Task, reason: WaitReason, context: StatusContext): string | undefined {
    switch (reason.kind) {
      case 'decision':
      case 'approval':
        return this.personWaitProblem(task, reason);
      case 'task':
        return taskWaitProblem(task, reason.id, context.state);
      case 'time':
        return (parseUtcDeadline(reason.at)?.getTime() ?? 0) > context.now.getTime() ? undefined : `time ${reason.at} has passed: name a time to come`;
    }
  }

  /**
   * Decision and approval waits are for the lead and the owner: a peer's work is a task, waited on by its id, which
   * clears by itself once that task finishes, where a peer's decision would hold the task until its owner noticed.
   */
  private personWaitProblem(task: Task, reason: PersonWait): string | undefined {
    const { ownerSource } = this.config.register;
    const { lead } = this.config.roles;
    if (!isPeerWait(reason, lead, ownerSource)) {
      return undefined;
    }
    return this.config.sessions.includes(reason.who)
      ? `${reason.kind} ${reason.who}: decision and approval waits are for the lead (${lead}) and ${ownerSource}; wait on ${reason.who}'s work by its task: teamrig set ${task.id} --status waiting --ask ${reason.who} --text "<the work you need>"`
      : `${reason.kind} ${reason.who}: ${reason.who} is neither the lead (${lead}) nor ${ownerSource}`;
  }

  update(task: Task, caller: string, asked: Partial<TaskFields>, note: string | undefined, state: RegisterState): Verdict<UpdateChange> {
    const changes = trimDescription(asked);
    const names = Object.keys(changes).filter((name): name is TaskFieldName => name in changes);
    const text = blankToNull(note);
    if (names.length === 0) {
      // A note alone changes nothing on the task, so any session may add context to any task's history.
      if (text === null) {
        return refuse('nothing to change: give a field or a --note');
      }
      const problem = this.checkText('note', text);
      return problem === undefined ? ok({ changes, note: text }) : refuse(problem);
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
    if (changes.description === null && this.config.register.requireDescription) {
      return refuse(`${task.id} keeps a description while register.requireDescription is on: give a new one instead of none`);
    }
    const merged: TaskFields = { ...pickFields(task), ...changes };
    // A task keeps the source it was added with, even one from the parent team's lead.
    const sourceRule: SourceRule = (source) => (source === task.source ? undefined : this.teamSourceProblem(source));
    const after = changes.after === undefined ? undefined : afterChangeProblem(task, changes.after, state);
    const problem = after ?? this.checkFields(merged, sourceRule) ?? this.checkText('note', text);
    return problem === undefined ? ok({ changes, note: text }) : refuse(problem);
  }

  /**
   * A task for a GitHub issue. The import keys its tasks on their ref, so a second one for the same issue is
   * refused; a team task that cites the issue in its ref stays the team's. Two issues may share a title, so
   * the duplicate-title rule does not apply.
   */
  importAdd(input: ImportInput, state: RegisterState): Verdict<TaskFields> {
    const fields: TaskFields = { ...input, source: GITHUB_SOURCE, due: null, goals: [], week: null, after: [], size: null };
    const holder = [...state.tasks.values()].find((task) => task.source === GITHUB_SOURCE && task.ref === input.ref);
    if (holder !== undefined) {
      return refuse(`${holder.id} already has ref ${input.ref}`);
    }
    const problem = this.checkFields(fields, importSource);
    return problem === undefined ? ok(fields) : refuse(problem);
  }

  /**
   * A title, description or priority GitHub changed, on the import's own task only. A field the task already has
   * is left out, judged under the lock, so a sync that raced another changes nothing twice.
   */
  importUpdate(task: Task, changes: ImportChanges, note: string): Verdict<UpdateChange> {
    const notImported = this.notImported(task);
    if (notImported !== undefined) {
      return refuse(notImported);
    }
    const changed: ImportChanges = {
      ...(changes.title !== undefined && changes.title !== task.title ? { title: changes.title } : {}),
      ...(changes.description !== undefined && changes.description !== task.description ? { description: changes.description } : {}),
      ...(changes.priority !== undefined && changes.priority !== task.priority ? { priority: changes.priority } : {}),
    };
    if (Object.keys(changed).length === 0) {
      return refuse('nothing to change');
    }
    const problem = this.checkFields({ ...pickFields(task), ...changed }, importSource) ?? this.checkText('note', note);
    return problem === undefined ? ok({ changes: changed, note }) : refuse(problem);
  }

  /**
   * The one exception to "only the owner sets the status": the import opens, finishes or drops its own
   * tasks as their issues open and close on GitHub. Any other task, and any other status, is refused.
   * No skill comes from GitHub, so a done needs none; its evidence is the issue's url.
   */
  importStatus(task: Task, input: StatusInput): Verdict<StatusChange> {
    const notImported = this.notImported(task);
    if (notImported !== undefined) {
      return refuse(notImported);
    }
    if (!GITHUB_STATUSES.includes(input.status)) {
      return refuse(`the GitHub import sets only ${GITHUB_STATUSES.join(', ')}, not ${input.status}`);
    }
    if (input.status === task.status) {
      return refuse(`${task.id} is already ${task.status}`);
    }
    const note = blankToNull(input.note);
    const evidence = blankToNull(input.evidence);
    if (input.status === 'done' && this.config.register.requireEvidenceOnDone && evidence === null && task.evidence === null) {
      return refuse('done needs evidence: the issue url');
    }
    const problem = this.checkText('note', note) ?? this.checkText('evidence', evidence);
    return problem === undefined ? ok({ status: input.status, note, evidence, skill: null }) : refuse(problem);
  }

  /** Why the import may not change the task: it is not one the import added. */
  private notImported(task: Task): string | undefined {
    return task.source === GITHUB_SOURCE ? undefined : `${task.id} is not a GitHub task (source ${task.source}): the import changes only its own`;
  }

  /** A source added on this team: a session id, or the owner's marker; never the import's. */
  private teamSourceProblem(source: string): string | undefined {
    const { ownerSource } = this.config.register;
    if (source === GITHUB_SOURCE) {
      return `source ${GITHUB_SOURCE} is kept for the tasks teamrig gh sync imports`;
    }
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
    if (!register.priorities.some((priority) => priority.id === fields.priority)) {
      return `priority ${priorityText(fields.priority)} is not one of ${register.priorities.map((priority) => priorityText(priority.id)).join(', ')}`;
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
    if (fields.description !== null && fields.description.length > MAX_DESCRIPTION) {
      return `the description has ${fields.description.length} characters; the limit is ${MAX_DESCRIPTION}`;
    }
    const size = fields.size === null ? undefined : sizeProblem(fields.size);
    if (size !== undefined) {
      return size;
    }
    return this.checkText('title', fields.title) ?? this.checkText('description', fields.description) ?? this.checkText('ref', fields.ref);
  }

  /** Checks the length against `maxText` (the title and description have their own limits), then the secret shapes. */
  private checkText(name: string, text: string | null): string | undefined {
    if (text === null) {
      return undefined;
    }
    if (!OWN_LIMITS.includes(name) && text.length > this.config.register.maxText) {
      return `${name} has ${text.length} characters; the limit is ${this.config.register.maxText}`;
    }
    return this.secrets.refusal(name, text);
  }
}

/** The texts whose length is judged against their own limit, not `maxText`. */
const OWN_LIMITS: readonly string[] = ['title', 'description'];

function pickFields(task: Task): TaskFields {
  const { title, description, owner, source, ref, priority, due, goals, week, after, size } = task;
  return { title, description, owner, source, ref, priority, due, goals, week, after, size };
}

/** An update's description trimmed at both ends, its newlines kept; a blank one clears it, as `none` does. */
function trimDescription(changes: Partial<TaskFields>): Partial<TaskFields> {
  return changes.description === undefined ? changes : { ...changes, description: blankToNull(changes.description ?? undefined) };
}

/**
 * The proof a status change writes: none outside `verifying`, where `--proof` is refused; the one given; or,
 * when a verifying task is set verifying again without one, the proof it already had.
 */
function proofChange(task: Task, input: StatusInput): Verdict<string | null> {
  const proof = blankToNull(input.proof);
  if (input.status !== 'verifying') {
    return proof === null ? ok(null) : refuse('--proof goes only with --status verifying');
  }
  return ok(proof ?? (task.status === 'verifying' ? task.proof : null));
}

/** The verify-by date a status change moves the task's due date to: only with `verifying`, and null when it stays. */
function dueChange(task: Task, input: StatusInput): Verdict<string | null> {
  const due = blankToNull(input.due);
  if (due === null || due === task.due) {
    return ok(null);
  }
  if (input.status !== 'verifying') {
    return refuse(`--due goes only with --status verifying; teamrig update ${task.id} --due sets it otherwise`);
  }
  return parseUtcDeadline(due) === undefined ? refuse(`due ${due} is not YYYY-MM-DD or YYYY-MM-DD HH:MM`) : ok(due);
}

function sameWaits(a: readonly WaitReason[], b: readonly WaitReason[]): boolean {
  return a.length === b.length && a.every((reason) => b.some((other) => sameWait(reason, other)));
}

/**
 * A task reason is for a task already started (in progress, or waiting after it started) that found another
 * task must finish first: one not started stays open with a plan dependency instead.
 */
function taskWaitProblem(task: Task, id: string, state: RegisterState): string | undefined {
  if (id === task.id) {
    return `${task.id} cannot wait on itself`;
  }
  if (!hasStarted(task)) {
    return `${task.id} has not started, so it does not wait on ${id}: it stays open, planned after it (teamrig update ${task.id} --after ${id})`;
  }
  if (taskNumber(id) >= taskNumber(state.nextId)) {
    return `no task ${id}`;
  }
  const target = state.tasks.get(id);
  return target === undefined || target.status === 'done' || target.status === 'dropped' ? `${id} is already finished; nothing to wait on` : undefined;
}

/** In progress, or waiting after it started: a task that can wait on another. */
function hasStarted(task: Task): boolean {
  return task.status === 'in-progress' || (task.status === 'waiting' && task.startedAt !== null);
}

function ownerOnly(task: Task): string {
  return `only the owner (${task.owner}) sets the status of ${task.id}`;
}

/** The active task with this title, compared as {@link normaliseTitle} does: a new one would track the same work twice. */
function activeDuplicate(title: string, state: RegisterState): Task | undefined {
  return [...state.tasks.values()].find((task) => ACTIVE_STATUSES.includes(task.status) && normaliseTitle(task.title) === normaliseTitle(title));
}

/** A plan dependency is for a task not started yet: a started one waits on a task instead. Clearing it is always fine. */
function afterChangeProblem(task: Task, after: readonly string[], state: RegisterState): string | undefined {
  const first = after[0];
  if (first !== undefined && task.status !== 'open') {
    return `--after plans a task not started yet, and ${task.id} is ${task.status}; a started task waits on another with --status waiting --waits task:${first}`;
  }
  return afterProblem(task.id, after, state);
}

/**
 * The tasks `id` comes after must exist, be named once, and never lead back to `id`: a loop could never start.
 * On a create, `id` is the id the new task gets.
 */
function afterProblem(id: string, after: readonly string[], state: RegisterState): string | undefined {
  const twice = after.find((other, index) => after.indexOf(other) !== index);
  if (twice !== undefined) {
    return `--after names ${twice} twice`;
  }
  if (after.includes(id)) {
    return `${id} cannot come after itself`;
  }
  const missing = after.find((other) => taskNumber(other) >= taskNumber(state.nextId));
  if (missing !== undefined) {
    return `no task ${missing}`;
  }
  const loop = after.find((other) => leadsTo(other, id, state));
  return loop === undefined ? undefined : `${loop} already comes after ${id}, directly or not, so ${id} cannot come after ${loop}`;
}

/** True when `from` is `target` or comes after it, directly or through the tasks it comes after. */
function leadsTo(from: string, target: string, state: RegisterState): boolean {
  const seen = new Set<string>();
  const queue = [from];
  for (let next = queue.pop(); next !== undefined; next = queue.pop()) {
    if (next === target) {
      return true;
    }
    if (!seen.has(next)) {
      seen.add(next);
      queue.push(...(state.tasks.get(next)?.after ?? []));
    }
  }
  return false;
}

function blankToNull(text: string | undefined): string | null {
  return text === undefined || text.trim() === '' ? null : text.trim();
}

/** Titles compare case- and space-insensitively when looking for duplicates. */
export function normaliseTitle(title: string): string {
  return title.toLowerCase().replace(/\s+/g, ' ').trim();
}
