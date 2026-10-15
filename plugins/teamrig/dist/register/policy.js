import { ADDRESS_PATTERN } from "../core/address.js";
import { SecretScanner } from "../core/secrets.js";
import { parseUtcDay, parseUtcDeadline } from "../core/time.js";
import { taskNumber } from "./fold.js";
import { ACTIVE_STATUSES, priorityText, SESSION_NAME } from "./model.js";
import { heldStart, startHolds } from "./verify.js";
import { sameWait, waitSpelling } from "./waits.js";
/** The skill name that closes a task which produced no reusable procedure. */
export const NO_SKILL = 'none';
/**
 * The source of a task imported from a GitHub issue: only `teamrig gh sync` writes one (github/sync.ts),
 * and a session cannot give it to a task. The import writes its events as GITHUB_ACTOR.
 */
export const GITHUB_SOURCE = 'github';
export const GITHUB_ACTOR = 'github';
/** The statuses the import sets on its own tasks: an issue's open state, or how it was closed. */
export const GITHUB_STATUSES = ['open', 'done', 'dropped'];
/** Fields the lead may change on a task someone else owns. */
export const LEAD_FIELDS = ['owner', 'priority', 'due', 'week'];
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
            owner: input.owner,
            source: input.source,
            ref: input.ref ?? null,
            priority: input.priority,
            due: input.due ?? null,
            goals: input.goals ?? [],
            week: input.week ?? null,
            after: input.after ?? [],
        };
        const problem = this.checkFields(fields, sourceRule) ?? afterProblem(state.nextId, fields.after, state);
        if (problem !== undefined) {
            return refuse(problem);
        }
        const duplicate = [...state.tasks.values()].find((task) => ACTIVE_STATUSES.includes(task.status) && normaliseTitle(task.title) === normaliseTitle(fields.title));
        return duplicate === undefined ? ok(fields) : refuse(`${duplicate.id} already tracks this (${duplicate.status}, owner ${duplicate.owner})`);
    }
    setStatus(task, caller, input, context) {
        if (caller !== task.owner) {
            return refuse(`only the owner (${task.owner}) sets the status of ${task.id}`);
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
        }
        else if (skill !== null) {
            return refuse('--skill goes only with done');
        }
        const problem = this.checkText('note', note) ?? this.checkText('evidence', evidence) ?? this.checkText('proof', proof.value);
        const change = {
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
    waitProblem(task, reason, context) {
        switch (reason.kind) {
            case 'decision':
            case 'approval': {
                const { ownerSource } = this.config.register;
                return reason.who === ownerSource || this.config.sessions.includes(reason.who)
                    ? undefined
                    : `${reason.kind} ${reason.who}: ${reason.who} is neither a session on this team nor ${ownerSource}`;
            }
            case 'task':
                return taskWaitProblem(task, reason.id, context.state);
            case 'time':
                return (parseUtcDeadline(reason.at)?.getTime() ?? 0) > context.now.getTime() ? undefined : `time ${reason.at} has passed: name a time to come`;
        }
    }
    update(task, caller, changes, note, state) {
        const names = Object.keys(changes).filter((name) => name in changes);
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
        const merged = { ...pickFields(task), ...changes };
        // A task keeps the source it was added with, even one from the parent team's lead.
        const sourceRule = (source) => (source === task.source ? undefined : this.teamSourceProblem(source));
        const after = changes.after === undefined ? undefined : afterChangeProblem(task, changes.after, state);
        const problem = after ?? this.checkFields(merged, sourceRule) ?? this.checkText('note', blankToNull(note));
        return problem === undefined ? ok({ changes, note: blankToNull(note) }) : refuse(problem);
    }
    /**
     * A task for a GitHub issue. The import keys its tasks on their ref, so a second one for the same issue is
     * refused; a team task that cites the issue in its ref stays the team's. Two issues may share a title, so
     * the duplicate-title rule does not apply.
     */
    importAdd(input, state) {
        const fields = { ...input, source: GITHUB_SOURCE, due: null, goals: [], week: null, after: [] };
        const holder = [...state.tasks.values()].find((task) => task.source === GITHUB_SOURCE && task.ref === input.ref);
        if (holder !== undefined) {
            return refuse(`${holder.id} already has ref ${input.ref}`);
        }
        const problem = this.checkFields(fields, importSource);
        return problem === undefined ? ok(fields) : refuse(problem);
    }
    /**
     * A title or priority GitHub changed, on the import's own task only. A field the task already has is left
     * out, judged under the lock, so a sync that raced another changes nothing twice.
     */
    importUpdate(task, changes, note) {
        const notImported = this.notImported(task);
        if (notImported !== undefined) {
            return refuse(notImported);
        }
        const changed = {
            ...(changes.title !== undefined && changes.title !== task.title ? { title: changes.title } : {}),
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
        return this.checkText('title', fields.title) ?? this.checkText('ref', fields.ref);
    }
    checkText(name, text) {
        if (text === null) {
            return undefined;
        }
        if (name !== 'title' && text.length > this.config.register.maxText) {
            return `${name} has ${text.length} characters; the limit is ${this.config.register.maxText}`;
        }
        return this.secrets.refusal(name, text);
    }
}
function pickFields(task) {
    const { title, owner, source, ref, priority, due, goals, week, after } = task;
    return { title, owner, source, ref, priority, due, goals, week, after };
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
 * task must finish first: one not started stays open with a plan dependency instead.
 */
function taskWaitProblem(task, id, state) {
    if (id === task.id) {
        return `${task.id} cannot wait on itself`;
    }
    const started = task.status === 'in-progress' || (task.status === 'waiting' && task.startedAt !== null);
    if (!started) {
        return `${task.id} has not started, so it does not wait on ${id}: it stays open, planned after it (teamrig update ${task.id} --after ${id})`;
    }
    if (taskNumber(id) >= taskNumber(state.nextId)) {
        return `no task ${id}`;
    }
    const target = state.tasks.get(id);
    return target === undefined || target.status === 'done' || target.status === 'dropped' ? `${id} is already finished; nothing to wait on` : undefined;
}
/** A plan dependency is for a task not started yet: a started one waits on a task instead. Clearing it is always fine. */
function afterChangeProblem(task, after, state) {
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
    const loop = after.find((other) => leadsTo(other, id, state));
    return loop === undefined ? undefined : `${loop} already comes after ${id}, directly or not, so ${id} cannot come after ${loop}`;
}
/** True when `from` is `target` or comes after it, directly or through the tasks it comes after. */
function leadsTo(from, target, state) {
    const seen = new Set();
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
function blankToNull(text) {
    return text === undefined || text.trim() === '' ? null : text.trim();
}
/** Titles compare case- and space-insensitively when looking for duplicates. */
export function normaliseTitle(title) {
    return title.toLowerCase().replace(/\s+/g, ' ').trim();
}
