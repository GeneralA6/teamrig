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
function ownValue(record, key) {
    return Object.hasOwn(record, key) ? record[key] : undefined;
}
function recordAt(record, key) {
    const value = record[key];
    return isRecord(value) ? value : {};
}
/** The daily budget of each hire still on the team, as the config has it now, so a later `budget` change counts. */
export function hiredDailyPcts(config, active) {
    return active.filter((hire) => config.sessions.includes(hire.session)).map((hire) => ownValue(config.budget.sessions, hire.session)?.dailyPct ?? hire.dailyPct);
}
/** A sum of daily budgets to hundredths, so 0.1 + 0.2 meets a cap of 0.3. */
function sumPct(pcts) {
    return Math.round(pcts.reduce((sum, pct) => sum + pct, 0) * 100) / 100;
}
/**
 * Why one more hire at `dailyPct` would pass `hiring`'s caps beside the hires on the team, whose daily budgets are
 * `hired` ({@link hiredDailyPcts}): the hired sessions at once, or the sum of their daily budgets. Undefined when it fits.
 */
export function hireCapProblem(hiring, hired, dailyPct) {
    if (hired.length >= hiring.maxSessions) {
        return `the team already has ${hired.length} hired session(s), the most hiring.maxSessions allows`;
    }
    const total = sumPct([...hired, dailyPct]);
    return total > hiring.maxDailyPct ? `the hired sessions' daily budgets would add up to ${total}% of the week, over hiring.maxDailyPct ${hiring.maxDailyPct}%` : undefined;
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
/** The refusal under `hiring.policy`, or undefined when it allows this hire. */
function policyProblem(config, request) {
    switch (config.hiring.policy) {
        case 'off':
            return 'hiring.policy is off: the team takes no hires by command';
        case 'owner':
            return request.approvedBy === undefined || request.approvedBy.trim() === ''
                ? 'hiring.policy is owner: the owner approves each hire; ask them, then pass --approved-by "<who>"'
                : undefined;
        case 'lead':
        case 'automatic':
            return undefined;
    }
}
/** The new session written into `sessions`, `names`, `launch` and `budget.sessions`, and its hire record; or why not. */
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
    const hired = hiredDailyPcts(config, active);
    const dailyPct = request.dailyPct ?? config.hiring.dailyPct;
    const capProblem = hireCapProblem(config.hiring, hired, dailyPct);
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
    const budget = recordAt(file, 'budget');
    const next = {
        ...file,
        sessions: [...sessions, request.id],
        ...(request.name === undefined ? {} : { names: { ...recordAt(file, 'names'), [request.id]: request.name } }),
        launch: { ...recordAt(file, 'launch'), [request.id]: launch },
        budget: { ...budget, sessions: { ...recordAt(budget, 'sessions'), [request.id]: { dailyPct } } },
    };
    const hire = {
        kind: 'hire',
        session: request.id,
        scope: request.scope.trim(),
        reason: request.reason.trim(),
        ...(request.approvedBy === undefined ? {} : { approvedBy: request.approvedBy.trim() }),
        ...launch,
        dailyPct,
        reviewBy: reviewBy.value,
        ...(request.burst === undefined ? {} : { burst: request.burst }),
        by: request.by,
        at: request.now,
    };
    return { ok: true, value: { config: next, hire, hired: hired.length + 1, hiredDailyPct: sumPct([...hired, dailyPct]) } };
}
