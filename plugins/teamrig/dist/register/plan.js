import { showStored } from "../core/time.js";
import { NO_TASKS_ELSEWHERE, TaskTree } from "./tree.js";
import { rankParts, sizeText, taskLabel } from "./views.js";
import { waitsText } from "./waits.js";
import { proofOf } from "./verify.js";
/** The bands in the order a plan heads them. */
const BANDS = [0, 1, 2];
/** A band's heading: band 2 holds every class but the two the team names, so it names none. */
function bandHeading(band, focus) {
    switch (band) {
        case 0:
            return 'Expedite';
        case 1:
            return `${focus.roadmapClass} and ${focus.maintenanceClass}`;
        case 2:
            return 'Other work';
    }
}
/**
 * The week plan as markdown: the tasks tagged with `week`, grouped by band, each group in plan order (tree.ts
 * PLAN_KEYS). A line names the task's class and score, and its effective due, its own or an earlier one of an active
 * task that needs it, which it names too: `due 01-10 from T5`.
 */
export function renderPlan(tasks, week, now, zone, { team, fit = [], elsewhere = NO_TASKS_ELSEWHERE, ranking }) {
    const all = [...tasks];
    const tree = new TaskTree(new Map(all.map((task) => [task.id, task])), now, zone, week, elsewhere, ranking);
    const inWeek = tree.inPlanOrder(all.filter((task) => task.week === week));
    const done = inWeek.filter((task) => task.status === 'done').length;
    const dropped = inWeek.filter((task) => task.status === 'dropped').length;
    const lines = [
        `# Week plan ${week}${team === undefined ? '' : `, team ${team}`}`,
        '',
        `${inWeek.length} tasks: ${done} done, ${dropped} dropped, ${inWeek.length - done - dropped} to do. From the task register at ${zone.minute(now)}.`,
        ...(fit.length === 0 ? [] : ['', ...fit.map((line) => `- ${line}`)]),
    ];
    for (const band of BANDS) {
        const rows = inWeek.filter((task) => tree.rankedOf(task)?.band === band);
        if (rows.length > 0) {
            lines.push('', `## ${bandHeading(band, ranking.focus)}`, '', ...rows.map((task) => planLine(task, ranking.ownerSource, tree, team)));
        }
    }
    return lines.join('\n');
}
function planLine(task, ownerSource, tree, team) {
    const due = tree.effectiveDue(task.id);
    const meta = [
        ...rankParts(task, tree),
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
