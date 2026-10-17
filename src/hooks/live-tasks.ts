import { shortUtc } from '../core/time.ts';
import type { Task } from '../register/fold.ts';
import { ACTIVE_STATUSES, priorityText, type TaskStatus } from '../register/model.ts';
import { byPlanOrder, cut } from '../register/views.ts';
import { unfinishedAfter, waitsText, type WaitContext } from '../register/waits.ts';

/**
 * The live-task block of the SessionStart note. A handover is written before the fresh start that reads it, and a
 * compaction summary retells the old context, so both can name a status, a wait or a due date that has since moved;
 * the block reads them from the register at the start itself, so the session never works from a stale one.
 */

/** The most task rows the block prints; the rest is one `+N more` line, so the note stays short whatever the session holds. */
export const LIVE_TASK_ROWS = 6;
/** A row cuts the task title to this many characters. */
export const LIVE_TITLE_CHARS = 60;
/** A waiting task with no reasons (one set before reasons existed) shows its note instead, cut to this many characters. */
const LIVE_NOTE_CHARS = 60;

/** Work in hand first, then what waits, then what is not started: the rows a fresh start takes over lead. */
const LIVE_ORDER: readonly TaskStatus[] = ['in-progress', 'verifying', 'waiting', 'open'];

/** Claude Code's SessionStart source after a compaction (proven on 2.1.302, T444). */
export const COMPACT_SOURCE = 'compact';

/**
 * Whether a start shows the block: the fresh start a refresh handover was written for (`refreshed`), and a start after
 * a compaction. Any other start keeps its context (resume) or begins a work block whose `start` lists the tasks.
 */
export function showsLiveTasks(source: string | undefined, refreshed: boolean): boolean {
  return refreshed || source === COMPACT_SOURCE;
}

function byLiveOrder(a: Task, b: Task): number {
  return LIVE_ORDER.indexOf(a.status) - LIVE_ORDER.indexOf(b.status) || byPlanOrder(a, b);
}

/** What a waiting task waits on: its reasons, ready ones marked; for a task without reasons, its note. */
function waitingText(task: Task, context: WaitContext): string {
  if (task.status !== 'waiting') {
    return '';
  }
  if (task.waits.length > 0) {
    return ` (waiting: ${waitsText(task.waits, context)})`;
  }
  return task.note === null ? '' : ` (waiting: ${cut(task.note, LIVE_NOTE_CHARS)})`;
}

/** `  T12 in-progress, p2, due 01-15, after T5 | <title> (waiting: on T5 ready)`: only the plan dependencies not finished yet. */
function liveRow(task: Task, context: WaitContext): string {
  const parts = [`${task.id} ${task.status}`, priorityText(task.priority)];
  if (task.due !== null) {
    parts.push(`due ${shortUtc(task.due)}`);
  }
  const after = unfinishedAfter(task.after, context);
  if (after.length > 0) {
    parts.push(`after ${after.join(',')}`);
  }
  return `  ${parts.join(', ')} | ${cut(task.title, LIVE_TITLE_CHARS)}${waitingText(task, context)}`;
}

export interface LiveTasksInput {
  /** Every task of the register read; the block keeps the owner's active ones. */
  readonly tasks: Iterable<Task>;
  /** The session whose tasks these are. */
  readonly owner: string;
  /** The read that judges which wait reasons are ready and which plan dependencies are finished. */
  readonly context: WaitContext;
  /** The CLI name the `+N more` line tells the session to run. */
  readonly command: string;
}

/**
 * The block: a heading that says the register wins over the handover and a compaction summary, then the owner's
 * active tasks (work in hand first, then plan order), at most LIVE_TASK_ROWS of them and a `+N more` line naming
 * the command that lists the rest; one line when the owner has none.
 */
export function liveTasksNote({ tasks, owner, context, command }: LiveTasksInput): string {
  const active = [...tasks].filter((task) => task.owner === owner && ACTIVE_STATUSES.includes(task.status)).sort(byLiveOrder);
  const source = `LIVE TASKS of ${owner}, read from the register at this start`;
  const wins = 'where your handover or a compaction summary says otherwise, the register wins';
  if (active.length === 0) {
    return `${source}: none active; ${wins}.`;
  }
  const rows = active.slice(0, LIVE_TASK_ROWS).map((task) => liveRow(task, context));
  const left = active.length - rows.length;
  const more = left > 0 ? [`  +${left} more: \`${command} list --session ${owner}\``] : [];
  return [`${source} (${active.length} active; ${wins}):`, ...rows, ...more].join('\n');
}
