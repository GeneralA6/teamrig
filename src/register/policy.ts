import { MAX_DESCRIPTION } from '../config/defaults.ts';
import { LeadTree } from '../config/lead-tree.ts';
import { priorityLevels } from '../config/priorities.ts';
import type { KitConfig } from '../config/types.ts';
import { ADDRESS_PATTERN, type SessionAddress } from '../core/address.ts';
import { SecretScanner } from '../core/secrets.ts';
import { parseDeadline, parseUtcDay, parseUtcDeadline, showStored } from '../core/time.ts';
import type { TimeZone } from '../core/zone.ts';
import { waitAnswerersOf } from './approval.ts';
import { CARD_FLAGS, cardProblem, cardTexts, GATE_FLAG, gateOf, gateUsage, keptCard, OPTION_SEPARATOR, sameCard, WHY_ASK_FLAG, whyAskUsage, type DecisionCard } from './card.ts';
import { ITEM_TYPES, sizeProblem, type ApprovalVerdict, type ItemType, type TaskFieldName, type TaskFields } from './events.ts';
import { isRepark, taskNumber, type RegisterState, type Task } from './fold.ts';
import { ACTIVE_STATUSES, FOLLOWUP_STATUSES, GITHUB_SOURCE, priorityText, SESSION_NAME, WAIT_STATUSES, type TaskStatus } from './model.ts';
import { ITEM_TYPE_TRAITS, traitsOf } from './item-types.ts';
import { waitsOnOwner } from './owner-waits.ts';
import { asksReview, missedTaskIds, reviewGap, reviewGapText, reviewProblem, reviewTexts, type ProblemReview } from './review.ts';
import { loopFix, needPath, NO_TASKS_ELSEWHERE, pathText, type TasksElsewhere } from './tree.ts';
import { dueStartHolds, dueVerifyHold, heldStart, startHolds, WATCH_USAGE } from './verify.ts';
import { isPeerWait, isReady, sameWait, sameWaits, waitContext, waitSpelling, type PersonWait, type PersonWaitKind, type WaitReason } from './waits.ts';

/** Team policy, applied on WRITE only: the parser accepts any well-formed history. */
export type Verdict<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };

/** The skill name that closes a task which produced no reusable procedure. */
export const NO_SKILL = 'none';

/** Who the GitHub import's events are written by; its tasks carry GITHUB_SOURCE (model.ts). */
export const GITHUB_ACTOR = 'github';

/** The statuses the import sets on its own tasks: an issue's open state, or how it was closed. */
export const GITHUB_STATUSES: readonly TaskStatus[] = ['open', 'done', 'dropped'];

/**
 * Fields the lead may change on a task someone else owns: who does it, how urgent, when, in what order and its size
 * (the lead plans the week), and its type and critical mark, so the lead can mark another session's fix a bug.
 */
export const LEAD_FIELDS: readonly TaskFieldName[] = ['owner', 'priority', 'due', 'week', 'after', 'size', 'type', 'critical', 'pin'];

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
  /** Said to serve no goal (`--goals none`); never with `goals`. */
  readonly noGoal?: boolean;
  readonly week?: string;
  readonly after?: readonly string[];
  /** What the task costs, in percent of the weekly usage limit. */
  readonly size?: number;
  /** What the item is (`--type`); absent: not set, read as a task. */
  readonly type?: ItemType;
  /** Whether it sits in a critical area (`--critical`), which only a type with a review takes. */
  readonly critical?: boolean;
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
   * What a sighting shows once a `done` change runs live, when tests or a dry run proved it and only that sighting is
   * left to watch for (T1306); only with `done`.
   */
  readonly watch?: string;
  /**
   * What shows the proof of the verifying tasks a start needs exists; only on a start they hold. The start then goes
   * through, and the CLI asks their owners to confirm (done) or reopen them.
   */
  readonly met?: string;
  /** The date to verify by, as the task's due date; only with `verifying`. */
  readonly due?: string;
  /** The tasks the work leaves (a finding, a next step), by id; empty for `--followups none`. Only with FOLLOWUP_STATUSES. */
  readonly followups?: readonly string[];
  /** The parts of its review the change gives (review.ts); only on a bug (a type whose traits ask a review). Parts left out keep what the task had. */
  readonly review?: ProblemReview;
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
 * What a status change is judged against besides the task: the register as read, the tasks the team tree's other
 * registers hold (a wait or a follow-up may name one), the time, the team's zone (a stored day is a day of it), and
 * whether a cited skill exists.
 */
export interface StatusContext {
  readonly state: RegisterState;
  readonly elsewhere: TasksElsewhere;
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
  /** Only with `done`, and only when given: the sighting left to watch for. Setting done again without one clears it. */
  readonly watch?: string;
  /** Only on a start the verifying tasks it needs hold: what shows their proof exists. */
  readonly met?: string;
  /** Only with `verifying`, and only when it moves the task's due date: the date to verify by. */
  readonly due?: string;
  /** Only when the change names them: the tasks the work leaves, empty for none, with the tasks its review's missed parts name. */
  readonly followups?: readonly string[];
  /** Only when the change gives them: the parts of the bug's review it gives. */
  readonly review?: ProblemReview;
}

