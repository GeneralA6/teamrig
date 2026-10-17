import { ENV } from "../core/home.js";
import { NAME_PATTERN, NAME_RULE } from "../core/ids.js";
import { parseUtcDeadline, parseUtcDay } from "../core/time.js";
import { MAX_SIZE_PCT, sizeProblem } from "../register/events.js";
import { isTaskStatus, LEGACY_WAITING_HINT, LEGACY_WAITING_STATUS, priorityText, TASK_ID, TASK_STATUSES } from "../register/model.js";
import { WAITS_USAGE } from "../register/policy.js";
import { isWaitKind, waitOf } from "../register/waits.js";
import { requiredFlag, UsageError } from "./args.js";
/**
 * Flag text to register inputs. Only the shape is checked here (a priority like p2, a list, a date); the
 * command resolves session names to ids against the roster, and the register's policy judges the
 * values against the team config, so each rule has one home.
 */
/** `none` clears an optional field on `update` and selects "no week plan" on `list`. */
export const NONE = 'none';
/**
 * A session's id or any name it has had, shape only; the command resolves it to the id against the roster.
 * Every id also has a name's shape, so one pattern covers both.
 */
export function sessionRef(flag, value) {
    if (!NAME_PATTERN.test(value)) {
        throw new UsageError(`${flag} "${value}" is not a session id or name (${NAME_RULE})`);
    }
    return value;
}
/** The caller: `--session`, else the session variable. */
export function callerOf(flags, env) {
    const name = flags.get('session') ?? env[ENV.session]?.trim();
    if (name === undefined || name === '') {
        throw new UsageError(`--session (or $${ENV.session}) is required`);
    }
    return sessionRef('--session', name);
}
export function taskIdOf(text) {
    if (!TASK_ID.test(text)) {
        throw new UsageError(`"${text}" is not a task id like T12`);
    }
    return text;
}
/** A priority as typed: `p` and the level, 1 to 99. The team config's levels are judged by the policy. */
const PRIORITY_TEXT = /^p([1-9]\d?)$/;
/** The tier spelling, such as `t2`, that the register took before priorities. */
const OLD_TIER_TEXT = /^t([1-9]\d?)$/i;
/** A bare level, such as `2`: what `--tier` took. */
const BARE_LEVEL_TEXT = /^[1-9]\d?$/;
/** `--priority p2`: a level in the shape `p<n>`; the old `t2` and a bare `2` are refused with the spelling to use. */
export function priorityOf(text) {
    const level = PRIORITY_TEXT.exec(text)?.[1];
    if (level !== undefined) {
        return Number(level);
    }
    const tier = OLD_TIER_TEXT.exec(text)?.[1];
    if (tier !== undefined) {
        throw new UsageError(`priority "${text}" is the old tier spelling: write ${priorityText(Number(tier))}`);
    }
    if (BARE_LEVEL_TEXT.test(text)) {
        throw new UsageError(`priority "${text}" is not p<n>: write ${priorityText(Number(text))}`);
    }
    throw new UsageError(`priority "${text}" is not p<n>`);
}
/** A comma list flag, its items trimmed; refused when it names none. */
export function listOf(flag, text) {
    const items = text.split(',').map((item) => item.trim()).filter((item) => item !== '');
    if (items.length === 0) {
        throw new UsageError(`${flag} "${text}" is an empty list`);
    }
    return items;
}
/** A size as typed: a number, a `%` after it allowed (`1.5` or `1.5%`). */
const SIZE_TEXT = /^(\d+(?:\.\d+)?|\.\d+)%?$/;
/** `--size 1.5`: what the task costs, in percent of the weekly usage limit, above 0 and at most the whole week. */
export function sizeOf(text) {
    const number = SIZE_TEXT.exec(text.trim())?.[1];
    const value = number === undefined ? Number.NaN : Number(number);
    if (Number.isNaN(value) || sizeProblem(value) !== undefined) {
        throw new UsageError(`--size "${text}" is not a percent of the weekly limit above 0 and at most ${MAX_SIZE_PCT}, like 1.5`);
    }
    return value;
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
        priority: priorityOf(requiredFlag(flags, 'priority')),
    };
    const description = flags.get('description');
    if (description !== undefined) {
        input.description = description;
    }
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
    const after = flags.get('after');
    if (after !== undefined) {
        input.after = afterOf(after);
    }
    const size = flags.get('size');
    if (size !== undefined) {
        input.size = sizeOf(size);
    }
    return input;
}
/** `--after T5,T6`: the tasks to finish before this one starts. */
function afterOf(text) {
    return listOf('--after', text).map(taskIdOf);
}
/**
 * `--waits decision:owner,task:T5,time:2030-01-09 12:00`: what a waiting task waits for, each `kind:value`, the
 * value after the first colon, so a time keeps its own. Who gives a decision or an approval is resolved by the command.
 */
