import { MAX_DESCRIPTION } from '../config/defaults.ts';
import { LeadTree } from '../config/lead-tree.ts';
import type { KitConfig } from '../config/types.ts';
import { ADDRESS_PATTERN } from '../core/address.ts';
import { SecretScanner } from '../core/secrets.ts';
import { parseDeadline, parseUtcDay, parseUtcDeadline, showStored } from '../core/time.ts';
import type { TimeZone } from '../core/zone.ts';
import { CARD_FLAGS, cardProblem, cardTexts, OPTION_SEPARATOR, sameCard, type DecisionCard } from './card.ts';
import { sizeProblem, type ApprovalVerdict, type TaskFieldName, type TaskFields } from './events.ts';
import { taskNumber, type RegisterState, type Task } from './fold.ts';
import { ACTIVE_STATUSES, FOLLOWUP_STATUSES, GITHUB_SOURCE, priorityText, SESSION_NAME, WAIT_STATUSES, type TaskStatus } from './model.ts';
import { loopFix, needPath, pathText } from './tree.ts';
import { dueStartHolds, dueVerifyHold, heldStart, startHolds } from './verify.ts';
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
  /** The reasons a `waiting` status waits for (at least one), or what a `verifying` one's proof waits for; none with any other status. */
  readonly waits?: readonly WaitReason[];
  /**
   * The parts of the card a wait on a decision or an approval asks (card.ts); only with such a wait. Parts left out
   * keep what the task's card said while it was waiting.
   */
  readonly card?: Partial<DecisionCard>;
  /** What will prove a `verifying` task works; only with that status. */
  readonly proof?: string;
  /**
   * What shows the proof of the verifying tasks a start needs exists; only on a start they hold. The start then goes
   * through, and the CLI asks their owners to confirm (done) or reopen them.
   */
  readonly met?: string;
  /** The date to verify by, as the task's due date; only with `verifying`. */
  readonly due?: string;
  /** The tasks the work leaves (a finding, a next step), by id; empty for `--followups none`. Only with FOLLOWUP_STATUSES. */
  readonly followups?: readonly string[];
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

/**
 * What a status change is judged against besides the task: the register as read, the time, the team's zone (a stored
 * day is a day of it), and whether a cited skill exists.
 */
export interface StatusContext {
  readonly state: RegisterState;
  readonly now: Date;
  readonly zone: TimeZone;
  readonly skillExists: boolean;
}

export interface StatusChange {
  readonly status: TaskStatus;
  readonly note: string | null;
  readonly evidence: string | null;
  readonly skill: string | null;
  /** Only with `waiting` or `verifying` (what its proof waits for). */
  readonly waits?: readonly WaitReason[];
  /** Only with a wait on a decision or an approval: the card given, or the one the task had while waiting. */
  readonly card?: DecisionCard;
  /** Only with `verifying`: the proof given, or the one the task already had when it was verifying before. */
  readonly proof?: string;
  /** Only on a start the verifying tasks it needs hold: what shows their proof exists. */
  readonly met?: string;
  /** Only with `verifying`, and only when it moves the task's due date: the date to verify by. */
  readonly due?: string;
  /** Only when the change names them: the tasks the work leaves, empty for none. */
  readonly followups?: readonly string[];
}

/** The refusal of an `add` with no description while `register.requireDescription` is on. */
export const DESCRIPTION_NEEDED = 'add needs --description "<what and why, in plain words>"';

/** How a card is typed, for the refusals that ask for one. */
export const CARD_USAGE = `--question "<what is decided>" --options "<one choice, its numbers> ${OPTION_SEPARATOR} <another>" --recommend "<which, and why>" --default "<what happens with no answer by the due date>"`;

/** How `--waits` is typed, for the refusals that ask for it. */
export const WAITS_USAGE = 'decision:<who>, approval:<who>, task:T<id> or time:<YYYY-MM-DD HH:MM>, comma-separated';

export interface UpdateChange {
  readonly changes: Partial<TaskFields>;
  readonly note: string | null;
}

/** An answer to an approval wait: an update that changes no field, with the lead's verdict and its note. */
export interface ApprovalChange extends UpdateChange {
  readonly verdict: ApprovalVerdict;
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
  private readonly tree: LeadTree;

