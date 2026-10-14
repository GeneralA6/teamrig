import { formatUtcMinute, parseUtcDeadline, shortUtc } from "../core/time.js";
import { taskNumber } from "./fold.js";
import { ACTIVE_STATUSES } from "./model.js";
/** The task's deadline in ms, or undefined when it has none. */
export function dueTime(task) {
    return task.due === null ? undefined : parseUtcDeadline(task.due)?.getTime();
}
/** Plan order: tier, then due date (undated last), then id. */
export function byPlanOrder(a, b) {
    const dueA = dueTime(a) ?? Number.POSITIVE_INFINITY;
    const dueB = dueTime(b) ?? Number.POSITIVE_INFINITY;
    return a.tier - b.tier || (dueA === dueB ? 0 : dueA < dueB ? -1 : 1) || taskNumber(a.id) - taskNumber(b.id);
}
export function selectTasks(tasks, filter) {
    const statuses = filter.statuses ?? ACTIVE_STATUSES;
    const dueBefore = filter.dueBefore?.getTime();
    return [...tasks]
        .filter((task) => {
        const due = dueTime(task);
        return (statuses.includes(task.status) &&
            (filter.owner === undefined || task.owner === filter.owner) &&
            (filter.source === undefined || task.source === filter.source) &&
            (filter.tiers === undefined || filter.tiers.includes(task.tier)) &&
            (dueBefore === undefined || (due !== undefined && due < dueBefore)) &&
            (filter.week === undefined || task.week === filter.week) &&
            (filter.goal === undefined || task.goals.includes(filter.goal)));
    })
        .sort(byPlanOrder);
}
/** The task's id, or `<team>/<id>` when a roll-up over a tree of teams names its team. */
export function taskLabel(task, team) {
    return team === undefined ? task.id : `${team}/${task.id}`;
}
/**
 * One line that names each field, so a newcomer can read it:
 * `T12 in-progress, tier 2, owner alpha, due 01-15, week 01-13, from lead, goals G1 | title`.
 * With `team`, the id reads `<team>/T12`.
 */
export function formatTask(task, team) {
    const parts = [`${taskLabel(task, team)} ${task.status}`, `tier ${task.tier}`, `owner ${task.owner}`];
    if (task.due !== null) {
        parts.push(`due ${shortUtc(task.due)}`);
    }
    if (task.week !== null) {
        parts.push(`week ${shortUtc(task.week)}`);
    }
    parts.push(`from ${task.source}`);
    if (task.goals.length > 0) {
        parts.push(`goals ${task.goals.join(',')}`);
    }
    const blocked = task.status === 'blocked' && task.note !== null ? ` (blocked: ${task.note})` : '';
    return `${parts.join(', ')} | ${task.title}${blocked}`;
}
/** One line per event, for `show`. */
export function formatEvent(event) {
    const head = `${formatUtcMinute(new Date(event.at))} ${event.by} ${event.type}`;
    const note = 'note' in event && event.note !== null ? ` note="${event.note}"` : '';
    switch (event.type) {
        case 'create': {
            const { task } = event;
            return [
                head,
                `owner=${task.owner}`,
                `source=${task.source}`,
                `tier=${task.tier}`,
                task.ref === null ? undefined : `ref=${task.ref}`,
                task.due === null ? undefined : `due=${task.due}`,
                task.week === null ? undefined : `week=${task.week}`,
                task.goals.length === 0 ? undefined : `goals=${task.goals.join(',')}`,
            ]
                .filter((part) => part !== undefined)
                .join(' ');
        }
        case 'status':
            return [
                `${head} ${event.status}${note}`,
                event.evidence === null ? undefined : `evidence=${event.evidence}`,
                event.skill === null ? undefined : `skill=${event.skill}`,
            ]
                .filter((part) => part !== undefined)
                .join(' ');
        case 'update': {
            const fields = Object.entries(event.changes).map(([name, value]) => `${name}=${Array.isArray(value) ? value.join(',') : String(value)}`);
            return `${head} ${fields.join(' ')}${note}`;
        }
    }
}
/** `show`: the task line, its status details, then its history. */
export function formatTaskDetail(task, events) {
    const lines = [formatTask(task)];
    if (task.ref !== null) {
        lines.push(`ref: ${task.ref}`);
    }
    if (task.note !== null) {
        lines.push(`note: ${task.note}`);
    }
    if (task.evidence !== null) {
        lines.push(`evidence: ${task.evidence}`);
    }
    if (task.skill !== null) {
        lines.push(`skill: ${task.skill}`);
    }
    lines.push('history:', ...events.filter((event) => event.id === task.id).map((event) => `  ${formatEvent(event)}`));
    return lines.join('\n');
}