/** The refusal of an `add` with no description while `register.requireDescription` is on. */
export const DESCRIPTION_NEEDED = 'add needs --description "<what and why, in plain words>"';

/** How a card is typed, for the refusals that ask for one. */
export const CARD_USAGE = `--question "<what is decided>" --options "<one choice, its numbers> ${OPTION_SEPARATOR} <another>" --recommend "<which, and why>" --default "<what happens with no answer by the due date>"`;

/** How `--waits` is typed, for the refusals that ask for it. */
export const WAITS_USAGE = 'decision:<who>, approval:<who>, task:T<id> or time:<YYYY-MM-DD HH:MM>, comma-separated';

/** How a verifying task names when its proof runs (T1306), for the refusals that ask for it. */
export const PROOF_WAITS_USAGE = 'time:<YYYY-MM-DD HH:MM> when it runs, or task:T<id> for a task in progress or verifying whose end runs it';

/** The statuses of a task a proof may wait on: one under way, whose end runs the proof. */
const PROOF_TASK_STATUSES: readonly TaskStatus[] = ['in-progress', 'verifying'];

export interface UpdateChange {
  readonly changes: Partial<TaskFields>;
  readonly note: string | null;
}

/** An answer to an approval wait: an update that changes no field, with the lead's verdict and its note. */
export interface ApprovalChange extends UpdateChange {
  readonly verdict: ApprovalVerdict;
}

/** A Later (T1295): an update that changes no field, with what the owner said and the task's waits from then on. */
export interface DeferChange extends UpdateChange {
  readonly waits: readonly WaitReason[];
}

/** An owner's action from the pane (T1298): an update written as `by`, the team's register.ownerSource. */
export interface OwnerChange extends UpdateChange {
  readonly by: string;
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

  /** `above`: the parent team's lead, on a child team, who approves the lead's own work (T1140). */
  constructor(config: KitConfig, above?: SessionAddress) {
    this.config = config;
    this.secrets = new SecretScanner(config.register.secretPatterns);
    this.tree = new LeadTree(config, above);
  }

  /**
   * The approvers of the owner's task in words: the lead alone, or its leaders up the tree, nearest first (T781); for a
   * child team's lead, the parent team's lead (T1140).
   */
  private approversText(owner: string): string {
    const approvers = this.tree.approversOf(owner);
    if (approvers.length > 1) {
      return `a leader above ${owner} (${approvers.join(' or ')})`;
    }
    const [only] = approvers;
    return only !== undefined && only === this.tree.above ? `the parent team's lead (${only})` : `the lead (${this.config.roles.lead})`;
  }

  /** Who answers a `kind` wait on the owner's task in words: its approvers, and the security reviewer too when it answers one. */
  private answerersText(owner: string, kind: PersonWaitKind): string {
    const leaders = this.tree.approversOf(owner);
    const reviewer = waitAnswerersOf(this.tree, this.config.roles, owner)[kind].find((who) => !leaders.includes(who));
    const approvers = this.approversText(owner);
    return reviewer === undefined ? approvers : `${approvers} or the security reviewer (${reviewer})`;
  }

  /** The caller must be on the roster before writing anything. */
  checkCaller(session: string): string | undefined {
    return this.config.sessions.includes(session)
      ? undefined
      : `${session} is not a session on this team (sessions: ${this.config.sessions.join(', ')})`;
  }

  /** `elsewhere`: the tasks the team tree's other registers hold, which `--after` may name. */
  add(input: AddInput, state: RegisterState, elsewhere: TasksElsewhere = NO_TASKS_ELSEWHERE): Verdict<TaskFields> {
    return this.create(input, state, (source) => this.teamSourceProblem(source), elsewhere);
  }

  /**
   * A task a session of another team in the tree asks of this team (T1141): its source is the asker's `<team>/<id>`,
   * and any session of this team may own it, as for a task of the team's own.
   */
  addFromTeam(input: AddInput, state: RegisterState, elsewhere: TasksElsewhere = NO_TASKS_ELSEWHERE): Verdict<TaskFields> {
    return this.create(input, state, (source) => (ADDRESS_PATTERN.test(source) ? undefined : `source ${source} is not the asking session's <team>/<id>`), elsewhere);
  }

  private create(input: AddInput, state: RegisterState, sourceRule: SourceRule, elsewhere: TasksElsewhere = NO_TASKS_ELSEWHERE): Verdict<TaskFields> {
    const fields: TaskFields = {
      title: input.title.trim(),
      description: blankToNull(input.description),
      owner: input.owner,
      source: input.source,
      ref: input.ref ?? null,
      priority: input.priority,
      due: input.due ?? null,
      goals: input.goals ?? [],
      noGoal: input.noGoal ?? false,
      week: input.week ?? null,
      after: input.after ?? [],
      size: input.size ?? null,
      type: input.type ?? null,
      critical: input.critical ?? false,
      pin: null,
    };
    if (fields.description === null && this.config.register.requireDescription) {
      return refuse(DESCRIPTION_NEEDED);
    }
    const problem = this.checkFields(fields, sourceRule) ?? afterProblem(null, fields.after, state, elsewhere);
    if (problem !== undefined) {
      return refuse(problem);
    }
    const duplicate = activeDuplicate(fields.title, state);
    return duplicate === undefined ? ok(fields) : refuse(`${duplicate.id} already tracks this (${duplicate.status}, owner ${duplicate.owner})`);
  }

