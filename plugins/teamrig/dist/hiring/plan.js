import { isDefaultModel, isModel, launchOf } from "../config/launch.js";
import { isRecord } from "../core/guards.js";
import { ID_PATTERN } from "../core/ids.js";
import { formatUtcDay, parseUtcDay } from "../core/time.js";
/**
 * The plan behind `hire`: a new session written into the team config within `hiring`'s policy and
 * caps. Pure: it takes the file's JSON, the config read from it and the hires still active, and returns
 * the next JSON and the record to log, so the command can preview before it writes. The new file is
 * checked afterwards by the config parser every command reads with (the id's and name's rules live there).
 */
const DAY_MS = 86_400_000;
function recordAt(record, key) {
    const value = record[key];
    return isRecord(value) ? value : {};
}
/** How many of the active hires are still on the team: a retired or removed one no longer counts against the cap. */
export function hiresOnTeam(config, active) {
    return active.filter((hire) => config.sessions.includes(hire.session)).length;
}
/**
 * Why one more hire beside the `hired` hires on the team ({@link hiresOnTeam}) would pass `hiring.maxSessions`;
 * undefined when it fits. A hire has no fixed daily budget, so the count is the only cap.
 */
export function hireCapProblem(hiring, hired) {
    return hired >= hiring.maxSessions ? `the team already has ${hired} hired session(s), the most hiring.maxSessions allows` : undefined;
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
 * Whom a team's lead asks for what the owner approves: the owner in a root team. A child team's lead asks its parent
 * team's lead, who takes it up to the owner; it never goes to the owner directly.
 */
export function ownerAsk(config) {
    const parent = config.team?.parent;
    return parent === undefined ? 'the owner' : `the lead of team ${parent}, who takes it to the owner`;
}
/** The refusal under `hiring.policy`, or undefined when it allows this hire. */
function policyProblem(config, request) {
    switch (config.hiring.policy) {
        case 'off':
            return 'hiring.policy is off: the team takes no hires by command';
        case 'owner':
            return request.approvedBy === undefined || request.approvedBy.trim() === ''
                ? `hiring.policy is owner: the owner approves each hire; ask ${ownerAsk(config)}, then pass --approved-by "<who>"`
                : undefined;
        case 'lead':
        case 'automatic':
            return undefined;
    }
}
/**
 * The new session written into `sessions`, `names` and `launch`, and its hire record; or why not. It gets no fixed daily
 * budget: like any session, its part of the team's daily budget follows its share and its queued work (src/budget/parts.ts).
 */
export function planHire(file, config, active, request) {
    const refusal = policyProblem(config, request);
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
    const hired = hiresOnTeam(config, active);
    const capProblem = hireCapProblem(config.hiring, hired);
    if (capProblem !== undefined) {
        return { ok: false, problem: capProblem };
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
    const next = {
        ...file,
        sessions: [...sessions, request.id],
        ...(request.name === undefined ? {} : { names: { ...recordAt(file, 'names'), [request.id]: request.name } }),
        launch: { ...recordAt(file, 'launch'), [request.id]: launch },
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
    return { ok: true, value: { config: next, hire, hired: hired + 1 } };
}
