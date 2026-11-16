import { showStored } from '../core/time.ts';
import type { TimeZone } from '../core/zone.ts';
import type { Task } from './fold.ts';
import { goalsInRankOrder, isLate, sliceLabel } from './goal-slices.ts';
import type { Goal, Slice } from './goals.ts';
import type { Band, ScoreFocus } from './score.ts';
import { NO_TASKS_ELSEWHERE, TaskTree, type TasksElsewhere, type TreeRanking } from './tree.ts';
import { rankParts, sizeText, taskLabel } from './views.ts';
import { waitsText } from './waits.ts';
import { proofOf } from './verify.ts';

/** The bands in the order a plan heads them. */
const BANDS: readonly Band[] = [0, 1, 2];

export interface PlanOptions {
  /** For a roll-up over a tree of teams: the heading names the team and ids read `<team>/T12`. */
  readonly team?: string | undefined;
  /** The week's fit to the weekly limit (fit.ts fitLines), printed under the counts as a list. */
  readonly fit?: readonly string[];
  /** The tasks of the team tree's other registers, which a wait on or a dependency after a task this one lacks reads. */
  readonly elsewhere?: TasksElsewhere;
  /** What ranks the tasks and names their bands. */
  readonly ranking: TreeRanking;
  /**
   * With `--by-slice` (T2203), the team's goals: each of their slices heads the week's tasks that make it, ahead of
   * the bands, which then hold the rest. Undefined: by band only.
   */
  readonly bySlice?: ReadonlyMap<string, Goal>;
}

/** A band's heading: band 2 holds every class but the two the team names, so it names none. */
function bandHeading(band: Band, focus: Pick<ScoreFocus, 'roadmapClass' | 'maintenanceClass'>): string {
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
export function renderPlan(
  tasks: Iterable<Task>,
  week: string,
  now: Date,
  zone: TimeZone,
  { team, fit = [], elsewhere = NO_TASKS_ELSEWHERE, ranking, bySlice }: PlanOptions,
): string {
  const all = [...tasks];
  const tree = new TaskTree(new Map(all.map((task) => [task.id, task])), now, zone, week, elsewhere, ranking);
  const planned = tree.inPlanOrder(all.filter((task) => task.week === week && !tree.isParked(task)));
  const done = planned.filter((task) => task.status === 'done').length;
  const dropped = planned.filter((task) => task.status === 'dropped').length;
  const lines = [
    `# Week plan ${week}${team === undefined ? '' : `, team ${team}`}`,
    '',
    `${planned.length} tasks: ${done} done, ${dropped} dropped, ${planned.length - done - dropped} to do. From the task register at ${zone.minute(now)}.`,
    ...(fit.length === 0 ? [] : ['', ...fit.map((line) => `- ${line}`)]),
  ];
  const sliced = bySlice === undefined ? { lines: [], placed: new Set<string>() } : sliceSections(bySlice, planned, zone.day(now), (task) => planLine(task, ranking.ownerSource, tree, team));
  lines.push(...sliced.lines);
  const inWeek = planned.filter((task) => !sliced.placed.has(task.id));
  for (const band of BANDS) {
    const rows = inWeek.filter((task) => tree.rankedOf(task)?.band === band);
    if (rows.length > 0) {
      lines.push('', `## ${bandHeading(band, ranking.focus)}`, '', ...rows.map((task) => planLine(task, ranking.ownerSource, tree, team)));
    }
  }
  return lines.join('\n');
}

/** A slice's heading: its label and title, then its owner, ship day, size, proof and whether it shipped or is late. */
function sliceHeading(tag: string, slice: Slice, today: string): string {
  const state = slice.proven !== null ? `shipped: ${slice.proven.evidence}` : isLate(slice, today) ? '**late**, not proven' : 'not proven yet';
  const size = slice.size === null ? [] : [`size ${sizeText(slice.size)}`];
  const meta = [slice.owner, `ships ${slice.ship}`, ...size, `proof: ${slice.proof}`, state];
  return `### ${sliceLabel(tag, slice.number)} ${slice.title} (${meta.join(' · ')})`;
}

/**
 * The `## Slices` section of a plan by slice: each goal's slices, in goal rank order, that are not proven yet or have
 * a task in the week, each heading the week's tasks that make it, in plan order, and naming the rest of its tasks; and
 * which week tasks it placed, so the bands hold only the others.
 */
function sliceSections(
  goals: ReadonlyMap<string, Goal>,
  planned: readonly Task[],
  today: string,
  line: (task: Task) => string,
): { readonly lines: string[]; readonly placed: ReadonlySet<string> } {
  const placed = new Set<string>();
  const lines: string[] = [];
  for (const goal of goalsInRankOrder(goals)) {
    for (const slice of goal.slices) {
      const rows = planned.filter((task) => slice.tasks.includes(task.id) && !placed.has(task.id));
      if (rows.length === 0 && slice.proven !== null) {
        continue;
      }
      rows.forEach((task) => placed.add(task.id));
      const outside = slice.tasks.filter((id) => !rows.some((task) => task.id === id));
      lines.push('', sliceHeading(goal.tag, slice, today), '', ...rows.map(line), ...(outside.length === 0 ? [] : [`- not in this week's plan: ${outside.join(', ')}`]));
    }
  }
  return { lines: lines.length === 0 ? ['', '## Slices', '', 'No slice records: the lead adds one with goal slice.'] : ['', '## Slices', ...lines], placed };
}

function planLine(task: Task, ownerSource: string, tree: TaskTree, team: string | undefined): string {
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
