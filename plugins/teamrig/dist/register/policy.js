import { MAX_DESCRIPTION } from "../config/defaults.js";
import { LeadTree } from "../config/lead-tree.js";
import { priorityLevels } from "../config/priorities.js";
import { ADDRESS_PATTERN } from "../core/address.js";
import { SecretScanner } from "../core/secrets.js";
import { parseDeadline, parseUtcDay, parseUtcDeadline, showStored } from "../core/time.js";
import { waitAnswerersOf } from "./approval.js";
import { NO_GOAL_TAGS } from "./goals.js";
import { CARD_FLAGS, cardProblem, cardTexts, GATE_FLAG, gateOf, gateUsage, keptCard, OPTION_SEPARATOR, RUN_FLAG, sameCard, typedHandStep, WHY_ASK_FLAG, whyAskUsage } from "./card.js";
import { auditOf, HAND_STEP_KINDS, handStepFileProblem, shortSha256 } from "./hand-step.js";
import { ITEM_TYPES, sizeProblem } from "./events.js";
import { isRepark, taskNumber } from "./fold.js";
import { ACTIVE_STATUSES, FOLLOWUP_STATUSES, GITHUB_SOURCE, ISSUE_REF_PREFIX, isTopPriority, priorityText, SESSION_NAME, WAIT_STATUSES } from "./model.js";
import { ITEM_TYPE_TRAITS, traitsOf } from "./item-types.js";
import { waitsOnOwner } from "./owner-waits.js";
import { asksReview, missedTaskIds, reviewGap, reviewGapText, reviewProblem, reviewTexts } from "./review.js";
import { loopFix, needPath, NO_TASKS_ELSEWHERE, pathText } from "./tree.js";
import { dueStartHolds, dueVerifyHold, heldStart, startHolds, WATCH_USAGE } from "./verify.js";
import { isPeerWait, isReady, sameWait, sameWaits, waitContext, waitSpelling } from "./waits.js";
import { wipHold } from "./wip.js";
/** The skill name that closes a task which produced no reusable procedure. */
export const NO_SKILL = 'none';
/** Who the GitHub import's events are written by; its tasks carry GITHUB_SOURCE (model.ts). */
export const GITHUB_ACTOR = 'github';
/** The statuses the import sets on its own tasks: an issue's open state, or how it was closed. */
export const GITHUB_STATUSES = ['open', 'done', 'dropped'];
/**
 * Fields the lead may change on a task someone else owns: who does it, how urgent, when, in what order and its size
 * (the lead plans the week), its type and critical mark, so the lead can mark another session's fix a bug, and its
 * work class, as leaders triage the class of their sessions' tasks (T2076).
 */
export const LEAD_FIELDS = ['owner', 'priority', 'due', 'week', 'after', 'size', 'type', 'critical', 'pin', 'workClass'];
/**
 * Fields the lead may change on a task whose owner is no session of the team any more (a retired hire, a session that
 * left at a team split): the LEAD_FIELDS and its ref, which no session of the team could keep true otherwise, such as
 * when the notes it points at move (T1830).
 */