export function waitsOf(text) {
    return listOf('--waits', text).map((item) => {
        const colon = item.indexOf(':');
        const kind = item.slice(0, Math.max(colon, 0)).trim();
        if (!isWaitKind(kind)) {
            throw new UsageError(`--waits "${item}" is not one of ${WAITS_USAGE}`);
        }
        const reason = waitOf(kind, item.slice(colon + 1).trim());
        if (typeof reason === 'string') {
            throw new UsageError(`--waits "${item}": ${reason}`);
        }
        return reason;
    });
}
/** The fields `update` changes; `none` clears the description, ref, due date, goals, week, plan dependency or size. */
export function changesOf(flags) {
    const changes = {};
    const title = flags.get('title');
    if (title !== undefined) {
        changes.title = title;
    }
    const description = flags.get('description');
    if (description !== undefined) {
        changes.description = description === NONE ? null : description;
    }
    const owner = flags.get('owner');
    if (owner !== undefined) {
        changes.owner = owner;
    }
    const priority = flags.get('priority');
    if (priority !== undefined) {
        changes.priority = priorityOf(priority);
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
    const after = flags.get('after');
    if (after !== undefined) {
        changes.after = after === NONE ? [] : afterOf(after);
    }
    const size = flags.get('size');
    if (size !== undefined) {
        changes.size = size === NONE ? null : sizeOf(size);
    }
    return changes;
}
/** A status as typed; `next` says what to type for the old `blocked`, which is refused (no alias kept). */
function statusOf(flag, text, next) {
    if (text === LEGACY_WAITING_STATUS) {
        throw new UsageError(`${flag} ${LEGACY_WAITING_HINT}: ${next}`);
    }
    if (!isTaskStatus(text)) {
        throw new UsageError(`${flag} "${text}" is not ${TASK_STATUSES.join('|')}`);
    }
    return text;
}
export function statusInputOf(flags) {
    const input = {
        status: statusOf('--status', requiredFlag(flags, 'status'), `use --status waiting --waits <reason> (${WAITS_USAGE})`),
    };
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
    const waits = flags.get('waits');
    if (waits !== undefined) {
        input.waits = waitsOf(waits);
    }
    const proof = flags.get('proof');
    if (proof !== undefined) {
        input.proof = proof;
    }
    const due = flags.get('due');
    if (due !== undefined) {
        input.due = due;
    }
    return input;
}
/**
 * `set <id> --status ... [--ask <session> --text "<the work>"]`: with `--ask`, `--due` is the asked task's due date
 * rather than a date to verify by; `--text` goes only with `--ask`, which needs it. The command resolves the asked
 * session to its id.
 */
export function setInputOf(flags) {
    const asked = flags.get('ask');
    const text = flags.get('text');
    if (asked === undefined) {
        if (text !== undefined) {
            throw new UsageError('--text goes only with --ask <session>: it is the work asked for');
        }
        return { status: statusInputOf(flags), ask: null };
    }
    if (text === undefined || text.trim() === '') {
        throw new UsageError('--ask needs --text "<the work asked for>": the title of the task it creates');
    }
    const { due, ...status } = statusInputOf(flags);
    return { status, ask: { owner: sessionRef('--ask', asked), title: text, ...(due === undefined ? {} : { due }) } };
}
/** `list` filters; `--session` names the owner whose tasks to show. */
export function listFilterOf(flags) {
    const filter = {};
    const owner = flags.get('session');
    if (owner !== undefined) {
        filter.owner = sessionRef('--session', owner);
    }
    const status = flags.get('status');
    if (status !== undefined) {
        filter.statuses = status === 'all' ? TASK_STATUSES : listOf('--status', status).map((item) => statusOf('--status', item, 'use --status waiting'));
    }
    const source = flags.get('source');
    if (source !== undefined) {
        filter.source = source;
    }
    const priorities = flags.get('priority');
    if (priorities !== undefined) {
        filter.priorities = listOf('--priority', priorities).map(priorityOf);
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
