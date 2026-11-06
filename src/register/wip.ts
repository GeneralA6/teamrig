import type { FocusConfig } from '../config/types.ts';
import { canMove } from './can-move.ts';
import type { Task } from './fold.ts';
import { classOf } from './focus.ts';
import type { TaskStatus } from './model.ts';
import { bandOf } from './score.ts';
import type { WaitContext } from './waits.ts';

/**
 * The WIP rule (T2076): a session finishes what the team ranked first before it opens more. A start of anything but
 * Roadmap or Maintenance work is held while its owner holds Roadmap work that can move, or until the week resets once
 * its class has spent its share of the week, and any start is held past `focus.wip.maxInProgress`, as work spread over
 * many tasks finishes none of them.
 */

/** How many tasks a hold names before it counts the rest. */
const NAMED_TASKS = 3;

/** The way past a hold for work too small to reorder a list over, core rule 5's exemption. */
const ONE_COMMIT_WAY = 'or, for a one-commit fix, start it with --one-commit';

/** The part of the `focus` config the rule reads. */
export type WipFocus = Pick<FocusConfig, 'roadmapClass' | 'maintenanceClass' | 'defaultClass' | 'expedite' | 'wip'>;

/** The status change the rule judges: the task as it stands, the status asked for, and whether `--one-commit` came with it. */
export interface WipStart {
  readonly task: Task;
  readonly status: TaskStatus;
  readonly oneCommit?: boolean;
  /** The classes that have spent their share of the week (budget/class-spend.ts); none given holds nothing for it. */
  readonly spentClasses?: ReadonlySet<string>;
}

/** Roadmap work its owner can take up now: open or in progress, with nothing holding it back. */
function movesNow(task: Task, context: WaitContext): boolean {
  return (task.status === 'open' || task.status === 'in-progress') && canMove(task, context);
}

/** An owner's order and an expedite outrank any rule of thumb about what to do first. */
function isExempt(task: Task, workClass: string, focus: WipFocus, ownerSource: string): boolean {
  const ownerSourced = task.source === ownerSource;
  return ownerSourced || bandOf({ workClass, critical: task.critical, priority: task.priority, ownerSourced }, focus) === 0;
}

/** `T1, T2, T3 and 2 more`. */
function namedIds(tasks: readonly Task[]): string {
  const named = tasks.slice(0, NAMED_TASKS).map((task) => task.id);
  return tasks.length > NAMED_TASKS ? `${named.join(', ')} and ${tasks.length - NAMED_TASKS} more` : named.join(', ');
}

/**
 * Why a move into in-progress may not happen now, for the refusal or the warning; undefined when nothing holds it.
 * Setting a task in progress again moves nothing, so it is never held. Every other way into in-progress is held the
 * same, a reopen too: its owner's list says what comes first, and `--one-commit` is the way past for a small fix.
 */
export function wipHold({ task, status, oneCommit, spentClasses }: WipStart, tasks: Iterable<Task>, context: WaitContext, focus: WipFocus, ownerSource: string): string | undefined {
  const workClass = classOf(task, focus);
  if (focus.wip.mode === 'off' || status !== 'in-progress' || task.status === 'in-progress' || oneCommit === true || isExempt(task, workClass, focus, ownerSource)) {
    return undefined;
  }
  const others = [...tasks].filter((held) => held.owner === task.owner && held.id !== task.id);
  if (workClass !== focus.roadmapClass && workClass !== focus.maintenanceClass) {
    if (spentClasses?.has(workClass) === true) {
      return `${task.id} is ${workClass} work and ${workClass} has spent its share of the week [focus.allocation]: it waits for the week's reset, ${ONE_COMMIT_WAY}`;
    }
    const first = others.filter((held) => classOf(held, focus) === focus.roadmapClass && movesNow(held, context));
    if (first.length > 0) {
      return `${task.id} is ${workClass} work and ${task.owner} holds ${focus.roadmapClass} work that can move: ${namedIds(first)}; work that first [focus.wip], ${ONE_COMMIT_WAY}`;
    }
  }
  const started = others.filter((held) => held.status === 'in-progress');
  const max = focus.wip.maxInProgress;
  return started.length < max
    ? undefined
    : `${task.owner} already has ${started.length} tasks in progress, at the limit of ${max} [focus.wip.maxInProgress]: finish ${namedIds(started)} or put one back (--status open) before ${task.id}, ${ONE_COMMIT_WAY}`;
}
