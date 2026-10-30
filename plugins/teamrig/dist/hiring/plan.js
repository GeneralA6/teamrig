import { isDefaultModel, isModel, launchOf } from "../config/launch.js";
import { LeadTree } from "../config/lead-tree.js";
import { ownerAsk } from "../config/tree.js";
import { isRecord } from "../core/guards.js";
import { ID_PATTERN } from "../core/ids.js";
import { formatUtcDay, parseUtcDay } from "../core/time.js";
/**
 * The plan behind `hire`: a new session written into the team config within `hiring`'s policy. No count of hires
 * bounds it: the host's room bounds who is at the office (`hire --yes` checks it), the leader decides who is hired.
 * Pure: it takes the file's JSON and the config read from it, and returns the next JSON and the record to log, so
 * the command can preview before it writes. The new file is checked afterwards by the config parser every command
 * reads with (the id's and name's rules live there).
 */
const DAY_MS = 86_400_000;
function recordAt(record, key) {
    const value = record[key];
    return isRecord(value) ? value : {};
}
function reviewDayOf(request, config) {
    if (request.reviewBy === undefined) {
        return { ok: true, value: formatUtcDay(new Date(request.now + config.hiring.reviewDays * DAY_MS)) };
    }
    const day = parseUtcDay(request.reviewBy);
    if (day === undefined) {
        return { ok: false, problem: `the review day "${request.reviewBy}" is not a YYYY-MM-DD date` };
    }
    if (formatUtcDay(day) < formatUtcDay(new Date(request.now))) {
        return { ok: false, problem: `the review day ${request.reviewBy} has passed` };
    }
    return { ok: true, value: formatUtcDay(day) };
}
/**
 * Why `by` may not hire, or undefined when it may: a lead hires, the team's lead or a sub-lead (T781), and a
 * sub-lead's hire joins its own group, so work it hires for never leaves the group (T509).
 */
export function hirerProblem(config, by) {
    return new LeadTree(config).isLeader(by) ? undefined : `only a lead hires sessions: the lead (${config.roles.lead}), or a sub-lead into its own group`;
}
/** Whom the hirer asks for the owner's approval: a sub-lead its own leader, who takes it up; the lead {@link ownerAsk}. */
function approvalAsk(config, by) {
    const leader = new LeadTree(config).leaderOf(by);
    return by === config.roles.lead || leader === undefined ? ownerAsk(config) : `${leader}, your leader, who takes it to the owner`;
}
/** The refusal under `hiring.policy`, or undefined when it allows this hire. */
function policyProblem(config, request) {
    switch (config.hiring.policy) {
        case 'off':
            return 'hiring.policy is off: the team takes no hires by command';
        case 'owner':
            return request.approvedBy === undefined || request.approvedBy.trim() === ''
                ? `hiring.policy is owner: the owner approves each hire; ask ${approvalAsk(config, request.by)}, then pass --approved-by "<who>"`
                : undefined;
        case 'lead':
        case 'automatic':
            return undefined;
    }
}
/**
 * The new session written into `sessions`, `names` and `launch`, and its hire record; or why not. A sub-lead's hire is
 * also listed under it in `leads`. It launches on the lead's own model and effort unless told otherwise, whoever hires
 * it, so a burst hire stays on the lead's (src/hiring/burst-hire.ts). It gets no fixed daily budget: like any session,
 * its part of the team's daily budget follows its share and its queued work (src/budget/parts.ts).
 */
export function planHire(file, config, request) {
    const refusal = hirerProblem(config, request.by) ?? policyProblem(config, request);
    if (refusal !== undefined) {
        return { ok: false, problem: refusal };
    }
    if (request.scope.trim() === '' || request.reason.trim() === '') {
        return { ok: false, problem: 'a hire needs its job (--scope) and why it is needed (--reason)' };
    }
    if (!ID_PATTERN.test(request.id)) {
        return { ok: false, problem: `"${request.id}" is not a session id: a lowercase letter, then up to 31 lowercase letters, digits or -` };
    }
    if (config.sessions.includes(request.id)) {
        return { ok: false, problem: `${request.id} is already on the team` };
    }
    const sessions = file['sessions'];
    if (!Array.isArray(sessions)) {
        return { ok: false, problem: 'the config has no sessions list to add to' };
    }
    const modelProblem = request.model === undefined ? undefined : isModel(request.model);
    if (modelProblem !== undefined) {
        return { ok: false, problem: `--model ${request.model}: ${modelProblem}` };
    }
    const reviewBy = reviewDayOf(request, config);
    if (!reviewBy.ok) {
        return reviewBy;
    }
    const lead = config.roles.lead;
    const leads = lead === undefined ? {} : launchOf(config, lead);
    const model = request.model ?? leads.model;
    const effort = request.effort ?? leads.effort;
    const launch = { ...(isDefaultModel(model) ? {} : { model }), ...(effort === undefined ? {} : { effort }) };
    const subLead = request.by === lead ? undefined : request.by;
    const next = {
        ...file,
        sessions: [...sessions, request.id],
        ...(request.name === undefined ? {} : { names: { ...recordAt(file, 'names'), [request.id]: request.name } }),
        launch: { ...recordAt(file, 'launch'), [request.id]: launch },
        ...(subLead === undefined ? {} : { leads: { ...recordAt(file, 'leads'), [subLead]: [...(config.leads[subLead] ?? []), request.id] } }),
    };
    const hire = {
        kind: 'hire',
        session: request.id,
        scope: request.scope.trim(),
        reason: request.reason.trim(),
        ...(request.approvedBy === undefined ? {} : { approvedBy: request.approvedBy.trim() }),
        ...launch,
        reviewBy: reviewBy.value,
        ...(request.burst === undefined ? {} : { burst: request.burst }),
        by: request.by,
        at: request.now,
    };
    return { ok: true, value: { config: next, hire, leader: request.by } };
}
