import { ADDRESS_PATTERN } from "../core/address.js";
import { SecretScanner } from "../core/secrets.js";
import { parseUtcDay, parseUtcDeadline } from "../core/time.js";
import { ACTIVE_STATUSES, priorityText, SESSION_NAME } from "./model.js";
/** The skill name that closes a task which produced no reusable procedure. */
export const NO_SKILL = 'none';
/** Fields the lead may change on a task someone else owns. */
export const LEAD_FIELDS = ['owner', 'priority', 'due', 'week'];
function ok(value) {
    return { ok: true, value };
}
function refuse(error) {
    return { ok: false, error };
}
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
        };
        const problem = this.checkFields(fields, sourceRule);
        if (problem !== undefined) {
            return refuse(problem);
        }
        const duplicate = [...state.tasks.values()].find((task) => ACTIVE_STATUSES.includes(task.status) && normaliseTitle(task.title) === normaliseTitle(fields.title));
        return duplicate === undefined ? ok(fields) : refuse(`${duplicate.id} already tracks this (${duplicate.status}, owner ${duplicate.owner})`);
    }
    setStatus(task, caller, input, skillExists) {
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
            return refuse(input.status === 'verifying' ? 'verifying needs --note saying what proves it' : `${input.status} needs --note`);
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
        }
        else if (skill !== null) {
            return refuse('--skill goes only with done');
        }
        const problem = this.checkText('note', note) ?? this.checkText('evidence', evidence);
        return problem === undefined ? ok({ status: input.status, note, evidence, skill }) : refuse(problem);
    }
    update(task, caller, changes, note) {
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
        const problem = this.checkFields(merged, sourceRule) ?? this.checkText('note', blankToNull(note));
        return problem === undefined ? ok({ changes, note: blankToNull(note) }) : refuse(problem);
    }
    /** A source added on this team: a session id, or the owner's marker. */
    teamSourceProblem(source) {
        const { ownerSource } = this.config.register;
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
    const { title, owner, source, ref, priority, due, goals, week } = task;
    return { title, owner, source, ref, priority, due, goals, week };
}
function blankToNull(text) {
    return text === undefined || text.trim() === '' ? null : text.trim();
}
/** Titles compare case- and space-insensitively when looking for duplicates. */
export function normaliseTitle(title) {
    return title.toLowerCase().replace(/\s+/g, ' ').trim();
}