  /**
   * The task `set <id> --status waiting --ask <session> --text "<the work>"` creates, which `task` then waits on: the
   * asked session's, from the caller, at `task`'s priority and with its goals or none (the work serves the same plan), its
   * description naming `task`. Only the owner asks for its task, only with `waiting` (the asked task starts open, and
   * a proof waits only on a task in progress or verifying, T1306) and only once started: one not started keeps its
   * status, planned after the asked task. An active task of the same title is waited on instead.
   */
  ask(task: Task, caller: string, ask: AskInput, input: StatusInput, state: RegisterState): Verdict<TaskFields> {
    if (caller !== task.owner) {
      return refuse(ownerOnly(task));
    }
    if (input.status === 'verifying') {
      return refuse(
        `--ask goes only with --status waiting: the asked task starts open, and a proof waits only on a task in progress or verifying, so ${task.id} waits on it until it starts (teamrig set ${task.id} --status waiting --ask ${ask.owner} --text "${ask.title}")`,
      );
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
      noGoal: task.noGoal,
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
    const dueVerify = dueStartHolds(task, input.status, context.state.tasks, context.now, context.zone, register.maxVerifying, context.elsewhere);
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
    // A proof put off to other waits again and again is never run: past the limit the task is proven or reopened.
    if (register.maxReparks > 0 && task.reparks >= register.maxReparks && isRepark(task, input.status, waits.value)) {
      return refuse(
        `${task.id}'s proof was put off to other waits ${task.reparks} times [register.maxReparks]: run the proof now and set it done, close it done with ${WATCH_USAGE} if tests or a dry run proved it, or reopen it (teamrig set ${task.id} --status in-progress)`,
      );
    }
    const card = this.cardChange(task, input, waits.value);
    if (!card.ok) {
      return card;
    }
    const proof = proofChange(task, input);
    if (!proof.ok) {
      return proof;
    }
    const watch = watchChange(input);
    if (!watch.ok) {
      return watch;
    }
    const due = dueChange(task, input);
    if (!due.ok) {
      return due;
    }
    const givesReview = reviewTexts(input.review ?? {}).length > 0;
    const same = !givesReview && proof.value === task.proof && watch.value === task.watch && due.value === null && sameWaits(waits.value, task.waits) && sameCard(card.value, task.card);
    if (input.status === task.status && note === null && same) {
      return refuse(`${task.id} is already ${task.status}; add --note to record why you set it again`);
    }
    if (register.requireNoteOn.includes(input.status) && note === null) {
      return refuse(input.status === 'verifying' && !register.requireProofOnVerifying ? 'verifying needs --note saying what proves it' : `${input.status} needs --note`);
    }
    if (input.status === 'verifying' && register.requireProofOnVerifying && proof.value === null) {
      return refuse('verifying needs --proof saying what will prove the shipped change works');
    }
    // A proof with no time or task to run on is put off without end, so verifying names when it runs (T1306); a
    // change whose proof left is a sighting has neither, so the refusal names --watch.
    if (input.status === 'verifying' && register.requireProofOnVerifying && !waits.value.some(runsProof)) {
      return refuse(
        `verifying needs --waits saying when its proof runs: ${PROOF_WAITS_USAGE}; if tests or a dry run proved it and its proof is a sighting, close it done with ${WATCH_USAGE} instead`,
      );
    }
    if (input.status === 'done') {
      if (register.requireEvidenceOnDone && evidence === null && task.evidence === null) {
        return refuse('done needs --evidence: a commit, test count, path or number that proves it');
      }
      // A watch stands in for the live proof only on the tests or dry run that proved the change, so it names them.
      if (watch.value !== null && evidence === null && task.evidence === null) {
        return refuse('--watch needs --evidence: the tests or dry run that proved the change');
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
    const review = this.checkReview(task, input, context);
    if (!review.ok) {
      return review;
    }
    // A missed part's follow-up (the test, monitor or log it adds) joins the tasks the work leaves.
    const missed = review.value === null ? [] : missedTaskIds(review.value).filter((id) => id !== task.id);
    const leaves = followups.value === null && missed.length === 0 ? null : [...new Set([...(followups.value ?? []), ...missed])];
    const texts: readonly [string, string | null][] = [
      ['note', note],
      ['evidence', evidence],
      ['proof', proof.value],
      ['watch', watch.value],
      ['met', met],
      ...(card.value === null ? [] : cardTexts(card.value).map((text): [string, string] => ['card', text])),
      ...(review.value === null ? [] : reviewTexts(review.value).map(([flag, text]): [string, string] => [flag.slice(2), text])),
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
      ...(watch.value === null ? {} : { watch: watch.value }),
      ...(met === null ? {} : { met }),
      ...(due.value === null ? {} : { due: due.value }),
      ...(leaves === null ? {} : { followups: leaves }),
      ...(review.value === null ? {} : { review: review.value }),
    };
    return problem === undefined ? ok(change) : refuse(problem);
  }

  /**
   * The review parts a status change gives (review.ts): only on a bug, each saying enough, and each
   * task a missed part names on the list. A bug reaching a `register.review.requireOn` status with parts still
   * missing is refused while the review's mode is `refuse`; `warn` lets it through and the CLI names them. Null when
   * the change gives none.
   */
  private checkReview(task: Task, input: StatusInput, context: StatusContext): Verdict<ProblemReview | null> {
    const given = input.review ?? {};
    const [first] = reviewTexts(given);
    if (first !== undefined && !asksReview(task)) {
      return refuse(`${first[0]} goes only with a ${reviewedTypes()}: mark it first, teamrig update ${task.id} --type ${reviewedTypes()}`);
    }
    const problem = reviewProblem(given);
    if (problem !== undefined) {
      return refuse(problem);
    }
    const unlisted = missedTaskIds(given).find((id) => !context.state.tasks.has(id));
    if (unlisted !== undefined) {
      return refuse(`a missed part names ${unlisted}, which is not on the task list: add it first (teamrig add)`);
    }
    const { review } = this.config.register;
    const missing = reviewGap(task, input.status, given, review);
    if (missing.length > 0 && review.mode === 'refuse') {
      return refuse(reviewGapText(task, input.status, missing));
    }
    return ok(first === undefined ? null : given);
  }

  /**
   * The follow-ups a status change names: required on the statuses `register.requireFollowupsOn` lists, allowed
   * only on FOLLOWUP_STATUSES, each another task on the list, or on another register of the team tree, and named
   * once; null when the change names none.
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
      if (!context.state.tasks.has(id) && !context.elsewhere.has(id)) {
        return refuse(`--followups names ${id}, which is not on the task list: add it first (teamrig add)`);
      }
    }
    return ok(followups);
  }

  /**
   * The reasons of a status change, each given one judged: at least one for `waiting`; for `verifying`, what its proof
   * waits for, where a verifying task set again without `--waits` keeps the reasons it had (a new verify-by date leaves
   * them in place), none cleared while `register.requireProofOnVerifying` is on; none for any other status.
   */
  private checkWaits(task: Task, input: StatusInput, context: StatusContext): Verdict<readonly WaitReason[]> {
    if (!WAIT_STATUSES.includes(input.status)) {
      return (input.waits ?? []).length === 0 ? ok([]) : refuse(`--waits goes only with --status ${WAIT_STATUSES.join(' or ')}`);
    }
    if (input.waits === undefined && input.status === 'verifying') {
      const kept = task.status === 'verifying' ? task.waits : [];
      const cleared = this.config.register.requireProofOnVerifying ? clearedProofWait(task, kept, context) : undefined;
      return cleared === undefined ? ok(kept) : refuse(cleared);
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
   * `register.requireDecisionCard` is on, so the owner decides from it alone (T514). `--why-ask` goes only on a
   * task the owner ordered that waits on the owner, and a card keeps it only while that holds (T802); while cards
   * are required, such a task asks the owner only with it (ownerOrderCard). `--gate` goes only with a wait on the
   * owner's decision, naming an owner gate or business, and a card keeps it only while that holds (T1194); while
   * cards are required, the owner is asked to decide only with it (gatedCard).
   */
  private cardChange(task: Task, input: StatusInput, waits: readonly WaitReason[]): Verdict<DecisionCard | null> {
    const asks = waits.filter((reason): reason is PersonWait => reason.kind === 'decision' || reason.kind === 'approval');
    const given = input.card;
    if (asks.length === 0) {
      return given === undefined ? ok(null) : refuse(`${CARD_FLAGS} go only with --status ${WAIT_STATUSES.join(' or ')} on a decision or an approval`);
    }
    const { ownerSource, requireDecisionCard } = this.config.register;
    const owners = asks.filter((reason) => reason.who === ownerSource);
    const ordered = task.source === ownerSource && owners.length > 0;
    const decidesOwner = owners.some((reason) => reason.kind === 'decision');
    if (given?.whyAsk !== undefined && !ordered) {
      return refuse(`${WHY_ASK_FLAG} says why ${ownerSource} is asked about what ${ownerSource} ordered: it goes only with a wait on ${ownerSource}'s decision or approval of a task from ${ownerSource}`);
    }
    if (given?.gate !== undefined && !decidesOwner) {
      return refuse(`${GATE_FLAG} names the owner gate or business decision that makes a question ${ownerSource}'s: it goes only with a wait on ${ownerSource}'s decision`);
    }
    const gate = given?.gate === undefined ? undefined : gateOf(given.gate, this.config.ownerGates);
    if (given?.gate !== undefined && gate === undefined) {
      return refuse(`${GATE_FLAG} "${given.gate}" is no owner gate [ownerGates] and no business decision: ${gateUsage(this.config.ownerGates)}`);
    }
    const kept = WAIT_STATUSES.includes(task.status) ? task.card : null;
    const before = kept === null ? null : keptCard(kept, { whyAsk: ordered, gate: decidesOwner });
    if (given === undefined) {
      if (before !== null || owners.length === 0 || !requireDecisionCard || ordered) {
        return this.ownerAsk(task, owners, before);
      }
      const kinds = owners.map((reason) => reason.kind).join(' and ');
      return refuse(`a wait on ${ownerSource}'s ${kinds} needs a card, so ${ownerSource} decides from it alone: ${CARD_USAGE}${decidesOwner ? ` ${gateUsage(this.config.ownerGates)}` : ''}`);
    }
    const parts: Partial<DecisionCard> = { ...before, ...given, ...(gate === undefined ? {} : { gate }) };
    if (parts.question === undefined || parts.recommend === undefined || parts.byDefault === undefined) {
      return refuse(`a card needs ${CARD_FLAGS} (--options for a decision): ${CARD_USAGE}`);
    }
    const card: DecisionCard = {
      question: parts.question,
      options: parts.options ?? [],
      recommend: parts.recommend,
      byDefault: parts.byDefault,
      ...(parts.whyAsk === undefined ? {} : { whyAsk: parts.whyAsk }),
      ...(parts.gate === undefined ? {} : { gate: parts.gate }),
    };
    const problem = cardProblem(card, asks.some((reason) => reason.kind === 'decision'));
    return problem === undefined ? this.ownerAsk(task, owners, card) : refuse(problem);
  }

  /** What a card asking the owner (`owners`) must say besides its parts: why, on an owner's order; its gate, on a decision. */
  private ownerAsk(task: Task, owners: readonly PersonWait[], card: DecisionCard | null): Verdict<DecisionCard | null> {
    const ordered = this.ownerOrderCard(task, owners, card);
    return ordered.ok ? this.gatedCard(task, owners, card) : ordered;
  }

  /**
   * Only an owner gate [ownerGates] or a business decision is the owner's to decide (T1194), so while
   * `register.requireDecisionCard` is on, a wait on the owner's decision needs a card naming its gate; any other
   * question is the session's or its leader's, however many good answers it has. check flags rows written before
   * (UNGATED).
   */
  private gatedCard(task: Task, owners: readonly PersonWait[], card: DecisionCard | null): Verdict<DecisionCard | null> {
    const { ownerSource, requireDecisionCard } = this.config.register;
    if (!requireDecisionCard || card?.gate !== undefined || !owners.some((reason) => reason.kind === 'decision')) {
      return ok(card);
    }
    const leader = this.tree.leaderOf(task.owner) ?? (task.owner === this.tree.lead ? this.tree.above : undefined);
    const elsewhere = leader === undefined ? 'decide it' : `decide it, or wait on your leader (--waits decision:${leader})`;
    return refuse(
      `only an owner gate or a business decision is ${ownerSource}'s to decide: give ${gateUsage(this.config.ownerGates)}${card === null ? ` with ${CARD_USAGE}` : ''}; any other question is yours however many good answers it has: ${elsewhere}`,
    );
  }

  /**
   * An owner's order approves its own work and proof (rule 6), so while `register.requireDecisionCard` is on, a task
   * the owner ordered waits on the owner (`owners`) only with a card that says why (`whyAsk`, T802); check flags rows
   * written before or with the switch off (OWNER-ORDERED).
   */
  private ownerOrderCard(task: Task, owners: readonly PersonWait[], card: DecisionCard | null): Verdict<DecisionCard | null> {
    const { ownerSource, requireDecisionCard } = this.config.register;
    if (task.source !== ownerSource || owners.length === 0 || !requireDecisionCard || card?.whyAsk !== undefined) {
      return ok(card);
    }
    const kinds = owners.map((reason) => reason.kind).join(' and ');
    return refuse(`${ownerSource} ordered ${task.id}, and an order approves its own work and proof: drop the wait on ${ownerSource}'s ${kinds}, or give ${whyAskUsage(ownerSource)}${card === null ? ` with ${CARD_USAGE}` : ''}`);
  }

  private waitProblem(task: Task, status: TaskStatus, reason: WaitReason, context: StatusContext): string | undefined {
    switch (reason.kind) {
      case 'decision':
      case 'approval':
        return this.personWaitProblem(task, reason);
      case 'task':
        return taskWaitProblem(task, reason.id, context.state, context.elsewhere) ?? (status === 'verifying' ? unstartedProofTask(task, reason.id, context) : undefined);
      case 'time':
        return timeProblem(reason.at, context);
    }
  }

  /**
   * Decision and approval waits are for the task owner's leaders (the lead, and any sub-lead above it; for a child
   * team's lead, the parent team's lead) and the owner, an approval wait also for the security reviewer, on another's
   * task (`waitAnswerersOf`): a peer's work is a task, waited on by its id, which clears by itself once that task
   * finishes, where a peer's decision would hold the task until its owner noticed.
   */
  private personWaitProblem(task: Task, reason: PersonWait): string | undefined {
    const { ownerSource } = this.config.register;
    if (!isPeerWait(reason, waitAnswerersOf(this.tree, this.config.roles, task.owner), ownerSource)) {
      return undefined;
    }
    const answerers = this.answerersText(task.owner, reason.kind);
    return this.config.sessions.includes(reason.who)
      ? `${reason.kind} ${reason.who}: ${reason.kind} waits are for ${answerers} and ${ownerSource}; wait on ${reason.who}'s work by its task: teamrig set ${task.id} --status waiting --ask ${reason.who} --text "<the work you need>"`
      : `${reason.kind} ${reason.who}: ${reason.who} is neither ${answerers} nor ${ownerSource}`;
  }

  /**
   * An answer to a task's approval wait (T684): only a leader above the task's owner answers (the lead, or a sub-lead,
   * T781; on a child team's lead's task, the parent team's lead, as `<team>/<id>`, T1140), or the security reviewer on
   * another's task (T828), only a task waiting on its own approval, and always with a note, which the task's owner
   * reads: what it checked, or why it declines. An approval of the owner's stays the owner's: no lead answers it.
   */
  approve(task: Task, caller: string, verdict: ApprovalVerdict, note: string | undefined): Verdict<ApprovalChange> {
    const { lead } = this.config.roles;
    if (!waitAnswerersOf(this.tree, this.config.roles, task.owner).approval.includes(caller)) {
      return refuse(`only ${this.answerersText(task.owner, 'approval')} answers an approval of ${task.owner}'s`);
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

  /**
   * A Later (T1295): the owner puts off a card, a task's wait on the owner's decision or approval, to time `until`
   * (stored form), or `null` brings it back now. Its owner or a leader above it records what the owner said, as
   * {@link deferFrom} judges it.
   */
  defer(task: Task, caller: string, until: string | null, note: string | undefined, context: Pick<StatusContext, 'now' | 'zone'>): Verdict<DeferChange> {
    if (caller !== task.owner && caller !== this.tree.lead && !this.tree.leads(caller, task.owner)) {
      return refuse(`only the owner (${task.owner}) or ${this.approversText(task.owner)} puts ${task.id} off`);
    }
    return this.deferFrom(task, until, note, context);
  }

  /**
   * A Later's content, for the lead above who asks the owner this team's decisions too (Register.deferFrom, whose
   * caller the tree decides): only a task waiting on the owner is put off, always with a note saying what the owner
   * said, to a time still to come. The time is a time wait beside the owner's, replacing any time wait the task had,
   * so the latest one still to come is the Later (owner-waits.ts); `null` drops the task's time waits.
   */
  deferFrom(task: Task, until: string | null, note: string | undefined, context: Pick<StatusContext, 'now' | 'zone'>): Verdict<DeferChange> {
    const { ownerSource } = this.config.register;
    if (!waitsOnOwner(task, ownerSource)) {
      return refuse(`${task.id} waits on no decision or approval of ${ownerSource}: only such a card is put off`);
    }
    const text = blankToNull(note);
    if (text === null) {
      return refuse(`a Later needs --note: what ${ownerSource} said`);
    }
    const untimed = task.waits.filter((reason) => reason.kind !== 'time');
    if (until === null && untimed.length === task.waits.length) {
      return refuse(`${task.id} is not put off: no time to drop`);
    }
    const problem = (until === null ? undefined : timeProblem(until, context)) ?? this.checkText('note', text);
    if (problem !== undefined) {
      return refuse(problem);
    }
    const waits: readonly WaitReason[] = until === null ? untimed : [...untimed, { kind: 'time', at: until }];
    return ok({ changes: {}, note: text, waits });
  }

  /**
   * The owner's Note from the pane (T1298): free text for the task's session, kept in its history as the owner's and
   * changing no field. A finished task takes none, as its session has moved on.
   */
  ownerNote(task: Task, note: string | undefined): Verdict<OwnerChange> {
    const by = this.config.register.ownerSource;
    if (!ACTIVE_STATUSES.includes(task.status)) {
      return refuse(`${task.id} is ${task.status}: ${by}'s Note goes to a task still to finish`);
    }
    const text = blankToNull(note);
    if (text === null) {
      return refuse(`a Note needs --text: what ${by} tells ${task.owner}`);
    }
    const problem = this.checkText('note', text);
    return problem === undefined ? ok({ by, changes: {}, note: text }) : refuse(problem);
  }

  /**
   * The owner's Next from the pane (T1298): the owner's pin, above every other task of the task's owner (the register
   * moves that owner's earlier pin down). Not on a finished task, one in progress (in hand already), or one the owner
   * put next already, whose session was told then.
   */
  ownerNext(task: Task): Verdict<OwnerChange> {
    const by = this.config.register.ownerSource;
    if (!ACTIVE_STATUSES.includes(task.status)) {
      return refuse(`${task.id} is ${task.status}: only a task still to finish goes next`);
    }
    if (task.status === 'in-progress') {
      return refuse(`${task.id} is in progress: ${task.owner} has it in hand already`);
    }
    if (task.pin === by) {
      return refuse(`${task.id} is next already: ${by} put it there; a Note tells ${task.owner} more`);
    }
    return ok({ by, changes: { pin: by }, note: null });
  }

  /** `elsewhere`: the tasks the team tree's other registers hold, which `--after` may name. */
  update(
    task: Task,
    caller: string,
    asked: Partial<TaskFields>,
    note: string | undefined,
    state: RegisterState,
    elsewhere: TasksElsewhere = NO_TASKS_ELSEWHERE,
  ): Verdict<UpdateChange> {
    const changes = clearNoGoal(task, clearCritical(task, trimDescription(asked)));
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
    const pinned = changes.pin === undefined ? undefined : this.pinProblem(task.id, changes.owner ?? task.owner, caller, changes.pin);
    if (pinned !== undefined) {
      return refuse(pinned);
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
    const after = changes.after === undefined ? undefined : afterChangeProblem(task, changes.after, state, elsewhere);
    const problem = after ?? this.checkFields(merged, sourceRule) ?? this.checkText('note', text);
    return problem === undefined ? ok({ changes, note: text }) : refuse(problem);
  }

  /**
   * Why `caller` may not set the pin of task `id` (`pin`: the session that pins, null to unpin), or undefined when it
   * may: a pin puts the task above its `owner`'s computed order (the owner it has after the change), so the owner's
   * leaders set it, the lead on its own tasks too, and never the owner itself; a pin names the session that set it (T637).
   */
  private pinProblem(id: string, owner: string, caller: string, pin: string | null): string | undefined {
    if (caller === owner && caller !== this.tree.lead) {
      return `${owner} does not pin its own ${id}: ${this.approversText(owner)} pins a task above its owner's order`;
    }
    return pin === null || pin === caller ? undefined : `a pin names the session that sets it (${caller}), not ${pin}`;
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
    const fields: TaskFields = { ...input, source: GITHUB_SOURCE, due: null, goals: [], noGoal: false, week: null, after: [], size: null, type: null, critical: false, pin: null };
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
    if (fields.critical && !traitsOf(fields).review) {
      return `critical marks only a ${reviewedTypes()}: give --type ${reviewedTypes()} too`;
    }
    const sourceProblem = sourceRule(fields.source);
    if (sourceProblem !== undefined) {
      return sourceProblem;
    }
    const levels = priorityLevels(register.priorities);
    if (!levels.some((priority) => priority.id === fields.priority)) {
      return `priority ${priorityText(fields.priority)} is not one of ${levels.map((priority) => priorityText(priority.id)).join(', ')}`;
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
    if (fields.noGoal && fields.goals.length > 0) {
      return `goals none says the task serves no goal, so it names none (asked: ${fields.goals.join(', ')})`;
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
  const { title, description, owner, source, ref, priority, due, goals, noGoal, week, after, size, type, critical, pin } = task;
  return { title, description, owner, source, ref, priority, due, goals, noGoal, week, after, size, type, critical, pin };
}

/** An update naming goals for a task said to serve none also clears that mark, which a task with goals cannot hold. */
function clearNoGoal(task: Task, changes: Partial<TaskFields>): Partial<TaskFields> {
  return changes.goals !== undefined && changes.goals.length > 0 && changes.noGoal === undefined && task.noGoal ? { ...changes, noGoal: false } : changes;
}

/** The types an item can be critical in, those that give the review: `bug`, or `bug|incident`. */
function reviewedTypes(): string {
  return ITEM_TYPES.filter((type) => ITEM_TYPE_TRAITS[type].review).join('|');
}

/** An update moving a critical item to a type without a review also clears its critical mark, which that type cannot hold. */
function clearCritical(task: Task, changes: Partial<TaskFields>): Partial<TaskFields> {
  return changes.type !== undefined && changes.critical === undefined && task.critical && !traitsOf({ type: changes.type }).review ? { ...changes, critical: false } : changes;
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

/**
 * The sighting a status change leaves to watch for: none outside `done`, where `--watch` is refused, and only the one
 * given, so setting done again without one clears it once the sighting came.
 */
function watchChange(input: StatusInput): Verdict<string | null> {
  const watch = blankToNull(input.watch);
  return watch === null || input.status === 'done' ? ok(watch) : refuse('--watch goes only with --status done');
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

/**
 * A task reason is for a task already started (see {@link hasStarted}) that found another task must finish first,
 * a verifying one for its proof: one not started stays open with a plan dependency instead, and a finished one
 * reopens first. The task waited on may be another register's of the team tree; an id no register's working set holds
 * reads as finished below this register's next number, else as no task. It never closes a loop, through another
 * register's tasks either.
 */
function taskWaitProblem(task: Task, id: string, state: RegisterState, elsewhere: TasksElsewhere): string | undefined {
  if (id === task.id) {
    return `${task.id} cannot wait on itself`;
  }
  if (task.status === 'done' || task.status === 'dropped') {
    return `${task.id} is ${task.status}, so it waits on nothing: reopen it (teamrig set ${task.id} --status in-progress), then set it waiting on ${id}`;
  }
  if (!hasStarted(task)) {
    return `${task.id} has not started, so it does not wait on ${id}: it stays ${task.status}, planned after it (teamrig update ${task.id} --after ${id})`;
  }
  const target = state.tasks.get(id) ?? elsewhere.get(id)?.task;
  if (target === undefined && taskNumber(id) >= taskNumber(state.nextId)) {
    return `no task ${id}`;
  }
  if (target === undefined || target.status === 'done' || target.status === 'dropped') {
    return `${id} is already finished; nothing to wait on`;
  }
  return loopProblem(task.id, id, treeTasks(state, elsewhere), true);
}

/** True for a reason that says when a proof runs: a time, or a task whose end runs it. */
function runsProof(reason: WaitReason): boolean {
  return reason.kind === 'time' || reason.kind === 'task';
}

/**
 * A proof runs when the task it waits on ends, so it waits only on one in progress or verifying (T1306): one not
 * started has no end in sight, and the task stays waiting on it until it starts.
 */
function unstartedProofTask(task: Task, id: string, context: StatusContext): string | undefined {
  const target = context.state.tasks.get(id) ?? context.elsewhere.get(id)?.task;
  if (target === undefined || PROOF_TASK_STATUSES.includes(target.status)) {
    return undefined;
  }
  return `${id} is ${target.status}: a proof waits only on a task in progress or verifying; until it starts, set ${task.id} waiting on it (--status waiting --waits task:${id})`;
}

/**
 * The refusal of a verifying task set again without `--waits` whose kept waits hold one that cleared (T1306): its
 * proof is due now, not put off again by keeping a wait that no longer holds it.
 */
function clearedProofWait(task: Task, kept: readonly WaitReason[], context: StatusContext): string | undefined {
  const waits = waitContext(context.state.tasks, context.now, context.zone, context.elsewhere);
  const cleared = kept.find((reason) => isReady(reason, waits));
  return cleared === undefined
    ? undefined
    : `${task.id}'s proof waited on ${waitSpelling(cleared)}, which has cleared: run the proof now and set it done, or name when it runs with --waits (${PROOF_WAITS_USAGE})`;
}

/**
 * This register's working set over the tasks the team tree's other registers hold, as one map a need is followed
 * through: a loop may pass through another team's task.
 */
function treeTasks(state: RegisterState, elsewhere: TasksElsewhere): ReadonlyMap<string, Task> {
  if (elsewhere.size === 0) {
    return state.tasks;
  }
  return new Map([...[...elsewhere].map(([id, held]): [string, Task] => [id, held.task]), ...state.tasks]);
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
function afterChangeProblem(task: Task, after: readonly string[], state: RegisterState, elsewhere: TasksElsewhere): string | undefined {
  const first = after[0];
  if (first !== undefined && !notStarted(task)) {
    const keeps = task.status === 'verifying' ? 'verifying' : 'waiting';
    const instead = hasStarted(task) ? `; a started task waits on another with --status ${keeps} --waits task:${first}` : '';
    return `--after plans a task not started yet, and ${task.id} is ${task.status}${instead}`;
  }
  return afterProblem(task.id, after, state, elsewhere);
}

/**
 * The tasks `id` comes after must exist, here or on another register of the team tree, be named once, and never need
 * `id` back, by a plan dependency or a task wait: a loop could never start. On a create, `id` is null: the new task's
 * number comes from the numbering at the write, above every register's, so no task names it yet.
 */
function afterProblem(id: string | null, after: readonly string[], state: RegisterState, elsewhere: TasksElsewhere): string | undefined {
  const twice = after.find((other, index) => after.indexOf(other) !== index);
  if (twice !== undefined) {
    return `--after names ${twice} twice`;
  }
  if (id !== null && after.includes(id)) {
    return `${id} cannot come after itself`;
  }
  const missing = after.find((other) => !elsewhere.has(other) && taskNumber(other) >= taskNumber(state.nextId));
  if (missing !== undefined) {
    return `no task ${missing}`;
  }
  if (id === null) {
    return undefined;
  }
  const tasks = treeTasks(state, elsewhere);
  for (const other of after) {
    const loop = loopProblem(id, other, tasks, false);
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
function loopProblem(id: string, other: string, tasks: ReadonlyMap<string, Task>, byWait: boolean): string | undefined {
  const path = needPath(tasks, other, id);
  const owner = tasks.get(other)?.owner;
  if (path === undefined || owner === undefined) {
    return undefined;
  }
  return `${pathText([id, ...path])} would be a loop, and no task in a loop can finish: ${loopFix(id, other, owner, byWait)}`;
}

/** Why a time to wait until (stored form) is refused, or undefined: it must be still to come. */
function timeProblem(at: string, { now, zone }: Pick<StatusContext, 'now' | 'zone'>): string | undefined {
  return (parseDeadline(at, zone)?.getTime() ?? 0) > now.getTime() ? undefined : `time ${showStored(at, zone)} has passed: name a time to come`;
}

function blankToNull(text: string | undefined): string | null {
  return text === undefined || text.trim() === '' ? null : text.trim();
}

/** Titles compare case- and space-insensitively when looking for duplicates. */
export function normaliseTitle(title: string): string {
  return title.toLowerCase().replace(/\s+/g, ' ').trim();
}
