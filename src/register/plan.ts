import { showStored } from '../core/time.ts';
import type { TimeZone } from '../core/zone.ts';
import { priorityLevels } from '../config/priorities.ts';
import type { RegisterConfig } from '../config/types.ts';
import type { Task } from './fold.ts';
import { priorityText } from './model.ts';
import { NO_TASKS_ELSEWHERE, TaskTree, type TasksElsewhere, type TreeRanking } from './tree.ts';
import { sizeText, taskLabel } from './views.ts';
import { waitsText } from './waits.ts';
import { proofOf } from './verify.ts';

export interface PlanOptions {
  /** For a roll-up over a tree of teams: the heading names the team and ids read `<team>/T12`. */
  readonly team?: string | undefined;
  /** The week's fit to the weekly limit (fit.ts fitLines), printed under the counts as a list. */
  readonly fit?: readonly string[];
  /** The tasks of the team tree's other registers, which a wait on or a dependency after a task this one lacks reads. */
  readonly elsewhere?: TasksElsewhere;
  /** What ranks the tasks: with none they tie on band and score and fall to the later plan keys. */
  readonly ranking?: TreeRanking;
}

/**
 * The week plan as markdown: the tasks tagged with `week`, grouped by priority, each group in plan order (tree.ts
 * PLAN_KEYS: started first, then the effective due, its own or an earlier one of an active task that needs it, which
 * the line names: `due 01-10 from T5`).
 */
export function renderPlan(
  tasks: Iterable<Task>,
  week: string,
  now: Date,
  zone: TimeZone,
  config: RegisterConfig,
  { team, fit = [], elsewhere = NO_TASKS_ELSEWHERE, ranking }: PlanOptions = {},
): string {
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
  for (const priority of priorityLevels(config.priorities)) {
    const rows = inWeek.filter((task) => task.priority === priority.id);
    if (rows.length > 0) {
      lines.push('', `## ${priorityText(priority.id)}: ${priority.name}`, '', ...rows.map((task) => planLine(task, config.ownerSource, tree, team)));
    }
  }
  return lines.join('\n');
}

function planLine(task: Task, ownerSource: string, tree: TaskTree, team: string | undefined): string {
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

function statusTail(task: Task, tree: TaskTree): string {
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