  constructor(config: KitConfig) {
    this.config = config;
    this.secrets = new SecretScanner(config.register.secretPatterns);
    this.tree = new LeadTree(config);
  }

  /** The approvers of the owner's task in words: the lead alone, or its leaders up the tree, nearest first (T781). */
  private approversText(owner: string): string {
    const approvers = this.tree.approversOf(owner);
    return approvers.length === 1 ? `the lead (${this.config.roles.lead})` : `a leader above ${owner} (${approvers.join(' or ')})`;
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
   * The task `set <id> --status waiting|verifying --ask <session> --text "<the work>"` creates, which `task` then
   * waits on (with `verifying`, its proof does: the session that runs the proof has it on its list): the asked
   * session's, from the caller, at `task`'s priority and with its goals (the work serves the same plan), its
   * description naming `task`. Only the owner asks for its task, only with a status of WAIT_STATUSES and only once
   * started (a verifying task has: its proof may need the ask): one not started keeps its status, planned after the
   * asked task. An active task of the same title is waited on instead.
   */
  ask(task: Task, caller: string, ask: AskInput, input: StatusInput, state: RegisterState): Verdict<TaskFields> {
    if (caller !== task.owner) {
      return refuse(ownerOnly(task));
    }
    if (!WAIT_STATUSES.includes(input.status)) {
      return refuse(`--ask goes only with --status ${WAIT_STATUSES.join(' or ')}`);
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
    // A start waits for the proof of the shipped changes it builds on, unless it names what shows that proof exists
    // (`--met`), which the CLI asks their owners to confirm; `warn` lets it through and the CLI warns.
    const holds = startHolds(task, input.status, context.state.tasks);
    const met = blankToNull(input.met);
    if (met !== null && holds.length === 0) {
      return refuse('--met goes only with a start that a verifying task it needs holds');
    }
    if (holds.length > 0 && met === null && register.verifyGate === 'refuse') {
      const ids = holds.map((held) => held.id);
      const done = `${ids.join(' and ')} ${ids.length === 1 ? 'is' : 'are'} done`;
      return refuse(`${heldStart(task, holds)}; start ${task.id} once ${done}, or with --met "<what shows the proof exists>"`);
    }
    // New work also waits for its owner's own verify steps that are due, so shipped changes get proven, not piled up.
    const dueVerify = dueStartHolds(task, input.status, context.state.tasks, context.now, context.zone, register.maxVerifying);
    if (dueVerify.length > 0 && register.verifyGate === 'refuse') {
      return refuse(dueVerifyHold(task, dueVerify));
    }
    const note = blankToNull(input.note);
    const evidence = blankToNull(input.evidence);
    const skill = blankToNull(input.skill);
    const waits = this.checkWaits(task, input, context);
    if (!waits.ok) {
      return waits;
    }
    const card = this.cardChange(task, input, waits.value);
    if (!card.ok) {
      return card;
    }
    const proof = proofChange(task, input);
    if (!proof.ok) {
      return proof;
    }
    const due = dueChange(task, input);
    if (!due.ok) {
      return due;
    }
    const same = proof.value === task.proof && due.value === null && sameWaits(waits.value, task.waits) && sameCard(card.value, task.card);
    if (input.status === task.status && note === null && same) {
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
    const followups = this.checkFollowups(task, input, context);
    if (!followups.ok) {
      return followups;
    }
    const texts: readonly [string, string | null][] = [
      ['note', note],
      ['evidence', evidence],
      ['proof', proof.value],
      ['met', met],
      ...(card.value === null ? [] : cardTexts(card.value).map((text): [string, string] => ['card', text])),
    ];
    const problem = texts.map(([name, text]) => this.checkText(name, text)).find((found) => found !== undefined);
    const change: StatusChange = {
      status: input.status,
      note,
      evidence,
      skill,
      ...(waits.value.length > 0 ? { waits: waits.value } : {}),
      ...(card.value === null ? {} : { card: card.value }),
      ...(proof.value === null ? {} : { proof: proof.value }),
      ...(met === null ? {} : { met }),
      ...(due.value === null ? {} : { due: due.value }),
      ...(followups.value === null ? {} : { followups: followups.value }),
    };
    return problem === undefined ? ok(change) : refuse(problem);
  }

  /**
   * The follow-ups a status change names: required on the statuses `register.requireFollowupsOn` lists, allowed
   * only on FOLLOWUP_STATUSES, each another task on the list and named once; null when the change names none.
   */
  private checkFollowups(task: Task, input: StatusInput, context: StatusContext): Verdict<readonly string[] | null> {
    const { followups } = input;
    if (followups === undefined) {
      return this.config.register.requireFollowupsOn.includes(input.status)
        ? refuse(`${input.status} needs --followups T<id>,... naming the tasks this work leaves (a finding, a next step), or --followups none`)
        : ok(null);
    }
    if (!FOLLOWUP_STATUSES.includes(input.status)) {
      return refuse(`--followups goes only with ${FOLLOWUP_STATUSES.join(', ')}`);
    }
    for (const [index, id] of followups.entries()) {
      if (id === task.id) {
        return refuse(`--followups names ${id} itself: name the tasks it leaves`);
      }
      if (followups.indexOf(id) !== index) {
        return refuse(`--followups names ${id} twice`);
      }
      if (!context.state.tasks.has(id)) {
        return refuse(`--followups names ${id}, which is not on the task list: add it first (teamrig add)`);
      }
    }
    return ok(followups);
  }

  /**
   * The reasons of a status change, each given one judged: at least one for `waiting`; for `verifying`, what its proof
   * waits for, if anything, where a verifying task set again without `--waits` keeps the reasons it had (a new verify-by
   * date leaves the proof's ask in place); none for any other status.
   */
  private checkWaits(task: Task, input: StatusInput, context: StatusContext): Verdict<readonly WaitReason[]> {
    if (!WAIT_STATUSES.includes(input.status)) {
      return (input.waits ?? []).length === 0 ? ok([]) : refuse(`--waits goes only with --status ${WAIT_STATUSES.join(' or ')}`);
    }
    if (input.waits === undefined && input.status === 'verifying') {
      return ok(task.status === 'verifying' ? task.waits : []);
    }
    const waits = input.waits ?? [];
    if (input.status === 'waiting' && waits.length === 0) {
      return refuse(`waiting needs --waits saying what it waits for: ${WAITS_USAGE}`);
    }
    const twice = waits.find((reason, index) => waits.findIndex((other) => sameWait(reason, other)) !== index);
    if (twice !== undefined) {
      return refuse(`--waits names ${waitSpelling(twice)} twice`);
    }
    const problem = waits.map((reason) => this.waitProblem(task, input.status, reason, context)).find((found) => found !== undefined);
    return problem === undefined ? ok(waits) : refuse(problem);
  }

  /**
   * The card a status change writes (card.ts): none without a wait on a decision or an approval, where the card
   * flags are refused; the parts given over the card the task had while waiting, so one part can change alone; or,
   * with none given, that card. A wait on the owner's decision or approval needs a card while
   * `register.requireDecisionCard` is on, so the owner decides from it alone (T514).
   */
  private cardChange(task: Task, input: StatusInput, waits: readonly WaitReason[]): Verdict<DecisionCard | null> {
    const asks = waits.filter((reason): reason is PersonWait => reason.kind === 'decision' || reason.kind === 'approval');
    const given = input.card;
    if (asks.length === 0) {
      return given === undefined ? ok(null) : refuse(`${CARD_FLAGS} go only with --status ${WAIT_STATUSES.join(' or ')} on a decision or an approval`);
    }
    const before = WAIT_STATUSES.includes(task.status) ? task.card : null;
    if (given === undefined) {
      const { ownerSource, requireDecisionCard } = this.config.register;
      const owners = asks.filter((reason) => reason.who === ownerSource);
      if (before !== null || owners.length === 0 || !requireDecisionCard) {
        return ok(before);
      }
      const kinds = owners.map((reason) => reason.kind).join(' and ');
      return refuse(`a wait on ${ownerSource}'s ${kinds} needs a card, so ${ownerSource} decides from it alone: ${CARD_USAGE}`);
    }
    const parts: Partial<DecisionCard> = { ...before, ...given };
    if (parts.question === undefined || parts.recommend === undefined || parts.byDefault === undefined) {
      return refuse(`a card needs ${CARD_FLAGS} (--options for a decision): ${CARD_USAGE}`);
    }
    const card: DecisionCard = { question: parts.question, options: parts.options ?? [], recommend: parts.recommend, byDefault: parts.byDefault };
    const problem = cardProblem(card, asks.some((reason) => reason.kind === 'decision'));
    return problem === undefined ? ok(card) : refuse(problem);
  }

  private waitProblem(task: Task, status: TaskStatus, reason: WaitReason, context: StatusContext): string | undefined {
    switch (reason.kind) {
      case 'decision':
      case 'approval':
        return this.personWaitProblem(task, status, reason);
      case 'task':
        return taskWaitProblem(task, reason.id, context.state);
      case 'time':
        return (parseDeadline(reason.at, context.zone)?.getTime() ?? 0) > context.now.getTime() ? undefined : `time ${showStored(reason.at, context.zone)} has passed: name a time to come`;
    }
  }

  /**
   * Decision and approval waits are for the task owner's leaders (the lead, and any sub-lead above it) and the owner: a
   * peer's work is a task, waited on by its id, which clears by itself once that task finishes, where a peer's decision
   * would hold the task until its owner noticed.
   */
  private personWaitProblem(task: Task, status: TaskStatus, reason: PersonWait): string | undefined {
    const { ownerSource } = this.config.register;
    if (!isPeerWait(reason, this.tree.approversOf(task.owner), ownerSource)) {
      return undefined;
    }
    const leaders = this.approversText(task.owner);
    return this.config.sessions.includes(reason.who)
      ? `${reason.kind} ${reason.who}: decision and approval waits are for ${leaders} and ${ownerSource}; wait on ${reason.who}'s work by its task: teamrig set ${task.id} --status ${status} --ask ${reason.who} --text "<the work you need>"`
      : `${reason.kind} ${reason.who}: ${reason.who} is neither ${leaders} nor ${ownerSource}`;
  }

  /**
   * A lead's answer to a task's approval wait (T684): only a leader above the task's owner answers (the lead, or a
   * sub-lead, T781), only a task waiting on its own approval, and always with a note, which the task's owner reads: what
   * it checked, or why it declines. An approval of the owner's stays the owner's: no lead answers it.
   */
  approve(task: Task, caller: string, verdict: ApprovalVerdict, note: string | undefined): Verdict<ApprovalChange> {
    const { lead } = this.config.roles;
    if (!this.tree.approversOf(task.owner).includes(caller)) {
      return refuse(`only ${this.approversText(task.owner)} answers an approval of ${task.owner}'s`);
    }
    if (task.status !== 'waiting' || !task.waits.some((reason) => reason.kind === 'approval' && reason.who === caller)) {
      const whose = caller === lead ? "the lead's" : `${caller}'s`;
      return refuse(`${task.id} does not wait on ${whose} approval (approval:${caller}); its owner asks with teamrig set ${task.id} --status waiting --waits approval:${caller}`);
    }
    const text = blankToNull(note);
    if (text === null) {
      return refuse(`an answer needs --note: what you checked, or why you decline`);
    }
    const problem = this.checkText('note', text);
    return problem === undefined ? ok({ changes: {}, note: text, verdict }) : refuse(problem);
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
      const problem = this.leaderUpdateProblem(task, caller, names, changes.owner);
      if (problem !== undefined) {
        return refuse(problem);
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
   * Why a session may not change the work order of a task it does not own, or undefined when it may (T782): the lead
   * on any task, a sub-lead on the tasks of its group; only the LEAD_FIELDS, and a sub-lead hands a task only to itself
   * or a session it leads, so work never leaves its group by a sub-lead's hand.
   */
  private leaderUpdateProblem(task: Task, caller: string, names: readonly TaskFieldName[], owner: string | undefined): string | undefined {
    const isLead = caller === this.tree.lead;
    if (!isLead && !this.tree.leads(caller, task.owner)) {
      return `only the owner (${task.owner}) or ${this.approversText(task.owner)} changes ${task.id}`;
    }
    const notLead = names.filter((name) => !LEAD_FIELDS.includes(name));
    if (notLead.length > 0) {
      return `a leader may change only ${LEAD_FIELDS.join(', ')} on a task it does not own (asked: ${notLead.join(', ')})`;
    }
    const group = this.tree.groupOf(caller);
    if (!isLead && owner !== undefined && owner !== caller && !group.includes(owner)) {
      return `${caller} hands ${task.id} only to itself or a session it leads (${group.join(', ')}); the lead (${this.tree.lead}) moves work between groups`;
    }
    return undefined;
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
 * A task reason is for a task already started (see {@link hasStarted}) that found another task must finish first,
 * a verifying one for its proof: one not started stays open with a plan dependency instead, and a finished one
 * reopens first. It never closes a loop.
 */
function taskWaitProblem(task: Task, id: string, state: RegisterState): string | undefined {
  if (id === task.id) {
    return `${task.id} cannot wait on itself`;
  }
  if (task.status === 'done' || task.status === 'dropped') {
    return `${task.id} is ${task.status}, so it waits on nothing: reopen it (teamrig set ${task.id} --status in-progress), then set it waiting on ${id}`;
  }
  if (!hasStarted(task)) {
    return `${task.id} has not started, so it does not wait on ${id}: it stays ${task.status}, planned after it (teamrig update ${task.id} --after ${id})`;
  }
  if (taskNumber(id) >= taskNumber(state.nextId)) {
    return `no task ${id}`;
  }
  const target = state.tasks.get(id);
  if (target === undefined || target.status === 'done' || target.status === 'dropped') {
    return `${id} is already finished; nothing to wait on`;
  }
  return loopProblem(task.id, id, state, true);
}

/**
 * In progress, verifying (its work shipped, whatever an older register's row says of its start) or waiting after it
 * started: a task that can wait on another.
 */
function hasStarted(task: Task): boolean {
  return task.status === 'in-progress' || task.status === 'verifying' || (task.status === 'waiting' && task.startedAt !== null);
}

/** Open, or waiting without ever starting (on an approval, or a row an older register migrated): a task a plan fits. */
function notStarted(task: Task): boolean {
  return task.status === 'open' || (task.status === 'waiting' && task.startedAt === null);
}

function ownerOnly(task: Task): string {
  return `only the owner (${task.owner}) sets the status of ${task.id}`;
}

/** The active task with this title, compared as {@link normaliseTitle} does: a new one would track the same work twice. */
function activeDuplicate(title: string, state: RegisterState): Task | undefined {
  return [...state.tasks.values()].find((task) => ACTIVE_STATUSES.includes(task.status) && normaliseTitle(task.title) === normaliseTitle(title));
}

/**
 * A plan dependency is for a task not started yet, as {@link taskWaitProblem} sends it here: a started one waits on
 * a task instead, and a finished one needs neither. Clearing it is always fine.
 */
function afterChangeProblem(task: Task, after: readonly string[], state: RegisterState): string | undefined {
  const first = after[0];
  if (first !== undefined && !notStarted(task)) {
    const keeps = task.status === 'verifying' ? 'verifying' : 'waiting';
    const instead = hasStarted(task) ? `; a started task waits on another with --status ${keeps} --waits task:${first}` : '';
    return `--after plans a task not started yet, and ${task.id} is ${task.status}${instead}`;
  }
  return afterProblem(task.id, after, state);
}

/**
 * The tasks `id` comes after must exist, be named once, and never need `id` back, by a plan dependency or a task
 * wait: a loop could never start. On a create, `id` is the id the new task gets.
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
  for (const other of after) {
    const loop = loopProblem(id, other, state, false);
    if (loop !== undefined) {
      return loop;
    }
  }
  return undefined;
}

/**
 * The refusal when making `id` need `other` (by a task wait when `byWait`, else a plan dependency) would close a loop:
 * `other` already needs `id`, directly or not, and no task in a loop can ever finish.
 */
function loopProblem(id: string, other: string, state: RegisterState, byWait: boolean): string | undefined {
  const path = needPath(state.tasks, other, id);
  const owner = state.tasks.get(other)?.owner;
  if (path === undefined || owner === undefined) {
    return undefined;
  }
  return `${pathText([id, ...path])} would be a loop, and no task in a loop can finish: ${loopFix(id, other, owner, byWait)}`;
}

function blankToNull(text: string | undefined): string | null {
  return text === undefined || text.trim() === '' ? null : text.trim();
}

/** Titles compare case- and space-insensitively when looking for duplicates. */
export function normaliseTitle(title: string): string {
  return title.toLowerCase().replace(/\s+/g, ' ').trim();
}
