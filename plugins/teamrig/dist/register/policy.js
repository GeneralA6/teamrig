import { MAX_DESCRIPTION } from "../config/defaults.js";
import { ADDRESS_PATTERN } from "../core/address.js";
import { SecretScanner } from "../core/secrets.js";
import { parseDeadline, parseUtcDay, parseUtcDeadline, showStored } from "../core/time.js";
import { CARD_FLAGS, cardProblem, cardTexts, OPTION_SEPARATOR, sameCard } from "./card.js";
import { sizeProblem } from "./events.js";
import { taskNumber } from "./fold.js";
import { ACTIVE_STATUSES, FOLLOWUP_STATUSES, GITHUB_SOURCE, priorityText, SESSION_NAME } from "./model.js";
import { loopFix, needPath, pathText } from "./tree.js";
import { heldStart, startHolds } from "./verify.js";
import { isPeerWait, sameWait, waitSpelling } from "./waits.js";
/** The skill name that closes a task which produced no reusable procedure. */
export const NO_SKILL = 'none';
/** Who the GitHub import's events are written by; its tasks carry GITHUB_SOURCE (model.ts). */
export const GITHUB_ACTOR = 'github';
/** The statuses the import sets on its own tasks: an issue's open state, or how it was closed. */
export const GITHUB_STATUSES = ['open', 'done', 'dropped'];
/** Fields the lead may change on a task someone else owns: who does it, how urgent, when, in what order and its size (the lead plans the week). */
export const LEAD_FIELDS = ['owner', 'priority', 'due', 'week', 'after', 'size'];
/** The refusal of an `add` with no description while `register.requireDescription` is on. */
export const DESCRIPTION_NEEDED = 'add needs --description "<what and why, in plain words>"';
/** How a card is typed, for the refusals that ask for one. */
export const CARD_USAGE = `--question "<what is decided>" --options "<one choice, its numbers> ${OPTION_SEPARATOR} <another>" --recommend "<which, and why>" --default "<what happens with no answer by the due date>"`;
/** How `--waits` is typed, for the refusals that ask for it. */
export const WAITS_USAGE = 'decision:<who>, approval:<who>, task:T<id> or time:<YYYY-MM-DD HH:MM>, comma-separated';
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
    constructor(config) {
        this.config = config;
        this.secrets = new SecretScanner(config.register.secretPatterns);
    }
    /** The caller must be on the roster before writing anything. */
    checkCaller(session) {
        return this.config.sessions.includes(session)
            ? undefined
            : `${session} is not a session on this team (sessions: ${this.config.sessions.join(', ')})`;
    }
    add(input, state) {
        return this.create(input, state, (source) => this.teamSourceProblem(source));
    }
    /**
     * A task the parent team's lead hands this team: its source is that lead's `<team>/<id>`, and it
     * goes to this team's lead, who plans it in.
     */
    addFromParent(input, state) {
        const { lead } = this.config.roles;
        if (input.owner !== lead) {
            return refuse(`a task from the parent team goes to this team's lead (${lead}), not ${input.owner}`);
        }
        return this.create(input, state, (source) => ADDRESS_PATTERN.test(source) ? undefined : `source ${source} is not the parent team lead's <team>/<id>`);
    }
    create(input, state, sourceRule) {
        const fields = {
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
     * started: one not started keeps its status, planned after the asked task. An active task of the same title is waited
     * on instead.
     */
    ask(task, caller, ask, input, state) {
        if (caller !== task.owner) {
            return refuse(ownerOnly(task));
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
            ...(ask.due === undefined ? {} : { due: ask.due }),
        };
        return this.create(asked, state, (source) => this.teamSourceProblem(source));
    }
    setStatus(task, caller, input, context) {
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
        }
        else if (skill !== null) {
            return refuse('--skill goes only with done');
        }
        const followups = this.checkFollowups(task, input, context);
        if (!followups.ok) {
            return followups;
        }
        const texts = [
            ['note', note],
            ['evidence', evidence],
            ['proof', proof.value],
            ['met', met],
            ...(card.value === null ? [] : cardTexts(card.value).map((text) => ['card', text])),
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
            if (!context.state.tasks.has(id)) {
                return refuse(`--followups names ${id}, which is not on the task list: add it first (teamrig add)`);
            }
        }
        return ok(followups);
    }
    /** The reasons of a status change: at least one for `waiting`, none for any other status, each one judged. */
    checkWaits(task, input, context) {
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
    /**
     * The card a status change writes (card.ts): none without a wait on a decision or an approval, where the card
     * flags are refused; the parts given over the card the task had while waiting, so one part can change alone; or,
     * with none given, that card. A wait on the owner's decision or approval needs a card while
     * `register.requireDecisionCard` is on, so the owner decides from it alone (T514).
     */
    cardChange(task, input, waits) {
        const asks = waits.filter((reason) => reason.kind === 'decision' || reason.kind === 'approval');
        const given = input.card;
        if (asks.length === 0) {
            return given === undefined ? ok(null) : refuse(`${CARD_FLAGS} go only with --status waiting on a decision or an approval`);
        }
        const before = task.status === 'waiting' ? task.card : null;
        if (given === undefined) {
            const { ownerSource, requireDecisionCard } = this.config.register;
            const owners = asks.filter((reason) => reason.who === ownerSource);
            if (before !== null || owners.length === 0 || !requireDecisionCard) {
                return ok(before);
            }
            const kinds = owners.map((reason) => reason.kind).join(' and ');
            return refuse(`a wait on ${ownerSource}'s ${kinds} needs a card, so ${ownerSource} decides from it alone: ${CARD_USAGE}`);
        }
        const parts = { ...before, ...given };
        if (parts.question === undefined || parts.recommend === undefined || parts.byDefault === undefined) {
            return refuse(`a card needs ${CARD_FLAGS} (--options for a decision): ${CARD_USAGE}`);
        }
        const card = { question: parts.question, options: parts.options ?? [], recommend: parts.recommend, byDefault: parts.byDefault };
        const problem = cardProblem(card, asks.some((reason) => reason.kind === 'decision'));
        return problem === undefined ? ok(card) : refuse(problem);
    }
    waitProblem(task, reason, context) {
        switch (reason.kind) {
            case 'decision':
            case 'approval':
                return this.personWaitProblem(task, reason);
            case 'task':
                return taskWaitProblem(task, reason.id, context.state);
            case 'time':
                return (parseDeadline(reason.at, context.zone)?.getTime() ?? 0) > context.now.getTime() ? undefined : `time ${showStored(reason.at, context.zone)} has passed: name a time to come`;
        }
    }
    /**
     * Decision and approval waits are for the lead and the owner: a peer's work is a task, waited on by its id, which
     * clears by itself once that task finishes, where a peer's decision would hold the task until its owner noticed.
     */
    personWaitProblem(task, reason) {
        const { ownerSource } = this.config.register;
        const { lead } = this.config.roles;
        if (!isPeerWait(reason, lead, ownerSource)) {
            return undefined;
        }
        return this.config.sessions.includes(reason.who)
            ? `${reason.kind} ${reason.who}: decision and approval waits are for the lead (${lead}) and ${ownerSource}; wait on ${reason.who}'s work by its task: teamrig set ${task.id} --status waiting --ask ${reason.who} --text "<the work you need>"`
            : `${reason.kind} ${reason.who}: ${reason.who} is neither the lead (${lead}) nor ${ownerSource}`;
    }
    update(task, caller, asked, note, state) {
        const changes = trimDescription(asked);
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
        const merged = { ...pickFields(task), ...changes };
        // A task keeps the source it was added with, even one from the parent team's lead.
        const sourceRule = (source) => (source === task.source ? undefined : this.teamSourceProblem(source));
        const after = changes.after === undefined ? undefined : afterChangeProblem(task, changes.after, state);
        const problem = after ?? this.checkFields(merged, sourceRule) ?? this.checkText('note', text);
        return problem === undefined ? ok({ changes, note: text }) : refuse(problem);
    }
    /**
     * A task for a GitHub issue. The import keys its tasks on their ref, so a second one for the same issue is
     * refused; a team task that cites the issue in its ref stays the team's. Two issues may share a title, so
     * the duplicate-title rule does not apply.
     */
    importAdd(input, state) {
        const fields = { ...input, source: GITHUB_SOURCE, due: null, goals: [], week: null, after: [], size: null };
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
        const problem = this.checkFields({ ...pickFields(task), ...changed }, importSource) ?? this.checkText('note', note);
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
            return `source ${GITHUB_SOURCE} is kept for the tasks teamrig gh sync imports`;
        }
        return source === ownerSource || SESSION_NAME.test(source) ? undefined : `source ${source} is neither a session id nor ${ownerSource}`;
    }
    checkFields(fields, sourceRule) {
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
    const { title, description, owner, source, ref, priority, due, goals, week, after, size } = task;
    return { title, description, owner, source, ref, priority, due, goals, week, after, size };
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
function sameWaits(a, b) {
    return a.length === b.length && a.every((reason) => b.some((other) => sameWait(reason, other)));
}
/**
 * A task reason is for a task already started (in progress, or waiting after it started) that found another
 * task must finish first: one not started stays open with a plan dependency instead. It never closes a loop.
 */
function taskWaitProblem(task, id, state) {
    if (id === task.id) {
        return `${task.id} cannot wait on itself`;
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
/** In progress, or waiting after it started: a task that can wait on another. */
function hasStarted(task) {
    return task.status === 'in-progress' || (task.status === 'waiting' && task.startedAt !== null);
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
function afterChangeProblem(task, after, state) {
    const first = after[0];
    if (first !== undefined && !notStarted(task)) {
        const instead = hasStarted(task) ? `; a started task waits on another with --status waiting --waits task:${first}` : '';
        return `--after plans a task not started yet, and ${task.id} is ${task.status}${instead}`;
    }
    return afterProblem(task.id, after, state);
}
/**
 * The tasks `id` comes after must exist, be named once, and never need `id` back, by a plan dependency or a task
 * wait: a loop could never start. On a create, `id` is the id the new task gets.
 */
function afterProblem(id, after, state) {
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
function loopProblem(id, other, state, byWait) {
    const path = needPath(state.tasks, other, id);
    const owner = state.tasks.get(other)?.owner;
    if (path === undefined || owner === undefined) {
        return undefined;
    }
    return `${pathText([id, ...path])} would be a loop, and no task in a loop can finish: ${loopFix(id, other, owner, byWait)}`;
}
function blankToNull(text) {
    return text === undefined || text.trim() === '' ? null : text.trim();
}
/** Titles compare case- and space-insensitively when looking for duplicates. */
export function normaliseTitle(title) {
    return title.toLowerCase().replace(/\s+/g, ' ').trim();
}
