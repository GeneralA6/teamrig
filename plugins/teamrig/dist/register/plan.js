import { showStored } from "../core/time.js";
import { priorityText } from "./model.js";
import { TaskTree } from "./tree.js";
import { sizeText, taskLabel } from "./views.js";
import { waitsText } from "./waits.js";
import { proofOf } from "./verify.js";
/**
 * The week plan as markdown: the tasks tagged with `week`, grouped by priority, each group in plan order (tree.ts
 * PLAN_KEYS: started first, then the effective due, its own or an earlier one of an active task that needs it, which
 * the line names: `due 01-10 from T5`).
 */
export function renderPlan(tasks, week, now, zone, config, { team, fit = [] } = {}) {
    const all = [...tasks];
    const tree = new TaskTree(new Map(all.map((task) => [task.id, task])), now, zone, week);
    const inWeek = tree.inPlanOrder(all.filter((task) => task.week === week));
    const done = inWeek.filter((task) => task.status === 'done').length;
    const dropped = inWeek.filter((task) => task.status === 'dropped').length;
    const lines = [
        `# Week plan ${week}${team === undefined ? '' : `, team ${team}`}`,
        '',
        `${inWeek.length} tasks: ${done} done, ${dropped} dropped, ${inWeek.length - done - dropped} to do. From the task register at ${zone.minute(now)}.`,
        ...(fit.length === 0 ? [] : ['', ...fit.map((line) => `- ${line}`)]),
    ];
    for (const priority of config.priorities) {
        const rows = inWeek.filter((task) => task.priority === priority.id);
        if (rows.length > 0) {
            lines.push('', `## ${priorityText(priority.id)}: ${priority.name}`, '', ...rows.map((task) => planLine(task, config.ownerSource, tree, team)));
        }
    }
    return lines.join('\n');
}
function planLine(task, ownerSource, tree, team) {
    const due = tree.effectiveDue(task.id);
    const meta = [
        task.owner,
        due === undefined ? undefined : `due ${showStored(due.due, tree.zone)}${due.from === null ? '' : ` from ${due.from}`}`,
        task.after.length === 0 ? undefined : `after ${task.after.join(',')}`,
        task.source === ownerSource ? 'owner order' : `from ${task.source}`,
        task.goals.length === 0 ? undefined : task.goals.join(', '),
        task.size === null ? undefined : `size ${sizeText(task.size)}`,
    ].filter((part) => part !== undefined);
    const title = task.status === 'dropped' ? `~~${task.title}~~` : task.title;
    return `- [${task.status === 'done' ? 'x' : ' '}] **${taskLabel(task, team)}** ${title} (${meta.join(' · ')})${statusTail(task, tree)}`;
}
function statusTail(task, tree) {
    switch (task.status) {
        case 'done':
            return task.evidence === null ? ' done' : ` done: ${task.evidence}`;
        case 'waiting':
            return ` **waiting:** ${[task.waits.length > 0 ? waitsText(task.waits, tree.zone, tree.context) : null, task.note].filter((part) => part !== null).join('; ')}`;
        case 'dropped':
            return ` dropped: ${task.note ?? ''}`;
        case 'in-progress':
            return ' (in progress)';
        case 'verifying':
            return ` verifying, proof: ${proofOf(task) ?? ''}${task.waits.length > 0 ? `; waiting: ${waitsText(task.waits, tree.zone, tree.context)}` : ''}`;
        case 'open':
            return '';
    }
}
