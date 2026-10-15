import { formatUtcMinute, shortUtc } from "../core/time.js";
import { priorityText } from "./model.js";
import { byPlanOrder, taskLabel } from "./views.js";
import { waitContext, waitsText } from "./waits.js";
/**
 * The week plan as markdown: the tasks tagged with `week`, grouped by priority, then by due date. With
 * `team`, for a roll-up over a tree of teams, the heading names the team and ids read `<team>/T12`.
 */
export function renderPlan(tasks, week, now, config, team) {
    const all = [...tasks];
    const context = waitContext(new Map(all.map((task) => [task.id, task])), now);
    const inWeek = all.filter((task) => task.week === week).sort(byPlanOrder);
    const done = inWeek.filter((task) => task.status === 'done').length;
    const dropped = inWeek.filter((task) => task.status === 'dropped').length;
    const lines = [
        `# Week plan ${week}${team === undefined ? '' : `, team ${team}`}`,
        '',
        `${inWeek.length} tasks: ${done} done, ${dropped} dropped, ${inWeek.length - done - dropped} to do. From the task register at ${formatUtcMinute(now)} UTC.`,
    ];
    for (const priority of config.priorities) {
        const rows = inWeek.filter((task) => task.priority === priority.id);
        if (rows.length > 0) {
            lines.push('', `## ${priorityText(priority.id)}: ${priority.name}`, '', ...rows.map((task) => planLine(task, config.ownerSource, context, team)));
        }
    }
    return lines.join('\n');
}
function planLine(task, ownerSource, context, team) {
    const meta = [
        task.owner,
        task.due === null ? undefined : `due ${shortUtc(task.due)}`,
        task.after.length === 0 ? undefined : `after ${task.after.join(',')}`,
        task.source === ownerSource ? 'owner order' : `from ${task.source}`,
        task.goals.length === 0 ? undefined : task.goals.join(', '),
    ].filter((part) => part !== undefined);
    const title = task.status === 'dropped' ? `~~${task.title}~~` : task.title;
    return `- [${task.status === 'done' ? 'x' : ' '}] **${taskLabel(task, team)}** ${title} (${meta.join(' · ')})${statusTail(task, context)}`;
}
function statusTail(task, context) {
    switch (task.status) {
        case 'done':
            return task.evidence === null ? ' done' : ` done: ${task.evidence}`;
        case 'waiting':
            return ` **waiting:** ${[task.waits.length > 0 ? waitsText(task.waits, context) : null, task.note].filter((part) => part !== null).join('; ')}`;
        case 'dropped':
            return ` dropped: ${task.note ?? ''}`;
        case 'in-progress':
            return ' (in progress)';
        case 'verifying':
            return ` verifying, proof: ${task.note ?? ''}`;
        case 'open':
            return '';
    }
}
