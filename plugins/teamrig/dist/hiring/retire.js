import { leadsAfterRetire } from "../config/lead-edits.js";
import { LeadTree } from "../config/lead-tree.js";
import { isRecord } from "../core/guards.js";
/**
 * The plan behind `retire`: a session taken off the team config, its open tasks to an heir. Pure: it takes
 * the file's JSON, the config read from it, the hires still active and what the command found (the
 * session's open tasks, its handover), and returns the next JSON, the tasks to hand over and the record to
 * log, so the command can preview before it writes. The session's records, inbox and tasks stay where
 * they are, readable by its id.
 */
/** The reason a retire records when none is given. */
export const RETIRE_REASON = 'its job is done';
/** The record with the id's entry gone from its section at `key`, when that section has one. */
function withoutEntry(record, key, id) {
    const section = record[key];
    if (!isRecord(section) || !Object.hasOwn(section, id)) {
        return record;
    }
    return { ...record, [key]: Object.fromEntries(Object.entries(section).filter(([name]) => name !== id)) };
}
/** The file with the id's `budget.sessions` entry gone, when it has one. */
function withoutBudget(file, id) {
    const budget = file['budget'];
    return isRecord(budget) ? { ...file, budget: withoutEntry(budget, 'sessions', id) } : file;
}
/** The file with the session out of `leads` and its members given to its leader, dropping `leads` once empty (T781). */
function withoutLeader(file, config, id) {
    const after = leadsAfterRetire(config, id);
    if (after === undefined) {
        return { file, regrouped: { members: [], to: config.roles.lead } };
    }
    const { members, to, leads } = after;
    const next = Object.keys(leads).length === 0 ? Object.fromEntries(Object.entries(file).filter(([key]) => key !== 'leads')) : { ...file, leads };
    return { file: next, regrouped: { members, to } };
}
/**
 * The refusal for who asked, or undefined: only a lead over the session (the lead, or a sub-lead it is under, T509)
 * retires it, as the leader decides which workers the team needs; a session never retires itself.
 */
function callerProblem(config, tree, request) {
    if (request.by === config.roles.lead || tree.leads(request.by, request.id)) {
        return undefined;
    }
    return 'only a lead over the session retires it (the lead, or its sub-lead): the leader decides which workers the team needs';
}
/** The refusal while another part of the config names the session, or undefined. */
function namedProblem(config, id) {
    const role = Object.entries(config.roles).find(([, holder]) => holder === id);
    if (role !== undefined) {
        return `${id} holds roles.${role[0]}: give the role to another session first`;
    }
    const login = Object.entries(config.github.owners).find(([, session]) => session === id);
    if (login !== undefined) {
        return `github.owners names ${id} for ${login[0]}: point it at another session first`;
    }
    const repo = Object.entries(config.github.sessions).find(([, session]) => session === id);
    if (repo !== undefined) {
        return `github.sessions names ${id} for ${repo[0]}: point it at another session first`;
    }
    return undefined;
}
/**
 * The refusal for its open tasks and heir, or undefined. A sub-lead hands them only to itself or a session it leads,
 * so work never leaves its group by a sub-lead's hand (T782's rule for a task's owner, src/register/policy.ts).
 */
function heirProblem(config, tree, request) {
    const { by, heir, id, openTasks } = request;
    if (heir === undefined) {
        return openTasks.length === 0 ? undefined : `${id} owns open task(s) ${openTasks.join(', ')}: pass --to <heir> to hand them over, or close them first`;
    }
    if (heir === id) {
        return `${id} cannot be its own heir`;
    }
    if (!config.sessions.includes(heir)) {
        return `the heir ${heir} is not on the team`;
    }
    if (by !== config.roles.lead && heir !== by && !tree.leads(by, heir)) {
        return `${by} hands work only within its group: the heir ${heir} is not led by ${by}; the lead (${config.roles.lead}) moves work between groups`;
    }
    return undefined;
}
function handoverProblem(request) {
    if (request.noHandover !== undefined) {
        return request.noHandover.trim() === '' ? '--no-handover needs why there is none' : undefined;
    }
    return request.hasHandover
        ? undefined
        : `no handover at ${request.handoverPath}: write it (open work, next steps, branches, traps) or pass --no-handover "<why>"`;
}
/** The reason given, else that its job is done: the premise of a retire. */
function reasonOf(request) {
    const given = request.reason?.trim();
    return given === undefined || given === '' ? RETIRE_REASON : given;
}
/** The session taken out of `sessions`, `names`, `launch`, `budget.sessions` and `leads`, and its retire record; or why not. */
export function planRetire(file, config, active, request) {
    const { id } = request;
    if (!config.sessions.includes(id)) {
        return { ok: false, problem: `${id} is not on the team` };
    }
    const sessions = file['sessions'];
    if (!Array.isArray(sessions)) {
        return { ok: false, problem: 'the config has no sessions list to take it from' };
    }
    const hired = active.some((hire) => hire.session === id);
    const tree = new LeadTree(config);
    const problem = callerProblem(config, tree, request) ?? namedProblem(config, id) ?? heirProblem(config, tree, request) ?? handoverProblem(request);
    if (problem !== undefined) {
        return { ok: false, problem };
    }
    const off = { ...file, sessions: sessions.filter((session) => session !== id) };
    const { file: next, regrouped } = withoutLeader(withoutBudget(withoutEntry(withoutEntry(off, 'names', id), 'launch', id), id), config, id);
    const handOver = request.heir === undefined ? [] : request.openTasks;
    const retire = {
        kind: 'retire',
        session: id,
        reason: reasonOf(request),
        ...(request.hasHandover ? { handover: request.handoverPath } : {}),
        ...(request.noHandover === undefined ? {} : { noHandover: request.noHandover.trim() }),
        ...(request.heir === undefined ? {} : { heir: request.heir }),
        by: request.by,
        at: request.now,
    };
    return { ok: true, value: { config: next, retire, handOver, hired, regrouped } };
}