export const LEFT_OWNER_LEAD_FIELDS = [...LEAD_FIELDS, 'ref'];
/** The refusal of an `add` with no description while `register.requireDescription` is on. */
export const DESCRIPTION_NEEDED = 'add needs --description "<what and why, in plain words>"';
/** How a card is typed, for the refusals that ask for one. */
export const CARD_USAGE = `--question "<what is decided>" --options "<one choice, its numbers> ${OPTION_SEPARATOR} <another>" --recommend "<which, and why>" --default "<what happens with no answer by the due date>"`;
/** How `--waits` is typed, for the refusals that ask for it. */
export const WAITS_USAGE = 'decision:<who>, approval:<who>, task:T<id> or time:<YYYY-MM-DD HH:MM>, comma-separated';
/** How a verifying task names when its proof runs (T1306), for the refusals that ask for it. */
export const PROOF_WAITS_USAGE = 'time:<YYYY-MM-DD HH:MM> when it runs, or task:T<id> for a task in progress or verifying whose end runs it';
/** The statuses of a task a proof may wait on: one under way, whose end runs the proof. */
const PROOF_TASK_STATUSES = ['in-progress', 'verifying'];
function ok(value) {
    return { ok: true, value };
}
function refuse(error) {
    return { ok: false, error };
}
/** The import's source rule: its tasks carry GITHUB_SOURCE, which it sets itself. */
const importSource = (source) => (source === GITHUB_SOURCE ? undefined : `source ${source} is not ${GITHUB_SOURCE}`);
export class RegisterPolicy {
    config;
    secrets;
    tree;
    /** `above`: the parent team's lead, on a child team, who approves the lead's own work (T1140). */
    constructor(config, above) {
        this.config = config;
        this.secrets = new SecretScanner(config.register.secretPatterns);
        this.tree = new LeadTree(config, above);
    }
    /**
     * The approvers of the owner's task in words: the lead alone, or its leaders up the tree, nearest first (T781); for a
     * child team's lead, the parent team's lead (T1140).
     */
    approversText(owner) {
        const approvers = this.tree.approversOf(owner);
        if (approvers.length > 1) {
            return `a leader above ${owner} (${approvers.join(' or ')})`;
        }
        const [only] = approvers;
        return only !== undefined && only === this.tree.above ? `the parent team's lead (${only})` : `the lead (${this.config.roles.lead})`;
    }
    /** Who answers a `kind` wait on the owner's task in words: its approvers, and the security reviewer too when it answers one. */
    answerersText(owner, kind) {
        const leaders = this.tree.approversOf(owner);
        const reviewer = waitAnswerersOf(this.tree, this.config.roles, owner)[kind].find((who) => !leaders.includes(who));
        const approvers = this.approversText(owner);
        return reviewer === undefined ? approvers : `${approvers} or the security reviewer (${reviewer})`;
    }
    /** The caller must be on the roster before writing anything. */
    checkCaller(session) {
        return this.config.sessions.includes(session)
            ? undefined
            : `${session} is not a session on this team (sessions: ${this.config.sessions.join(', ')})`;
    }
    /**
     * `elsewhere`: the tasks the team tree's other registers hold, which `--after` may name. `goalTags`: the tags of the
     * goal records of the team and every team above it, which a goal tag must be under `register.goals` checked or
     * required; under required, an owner-asked or p0/p1 task also names its goal or says it serves none (T1730).
     */
    add(input, state, elsewhere = NO_TASKS_ELSEWHERE, goalTags = NO_GOAL_TAGS) {
        return this.withNamedGoal(this.create(input, state, (source) => this.teamSourceProblem(source), elsewhere, goalTags));
    }
    /**
     * A task a session of another team in the tree asks of this team (T1141): its source is the asker's `<team>/<id>`,
     * and any session of this team may own it, as for a task of the team's own. Its goal tags are held to this team's
     * goal records and those above it, as on `add`; naming a goal is left to the asking team's own rule.
     */
    addFromTeam(input, state, elsewhere = NO_TASKS_ELSEWHERE, goalTags = NO_GOAL_TAGS) {
        return this.create(input, state, (source) => (ADDRESS_PATTERN.test(source) ? undefined : `source ${source} is not the asking session's <team>/<id>`), elsewhere, goalTags);
    }
    /**
     * An owner's order that a lead of a team above relays into this team (T2314): its source is this team's
     * register.ownerSource, so it stands here as the owner's own ask, and as one it names its goal under register.goals
     * required, as on `add`. Who may relay is the tree's rule, which the caller checks; any other source is refused, so
     * this never stands in for addFromTeam.
     */
    relayFromTeam(input, state, elsewhere = NO_TASKS_ELSEWHERE, goalTags = NO_GOAL_TAGS) {
        const { ownerSource } = this.config.register;
        const sourceRule = (source) => (source === ownerSource ? undefined : `source ${source} is not ${ownerSource}: a relayed task is ${ownerSource}'s order`);
        return this.withNamedGoal(this.create(input, state, sourceRule, elsewhere, goalTags));
    }
    /** The created task, refused when register.goals required wants it to name its goal and it names none. */
    withNamedGoal(created) {
        const unnamed = created.ok ? this.unnamedGoalProblem(created.value) : undefined;
        return unnamed === undefined ? created : refuse(unnamed);
    }
    create(input, state, sourceRule, elsewhere, goalTags) {
        const fields = {
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
            workClass: input.workClass ?? null,
        };
        if (fields.description === null && this.config.register.requireDescription) {
            return refuse(DESCRIPTION_NEEDED);
        }
        const problem = this.checkFields(fields, sourceRule) ?? afterProblem(null, fields.after, state, elsewhere) ?? this.goalProblem(fields.goals, goalTags);
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
    ask(task, caller, ask, input, state) {
        if (caller !== task.owner) {
            return refuse(ownerOnly(task));
        }
        if (input.status === 'verifying') {
            return refuse(`--ask goes only with --status waiting: the asked task starts open, and a proof waits only on a task in progress or verifying, so ${task.id} waits on it until it starts (teamrig set ${task.id} --status waiting --ask ${ask.owner} --text "${ask.title}")`);
        }
        if (input.status !== 'waiting') {
            return refuse('--ask goes only with --status waiting');
        }
        if (!hasStarted(task)) {
            return refuse(`${task.id} has not started, so it does not wait: ask with teamrig add --owner ${ask.owner} --title "${ask.title}", then plan ${task.id} after that task (teamrig update ${task.id} --after <its id>)`);
        }
        const duplicate = activeDuplicate(ask.title, state);
        if (duplicate !== undefined) {
            return refuse(`${duplicate.id} already tracks this (${duplicate.status}, owner ${duplicate.owner}): wait on it with --waits task:${duplicate.id}`);
        }
        const asked = {
            title: ask.title,
            description: `Asked by ${caller} for ${task.id} (${task.title}), which waits on this task.`,
            owner: ask.owner,
            source: caller,
            priority: task.priority,
            goals: task.goals,
            noGoal: task.noGoal,
            ...(ask.due === undefined ? {} : { due: ask.due }),
        };
        // The asked task carries the goals of the task that waits on it, held to the goal records when they were named.
        return this.create(asked, state, (source) => this.teamSourceProblem(source), NO_TASKS_ELSEWHERE, new Set(task.goals));
    }
    setStatus(task, caller, input, context) {
        if (caller !== task.owner) {
            return refuse(ownerOnly(task));
        }
        if (input.oneCommit === true && input.status !== 'in-progress') {
            return refuse('--one-commit goes only with --status in-progress');
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
        // Ranked work goes first and work in progress stays few (T2076); `warn` lets the start through and the CLI warns.
        const { focus } = this.config;
        const wip = wipHold({ ...input, task }, context.state.tasks.values(), waitContext(context.state.tasks, context.now, context.zone, context.elsewhere), focus, register.ownerSource);
        if (wip !== undefined && focus.wip.mode === 'refuse') {
            return refuse(wip);
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
            return refuse(`${task.id}'s proof was put off to other waits ${task.reparks} times [register.maxReparks]: run the proof now and set it done, close it done with ${WATCH_USAGE} if tests or a dry run proved it, or reopen it (teamrig set ${task.id} --status in-progress)`);
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
            return refuse(`verifying needs --waits saying when its proof runs: ${PROOF_WAITS_USAGE}; if tests or a dry run proved it and its proof is a sighting, close it done with ${WATCH_USAGE} instead`);
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
        }
        else if (skill !== null) {
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
        const texts = [
            ['note', note],
            ['evidence', evidence],
            ['proof', proof.value],
            ['watch', watch.value],
            ['met', met],
            ...(card.value === null ? [] : cardTexts(card.value).map((text) => ['card', text])),
            ...(review.value === null ? [] : reviewTexts(review.value).map(([flag, text]) => [flag.slice(2), text])),
        ];
        const problem = texts.map(([name, text]) => this.checkText(name, text)).find((found) => found !== undefined);
        const change = {
            status: input.status,
            note,
            evidence,
            skill,
            ...(waits.value.length > 0 ? { waits: waits.value } : {}),
            ...(card.value === null ? {} : { card: card.value }),
            ...(proof.value === null ? {} : { proof: proof.value }),
            ...(watch.value === null ? {} : { watch: watch.value }),
            ...(met === null ? {} : { met }),
            ...(input.oneCommit === true ? { oneCommit: true } : {}),
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
    checkReview(task, input, context) {
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
    checkFollowups(task, input, context) {
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
    checkWaits(task, input, context) {
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
     * cards are required, the owner is asked to decide only with it (gatedCard). `--run` hands the owner a hand step
     * file only while an audit pins it (runProblem), and a card keeps it only while it asks the owner (T2312).
     */
    cardChange(task, input, waits) {
        const asks = waits.filter((reason) => reason.kind === 'decision' || reason.kind === 'approval');
        const { ownerSource, requireDecisionCard } = this.config.register;
        const owners = asks.filter((reason) => reason.who === ownerSource);
        const runProblem = input.run === undefined ? undefined : this.runProblem(task, input.run, owners.length > 0);
        if (runProblem !== undefined) {
            return refuse(runProblem);
        }
        const given = input.run === undefined ? input.card : { ...input.card, run: input.run.path };
        if (asks.length === 0) {
            return given === undefined ? ok(null) : refuse(`${CARD_FLAGS} go only with --status ${WAIT_STATUSES.join(' or ')} on a decision or an approval`);
        }
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
        const before = kept === null ? null : keptCard(kept, { whyAsk: ordered, gate: decidesOwner, run: owners.length > 0 });
        if (given === undefined) {
            if (before !== null || owners.length === 0 || !requireDecisionCard || ordered) {
                return this.ownerAsk(task, owners, before);
            }
            const kinds = owners.map((reason) => reason.kind).join(' and ');
            return refuse(`a wait on ${ownerSource}'s ${kinds} needs a card, so ${ownerSource} decides from it alone: ${CARD_USAGE}${decidesOwner ? ` ${gateUsage(this.config.ownerGates)}` : ''}`);
        }
        const parts = { ...before, ...given, ...(gate === undefined ? {} : { gate }) };
        if (parts.question === undefined || parts.recommend === undefined || parts.byDefault === undefined) {
            return refuse(`a card needs ${CARD_FLAGS} (--options for a decision): ${CARD_USAGE}`);
        }
        const card = {
            question: parts.question,
            options: parts.options ?? [],
            recommend: parts.recommend,
            byDefault: parts.byDefault,
            ...(parts.whyAsk === undefined ? {} : { whyAsk: parts.whyAsk }),
            ...(parts.gate === undefined ? {} : { gate: parts.gate }),
            ...(parts.run === undefined ? {} : { run: parts.run }),
        };
        const problem = cardProblem(card, asks.some((reason) => reason.kind === 'decision'));
        return problem === undefined ? this.ownerAsk(task, owners, card) : refuse(problem);
    }
    /**
     * Why a card may not hand the owner the hand step file `run` names (T2312, core rule 11): it goes only with a wait
     * on the owner's decision or approval (`asksOwner`), never a leader's approval, as the owner is who runs it; only as
     * a file of a kind with a run line; and only while an audit on the task pins that file at the sha256 the CLI read now.
     */
    runProblem(task, run, asksOwner) {
        const { ownerSource } = this.config.register;
        if (!asksOwner) {
            return `${RUN_FLAG} hands ${ownerSource} a hand step to run: it goes only with a wait on ${ownerSource}'s decision or approval`;
        }
        const kindProblem = handStepFileProblem(run.path);
        if (kindProblem !== undefined) {
            return kindProblem;
        }
        const audit = auditOf(task.audits, run.path);
        if (audit === undefined) {
            return `no audit on ${task.id} pins ${run.path}: a hand step goes to ${ownerSource} only as a file its auditor read (core rule 11); who audits it: ${this.auditorsText(task.owner)}, with teamrig audit ${task.id} --file ${run.path}`;
        }
        if (audit.sha256 !== run.sha256) {
            return `${run.path} changed since ${audit.by} audited it at sha256 ${shortSha256(audit.sha256)} (now ${shortSha256(run.sha256)}): an edit needs a new audit (core rule 11)`;
        }
        return undefined;
    }
    /**
     * What a card asking the owner (`owners`) must say besides its parts, and must not: why, on an owner's order; its
     * gate, on a decision; and no hand step in its text (typedStepProblem).
     */
    ownerAsk(task, owners, card) {
        const typed = owners.length === 0 || card === null ? undefined : this.typedStepProblem(task, card);
        if (typed !== undefined) {
            return refuse(typed);
        }
        const ordered = this.ownerOrderCard(task, owners, card);
        return ordered.ok ? this.gatedCard(task, owners, card) : ordered;
    }
    /**
     * Why a card asking the owner may not say what it says (T2312, core rule 11): a hand step goes to the human only as
     * a file its auditor read, so a card that types one into a part, as code or an ask to paste, is refused unless it
     * hands the step as its run file. A card kept from an older row is held to it too, as it still reaches the owner.
     */
    typedStepProblem(task, card) {
        const typed = typedHandStep(card);
        if (typed === undefined) {
            return undefined;
        }
        const { ownerSource } = this.config.register;
        return (`${typed.flag} hands ${ownerSource} a step as text (${typed.shape}): core rule 11 hands ${ownerSource} a step only as a file its auditor read. ` +
            `Write the step to a ${HAND_STEP_KINDS.join(', ')} file, have it audited (${this.auditorsText(task.owner)}, with teamrig audit ${task.id} --file <path>) and give ${RUN_FLAG} <path>; ` +
            `a card that hands no step says so without code or an ask to paste ("the line is in")`);
    }
    /**
     * Only an owner gate [ownerGates] or a business decision is the owner's to decide (T1194), so while
     * `register.requireDecisionCard` is on, a wait on the owner's decision needs a card naming its gate; any other
     * question is the session's or its leader's, however many good answers it has. check flags rows written before
     * (UNGATED).
     */
    gatedCard(task, owners, card) {
        const { ownerSource, requireDecisionCard } = this.config.register;
        if (!requireDecisionCard || card?.gate !== undefined || !owners.some((reason) => reason.kind === 'decision')) {
            return ok(card);
        }
        const leader = this.tree.leaderOf(task.owner) ?? (task.owner === this.tree.lead ? this.tree.above : undefined);
        const elsewhere = leader === undefined ? 'decide it' : `decide it, or wait on your leader (--waits decision:${leader})`;
        return refuse(`only an owner gate or a business decision is ${ownerSource}'s to decide: give ${gateUsage(this.config.ownerGates)}${card === null ? ` with ${CARD_USAGE}` : ''}; any other question is yours however many good answers it has: ${elsewhere}`);
    }
    /**
     * An owner's order approves its own work and proof (rule 6), so while `register.requireDecisionCard` is on, a task
     * the owner ordered waits on the owner (`owners`) only with a card that says why (`whyAsk`, T802); check flags rows
     * written before or with the switch off (OWNER-ORDERED).
     */
    ownerOrderCard(task, owners, card) {
        const { ownerSource, requireDecisionCard } = this.config.register;
        if (task.source !== ownerSource || owners.length === 0 || !requireDecisionCard || card?.whyAsk !== undefined) {
            return ok(card);
        }
        const kinds = owners.map((reason) => reason.kind).join(' and ');
        return refuse(`${ownerSource} ordered ${task.id}, and an order approves its own work and proof: drop the wait on ${ownerSource}'s ${kinds}, or give ${whyAskUsage(ownerSource)}${card === null ? ` with ${CARD_USAGE}` : ''}`);
    }
    waitProblem(task, status, reason, context) {
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
    personWaitProblem(task, reason) {
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
    approve(task, caller, verdict, note) {
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
    defer(task, caller, until, note, context) {
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
    deferFrom(task, until, note, context) {
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
        const waits = until === null ? untimed : [...untimed, { kind: 'time', at: until }];
        return ok({ changes: {}, note: text, waits });
    }
    /**
     * A Decided (T1366): the owner answered a card, a task's wait on the owner's decision or approval, at the meeting or
     * in a decision batch. Its owner or a leader above it records the answer, as {@link decideFrom} judges it.
     */
    decide(task, caller, note) {
        if (caller !== task.owner && caller !== this.tree.lead && !this.tree.leads(caller, task.owner)) {
            return refuse(`only the owner (${task.owner}) or ${this.approversText(task.owner)} records a decision on ${task.id}`);
        }
        return this.decideFrom(task, note);
    }
    /**
     * A Decided's content, for the lead above who asks the owner this team's decisions too (Register.decideFrom, whose
     * caller the tree decides): only a task waiting on the owner is decided, always with a note saying what the owner
     * decided. The owner's decision and approval waits go; a waiting task's time waits go with them, as a time beside
     * the owner's wait is a Later (deferFrom), while a verifying task keeps its time and task waits, which say when its
     * proof runs. The task stays in its status, marked decided (fold.ts), for its session to act on.
     */
    decideFrom(task, note) {
        const { ownerSource } = this.config.register;
        if (!waitsOnOwner(task, ownerSource)) {
            return refuse(`${task.id} waits on no decision or approval of ${ownerSource}: only such a card is decided`);
        }
        const text = blankToNull(note);
        if (text === null) {
            return refuse(`a Decided needs --note: what ${ownerSource} decided`);
        }
        const problem = this.checkText('note', text);
        if (problem !== undefined) {
            return refuse(problem);
        }
        const waits = task.waits.filter((reason) => {
            if (reason.kind === 'decision' || reason.kind === 'approval') {
                return reason.who !== ownerSource;
            }
            return task.status !== 'waiting' || reason.kind !== 'time';
        });
        return ok({ changes: {}, note: text, waits, decided: true });
    }
    /**
     * Who audits a hand step of the owner's (T2312, core rule 11), never the owner itself: the team's security reviewer
     * (roles.securityReviewer, a `<team>/<id>` when it sits on a team above), or the reviewer's leaders on the reviewer's
     * own task. Undefined when the team has no reviewer, or the reviewer owns the task and has no leader but itself (the
     * root lead): then any session of this team but the owner audits it.
     */
    auditorsOf(owner) {
        const reviewer = this.config.roles.securityReviewer;
        if (reviewer === undefined) {
            return undefined;
        }
        if (reviewer !== owner) {
            return [reviewer];
        }
        const leaders = this.tree.approversOf(owner).filter((id) => id !== owner);
        return leaders.length === 0 ? undefined : leaders;
    }
    /** The auditors of a hand step of the owner's in words, for the refusals that name them. */
    auditorsText(owner) {
        const reviewer = this.config.roles.securityReviewer;
        if (reviewer === undefined) {
            return 'any session of this team but its owner (no roles.securityReviewer is set)';
        }
        if (reviewer !== owner) {
            return ADDRESS_PATTERN.test(reviewer) ? `the security reviewer (${reviewer}), from its own team with --team` : `the security reviewer (${reviewer})`;
        }
        return this.auditorsOf(owner) === undefined ? `any session of this team but ${owner}` : `${this.approversText(owner)}, as ${owner} is the security reviewer`;
    }
    /**
     * An audit (T2312, core rule 11): `caller`, a session of this team, read the hand step file `pin` names and pins it
     * for the task at its sha256, so the task's card may hand it to the owner. Only an auditor of the owner's may
     * (auditorsOf), never the task's own owner, as {@link auditFrom} judges the rest.
     */
    audit(task, caller, pin, note) {
        if (caller === task.owner) {
            return refuse(`${caller} owns ${task.id}, so it does not audit its own hand step (core rule 11); who audits it: ${this.auditorsText(task.owner)}`);
        }
        const auditors = this.auditorsOf(task.owner);
        if (auditors !== undefined && !auditors.includes(caller)) {
            return this.notAuditor(task, caller);
        }
        return this.auditContent(task, pin, note);
    }
    notAuditor(task, caller) {
        return refuse(`${caller} does not audit a hand step of ${task.owner}'s; who audits it: ${this.auditorsText(task.owner)}`);
    }
    /**
     * An audit from a team above (T2312), `asker` being its `<team>/<id>`, as the tree decides: only an auditor of the
     * owner's that this team's roles name there may. A team with no security reviewer audits its hand steps itself.
     */
    auditFrom(task, asker, pin, note) {
        const auditors = this.auditorsOf(task.owner);
        if (auditors === undefined || !auditors.includes(asker)) {
            return this.notAuditor(task, asker);
        }
        return this.auditContent(task, pin, note);
    }
    /** An audit's content: a task still to finish, a hand step file of a kind with a run line, and an optional note. */
    auditContent(task, pin, note) {
        if (!ACTIVE_STATUSES.includes(task.status)) {
            return refuse(`${task.id} is ${task.status}: a hand step is audited for a task still to finish`);
        }
        const kindProblem = handStepFileProblem(pin.path);
        if (kindProblem !== undefined) {
            return refuse(kindProblem);
        }
        const text = blankToNull(note);
        const problem = this.checkText('note', text);
        return problem === undefined ? ok({ changes: {}, note: text, audit: pin }) : refuse(problem);
    }
    /**
     * The owner's Note from the pane (T1298): free text for the task's session, kept in its history as the owner's and
     * changing no field. A finished task takes none, as its session has moved on.
     */
    ownerNote(task, note) {
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
    ownerNext(task) {
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
    /**
     * `elsewhere`: the tasks the team tree's other registers hold, which `--after` may name. `goalTags`: as on `add`,
     * which only the goals the update names are held to, so a tag the task had before never blocks another change.
     */
    update(task, caller, asked, note, state, elsewhere = NO_TASKS_ELSEWHERE, goalTags = NO_GOAL_TAGS) {
        const changes = clearNoGoal(task, clearCritical(task, trimDescription(asked)));
        const names = Object.keys(changes).filter((name) => name in changes);
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
            const problem = this.leaderUpdateProblem(task, caller, names, changes);
            if (problem !== undefined) {
                return refuse(problem);
            }
        }
        return this.fieldChange(task, changes, text, state, elsewhere, goalTags);
    }
    /** The field rules every update passes, once who may make it is settled. */
    fieldChange(task, changes, text, state, elsewhere, goalTags) {
        if (changes.description === null && this.config.register.requireDescription) {
            return refuse(`${task.id} keeps a description while register.requireDescription is on: give a new one instead of none`);
        }
        const merged = { ...pickFields(task), ...changes };
        // A task keeps the source it was added with, even one from the parent team's lead.
        const sourceRule = (source) => (source === task.source ? undefined : this.teamSourceProblem(source));
        const after = changes.after === undefined ? undefined : afterChangeProblem(task, changes.after, state, elsewhere);
        const goals = changes.goals === undefined ? undefined : this.goalProblem(changes.goals, goalTags);
        const problem = after ?? this.checkFields(merged, sourceRule, task) ?? goals ?? this.checkText('note', text);
        return problem === undefined ? ok({ changes, note: text }) : refuse(problem);
    }
    /**
     * A confirmed sweep row (T2086): the task's class, goals and size, from its owner or a leader over it. `goals` is the
     * one field here a leader's `update` may not touch: a person read this row and said yes, and the sweep is how a
     * team's leader sorts tasks their owners never tagged, so it is widened here and not in LEAD_FIELDS.
     */
    triage(task, caller, asked, state, elsewhere = NO_TASKS_ELSEWHERE, goalTags = NO_GOAL_TAGS) {
        if (caller !== task.owner && caller !== this.tree.lead && !this.tree.leads(caller, task.owner)) {
            return refuse(`only the owner (${task.owner}) or ${this.approversText(task.owner)} changes ${task.id}`);
        }
        return this.triageFrom(task, asked, state, elsewhere, goalTags);
    }
    /** `triage` for the lead of a team above, whom the tree vetted and no roster here holds, so only the field rules judge it. */
    triageFrom(task, asked, state, elsewhere = NO_TASKS_ELSEWHERE, goalTags = NO_GOAL_TAGS) {
        // A row adds to the task's tags and keeps the rest, which a person did not name and which may predate the records.
        return this.fieldChange(task, clearNoGoal(task, asked), null, state, elsewhere, new Set([...goalTags, ...task.goals]));
    }
    /** Why `goals` cannot be named under `register.goals` checked or required: one is no tag of `goalTags`. */
    goalProblem(goals, goalTags) {
        if (this.config.register.goals === 'free') {
            return undefined;
        }
        const unknown = goals.find((goal) => !goalTags.has(goal));
        return unknown === undefined ? undefined : `goal ${unknown} is not a goal record of the team or a team above: teamrig goal list lists them`;
    }
    /** Why a new task must name its goal under `register.goals` required: it is owner-asked or p0/p1 and names none. */
    unnamedGoalProblem(fields) {
        const { goals, ownerSource } = this.config.register;
        if (goals !== 'required' || fields.goals.length > 0 || fields.noGoal) {
            return undefined;
        }
        const asked = fields.source === ownerSource ? 'an owner-asked' : isTopPriority(fields.priority) ? `a ${priorityText(fields.priority)}` : undefined;
        return asked === undefined ? undefined : `${asked} task names its goal: --goals <tag>, or --goals none (register.goals is required)`;
    }
    /**
     * Why `caller` may not set the pin of task `id` (`pin`: the session that pins, null to unpin), or undefined when it
     * may: a pin puts the task above its `owner`'s computed order (the owner it has after the change), so the owner's
     * leaders set it, the lead on its own tasks too, and never the owner itself; a pin names the session that set it (T637).
     */
    pinProblem(id, owner, caller, pin) {
        if (caller === owner && caller !== this.tree.lead) {
            return `${owner} does not pin its own ${id}: ${this.approversText(owner)} pins a task above its owner's order`;
        }
        return pin === null || pin === caller ? undefined : `a pin names the session that sets it (${caller}), not ${pin}`;
    }
    /**
     * Why a session may not change the work order of a task it does not own, or undefined when it may (T782): the lead
     * on any task, a sub-lead on the tasks of its group; only the LEAD_FIELDS (the lead the LEFT_OWNER_LEAD_FIELDS on a
     * task whose owner left the team, or when it points a task holding no issue ref at an issue: issue migrate opens an
     * issue for each task of the team and links it, replacing a note ref, while a task's issue stays its issue), and a
     * sub-lead hands a task only
     * to itself or a session it leads, so work never leaves its group by a sub-lead's hand.
     */
    leaderUpdateProblem(task, caller, names, changes) {
        const isLead = caller === this.tree.lead;
        if (!isLead && !this.tree.leads(caller, task.owner)) {
            return `only the owner (${task.owner}) or ${this.approversText(task.owner)} changes ${task.id}`;
        }
        const linksIssue = task.ref?.startsWith(ISSUE_REF_PREFIX) !== true && changes.ref !== undefined && changes.ref !== null && changes.ref.startsWith(ISSUE_REF_PREFIX);
        const allowed = isLead && (linksIssue || !this.config.sessions.includes(task.owner)) ? LEFT_OWNER_LEAD_FIELDS : LEAD_FIELDS;
        const notLead = names.filter((name) => !allowed.includes(name));
        if (notLead.length > 0) {
            return `a leader may change only ${allowed.join(', ')} on a task it does not own (asked: ${notLead.join(', ')})`;
        }
        const group = this.tree.groupOf(caller);
        const { owner } = changes;
        if (!isLead && owner !== undefined && owner !== caller && !group.includes(owner)) {
            return `${caller} hands ${task.id} only to itself or a session it leads (${group.join(', ')}); the lead (${this.tree.lead}) moves work between groups`;
        }
        return undefined;
    }
    /**
     * A task for a GitHub issue. The import keys its tasks on their ref, so a second one for the same issue is
     * refused, and so is one for an issue a team task already links to in its ref (an issue the team opened for
     * its own task, issue migrate): that task tracks it. Two issues may share a title, so the duplicate-title rule
     * does not apply.
     */
    importAdd(input, state) {
        const fields = { ...input, source: GITHUB_SOURCE, due: null, goals: [], noGoal: false, week: null, after: [], size: null, type: null, critical: false, pin: null, workClass: null };
        const holder = [...state.tasks.values()].find((task) => task.ref === input.ref);
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
    importUpdate(task, changes, note) {
        const notImported = this.notImported(task);
        if (notImported !== undefined) {
            return refuse(notImported);
        }
        const changed = {
            ...(changes.title !== undefined && changes.title !== task.title ? { title: changes.title } : {}),
            ...(changes.description !== undefined && changes.description !== task.description ? { description: changes.description } : {}),
            ...(changes.priority !== undefined && changes.priority !== task.priority ? { priority: changes.priority } : {}),
        };
        if (Object.keys(changed).length === 0) {
            return refuse('nothing to change');
        }
        const problem = this.checkFields({ ...pickFields(task), ...changed }, importSource, { workClass: task.workClass }) ?? this.checkText('note', note);
        return problem === undefined ? ok({ changes: changed, note }) : refuse(problem);
    }
    /**
     * The one exception to "only the owner sets the status": the import opens, finishes or drops its own
     * tasks as their issues open and close on GitHub. Any other task, and any other status, is refused.
     * No skill comes from GitHub, so a done needs none; its evidence is the issue's url.
     */
    importStatus(task, input) {
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
    notImported(task) {
        return task.source === GITHUB_SOURCE ? undefined : `${task.id} is not a GitHub task (source ${task.source}): the import changes only its own`;
    }
    /** A source added on this team: a session id, or the owner's marker; never the import's. */
    teamSourceProblem(source) {
        const { ownerSource } = this.config.register;
        if (source === GITHUB_SOURCE) {
            return `source ${GITHUB_SOURCE} is kept for the tasks teamrig issue sync imports`;
        }
        return source === ownerSource || SESSION_NAME.test(source) ? undefined : `source ${source} is neither a session id nor ${ownerSource}`;
    }
    /**
     * `kept`: the owner and work class an update leaves as they were. An owner stands even once it is no session of the
     * team any more (a retired hire, a session that left at a split), as a task keeps its source, and a class even once
     * the team renamed it out of `focus.classes`; only a value a write sets is held to the roster or the classes (T1830,
     * T2076).
     */
    checkFields(fields, sourceRule, kept = {}) {
        const { register, sessions, focus } = this.config;
        if (fields.title === '') {
            return 'the title is empty';
        }
        if (fields.title.length > register.maxTitle) {
            return `the title has ${fields.title.length} characters; the limit is ${register.maxTitle}`;
        }
        if (fields.owner !== kept.owner && !sessions.includes(fields.owner)) {
            return `owner ${fields.owner} is not a session on this team`;
        }
        if (fields.workClass !== null && fields.workClass !== kept.workClass && !focus.classes.includes(fields.workClass)) {
            return `class ${fields.workClass} is not one of focus.classes (${focus.classes.join(', ')})`;
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
    checkText(name, text) {
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
const OWN_LIMITS = ['title', 'description'];
function pickFields(task) {
    const { title, description, owner, source, ref, priority, due, goals, noGoal, week, after, size, type, critical, pin, workClass } = task;
    return { title, description, owner, source, ref, priority, due, goals, noGoal, week, after, size, type, critical, pin, workClass };
}
/** An update naming goals for a task said to serve none also clears that mark, which a task with goals cannot hold. */
function clearNoGoal(task, changes) {
    return changes.goals !== undefined && changes.goals.length > 0 && changes.noGoal === undefined && task.noGoal ? { ...changes, noGoal: false } : changes;
}
/** The types an item can be critical in, those that give the review: `bug`, or `bug|incident`. */
function reviewedTypes() {
    return ITEM_TYPES.filter((type) => ITEM_TYPE_TRAITS[type].review).join('|');
}
/** An update moving a critical item to a type without a review also clears its critical mark, which that type cannot hold. */
function clearCritical(task, changes) {
    return changes.type !== undefined && changes.critical === undefined && task.critical && !traitsOf({ type: changes.type }).review ? { ...changes, critical: false } : changes;
}
/** An update's description trimmed at both ends, its newlines kept; a blank one clears it, as `none` does. */
function trimDescription(changes) {
    return changes.description === undefined ? changes : { ...changes, description: blankToNull(changes.description ?? undefined) };
}
/**
 * The proof a status change writes: none outside `verifying`, where `--proof` is refused; the one given; or,
 * when a verifying task is set verifying again without one, the proof it already had.
 */
function proofChange(task, input) {
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
function watchChange(input) {
    const watch = blankToNull(input.watch);
    return watch === null || input.status === 'done' ? ok(watch) : refuse('--watch goes only with --status done');
}
/** The verify-by date a status change moves the task's due date to: only with `verifying`, and null when it stays. */
function dueChange(task, input) {
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
function taskWaitProblem(task, id, state, elsewhere) {
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
function runsProof(reason) {
    return reason.kind === 'time' || reason.kind === 'task';
}
/**
 * A proof runs when the task it waits on ends, so it waits only on one in progress or verifying (T1306): one not
 * started has no end in sight, and the task stays waiting on it until it starts.
 */
function unstartedProofTask(task, id, context) {
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
function clearedProofWait(task, kept, context) {
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
function treeTasks(state, elsewhere) {
    if (elsewhere.size === 0) {
        return state.tasks;
    }
    return new Map([...[...elsewhere].map(([id, held]) => [id, held.task]), ...state.tasks]);
}
/**
 * In progress, verifying (its work shipped, whatever an older register's row says of its start) or waiting after it
 * started: a task that can wait on another.
 */
function hasStarted(task) {
    return task.status === 'in-progress' || task.status === 'verifying' || (task.status === 'waiting' && task.startedAt !== null);
}
/** Open, or waiting without ever starting (on an approval, or a row an older register migrated): a task a plan fits. */
function notStarted(task) {
    return task.status === 'open' || (task.status === 'waiting' && task.startedAt === null);
}
function ownerOnly(task) {
    return `only the owner (${task.owner}) sets the status of ${task.id}`;
}
/** The active task with this title, compared as {@link normaliseTitle} does: a new one would track the same work twice. */
function activeDuplicate(title, state) {
    return [...state.tasks.values()].find((task) => ACTIVE_STATUSES.includes(task.status) && normaliseTitle(task.title) === normaliseTitle(title));
}
/**
 * A plan dependency is for a task not started yet, as {@link taskWaitProblem} sends it here: a started one waits on
 * a task instead, and a finished one needs neither. Clearing it is always fine.
 */
function afterChangeProblem(task, after, state, elsewhere) {
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
function afterProblem(id, after, state, elsewhere) {
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
function loopProblem(id, other, tasks, byWait) {
    const path = needPath(tasks, other, id);
    const owner = tasks.get(other)?.owner;
    if (path === undefined || owner === undefined) {
        return undefined;
    }
    return `${pathText([id, ...path])} would be a loop, and no task in a loop can finish: ${loopFix(id, other, owner, byWait)}`;
}
/** Why a time to wait until (stored form) is refused, or undefined: it must be still to come. */
function timeProblem(at, { now, zone }) {
    return (parseDeadline(at, zone)?.getTime() ?? 0) > now.getTime() ? undefined : `time ${showStored(at, zone)} has passed: name a time to come`;
}
function blankToNull(text) {
    return text === undefined || text.trim() === '' ? null : text.trim();
}
/** Titles compare case- and space-insensitively when looking for duplicates. */
export function normaliseTitle(title) {
    return title.toLowerCase().replace(/\s+/g, ' ').trim();
}
