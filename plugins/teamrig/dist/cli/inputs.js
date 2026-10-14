import { ENV } from "../core/home.js";
import { parseUtcDeadline, parseUtcDay } from "../core/time.js";
import { isTaskStatus, SESSION_NAME, TASK_ID, TASK_STATUSES } from "../register/model.js";
import { requiredFlag, UsageError } from "./args.js";
/**
 * Flag text to register inputs. Only the shape is checked here (a number, a list, a date); the
 * register's policy judges the values against the team config, so each rule has one home.
 */
/** `none` clears an optional field on `update` and selects "no week plan" on `list`. */
export const NONE = 'none';
export function sessionName(flag, value) {
    if (!SESSION_NAME.test(value)) {
        throw new UsageError(`${flag} "${value}" is not a session name (a lowercase letter, then up to 31 of a-z, 0-9, -)`);
    }
    return value;
}
/** The caller: `--session`, else the session variable. */
export function callerOf(flags, env) {
    const name = flags.get('session') ?? env[ENV.session]?.trim();
    if (name === undefined || name === '') {
        throw new UsageError(`--session (or $${ENV.session}) is required`);
    }
    return sessionName('--session', name);
}
export function taskIdOf(text) {
    if (!TASK_ID.test(text)) {
        throw new UsageError(`"${text}" is not a task id like T12`);
    }
    return text;
}
function tierOf(text) {
    if (!/^\d{1,3}$/.test(text)) {
        throw new UsageError(`--tier "${text}" is not a whole number`);
    }
    return Number(text);
}
function listOf(flag, text) {
    const items = text.split(',').map((item) => item.trim()).filter((item) => item !== '');
    if (items.length === 0) {
        throw new UsageError(`${flag} "${text}" is an empty list`);
    }
    return items;
}
/** `--week`: a day, checked here because `check` and `plan` read it without the policy. */
export function weekOf(text) {
    if (parseUtcDay(text) === undefined) {
        throw new UsageError(`--week "${text}" is not a YYYY-MM-DD date`);
    }
    return text;
}
export function addInputOf(flags, caller) {
    const input = {
        title: requiredFlag(flags, 'title'),
        owner: flags.get('owner') ?? caller,
        source: flags.get('source') ?? caller,
        tier: tierOf(requiredFlag(flags, 'tier')),
    };
    const ref = flags.get('ref');
    if (ref !== undefined) {
        input.ref = ref;
    }
    const due = flags.get('due');
    if (due !== undefined) {
        input.due = due;
    }
    const goals = flags.get('goals');
    if (goals !== undefined) {
        input.goals = listOf('--goals', goals);
    }
    const week = flags.get('week');
    if (week !== undefined) {
        input.week = week;
    }
    return input;
}
/** The fields `update` changes; `none` clears the ref, due date, goals or week. */
export function changesOf(flags) {
    const changes = {};
    const title = flags.get('title');
    if (title !== undefined) {
        changes.title = title;
    }
    const owner = flags.get('owner');
    if (owner !== undefined) {
        changes.owner = owner;
    }
    const tier = flags.get('tier');
    if (tier !== undefined) {
        changes.tier = tierOf(tier);
    }
    const ref = flags.get('ref');
    if (ref !== undefined) {
        changes.ref = ref === NONE ? null : ref;
    }
    const due = flags.get('due');
    if (due !== undefined) {
        changes.due = due === NONE ? null : due;
    }
    const goals = flags.get('goals');
    if (goals !== undefined) {
        changes.goals = goals === NONE ? [] : listOf('--goals', goals);
    }
    const week = flags.get('week');
    if (week !== undefined) {
        changes.week = week === NONE ? null : week;
    }
    return changes;
}
function statusOf(flag, text) {
    if (!isTaskStatus(text)) {
        throw new UsageError(`${flag} "${text}" is not ${TASK_STATUSES.join('|')}`);
    }
    return text;
}
export function statusInputOf(flags) {
    const input = { status: statusOf('--status', requiredFlag(flags, 'status')) };
    const note = flags.get('note');
    if (note !== undefined) {
        input.note = note;
    }
    const evidence = flags.get('evidence');
    if (evidence !== undefined) {
        input.evidence = evidence;
    }
    const skill = flags.get('skill');
    if (skill !== undefined) {
        input.skill = skill;
    }
    return input;
}
/** `list` filters; `--session` names the owner whose tasks to show. */
export function listFilterOf(flags) {
    const filter = {};
    const owner = flags.get('session');
    if (owner !== undefined) {
        filter.owner = sessionName('--session', owner);
    }
    const status = flags.get('status');
    if (status !== undefined) {
        filter.statuses = status === 'all' ? TASK_STATUSES : listOf('--status', status).map((item) => statusOf('--status', item));
    }
    const source = flags.get('source');
    if (source !== undefined) {
        filter.source = source;
    }
    const tiers = flags.get('tier');
    if (tiers !== undefined) {
        filter.tiers = listOf('--tier', tiers).map(tierOf);
    }
    const dueBefore = flags.get('due-before');
    if (dueBefore !== undefined) {
        const at = parseUtcDeadline(dueBefore);
        if (at === undefined) {
            throw new UsageError(`--due-before "${dueBefore}" is not YYYY-MM-DD or "YYYY-MM-DD HH:MM"`);
        }
        filter.dueBefore = at;
    }
    const week = flags.get('week');
    if (week !== undefined) {
        filter.week = week === NONE ? null : weekOf(week);
    }
    const goal = flags.get('goal');
    if (goal !== undefined) {
        filter.goal = goal;
    }
    return filter;
}
