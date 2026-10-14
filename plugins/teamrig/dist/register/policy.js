import { SecretScanner } from "../core/secrets.js";
import { parseUtcDay, parseUtcDeadline } from "../core/time.js";
import { ACTIVE_STATUSES, SESSION_NAME } from "./model.js";
/** The skill name that closes a task which produced no reusable procedure. */
export const NO_SKILL = 'none';
/** Fields the lead may change on a task someone else owns. */
export const LEAD_FIELDS = ['owner', 'tier', 'due', 'week'];
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
        const fields = {
            title: input.title.trim(),
            owner: input.owner,
            source: input.source,
            ref: input.ref ?? null,
            tier: input.tier,
            due: input.due ?? null,
            goals: input.goals ?? [],
            week: input.week ?? null,
        };
        const problem = this.checkFields(fields);
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
        const problem = this.checkFields(merged) ?? this.checkText('note', blankToNull(note));
        return problem === undefined ? ok({ changes, note: blankToNull(note) }) : refuse(problem);
    }
    checkFields(fields) {
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
        if (fields.source !== register.ownerSource && !SESSION_NAME.test(fields.source)) {
            return `source ${fields.source} is neither a session id nor ${register.ownerSource}`;
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
    checkText(name, text) {
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
function pickFields(task) {
    const { title, owner, source, ref, tier, due, goals, week } = task;
    return { title, owner, source, ref, tier, due, goals, week };
}
function blankToNull(text) {
    return text === undefined || text.trim() === '' ? null : text.trim();
}
/** Titles compare case- and space-insensitively when looking for duplicates. */
export function normaliseTitle(title) {
    return title.toLowerCase().replace(/\s+/g, ' ').trim();
}
