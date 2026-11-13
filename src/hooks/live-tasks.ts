import { showStored } from '../core/time.ts';
import { BLOCK_START_WORDS } from '../core/work-block.ts';
import type { Task } from '../register/fold.ts';
import { ACTIVE_STATUSES, priorityText, type TaskStatus } from '../register/model.ts';
import type { TaskTree, WaitingOnYou } from '../register/tree.ts';
import { cut, formatWaitingOnYou, rankParts } from '../register/views.ts';
import { unfinishedAfter, waitsText, type WaitContext } from '../register/waits.ts';

/**
 * The live-task block of the SessionStart note. A handover is written before the fresh start that reads it, and a
 * compaction summary retells the old context, so both can name a status, a wait or a due date that has since moved;
 * the block reads them from the register at the start itself, so the session never works from a stale one. With
 * `start`'s own first lines before it (blockStartLines), the block is the work block's start (T1529).
 */

/** The most task rows the block prints; the rest is one `+N more` line, so the note stays short whatever the session holds. */
export const LIVE_TASK_ROWS = 6;
/** A row cuts the task title to this many characters. */
export const LIVE_TITLE_CHARS = 60;
/** The most rows of other sessions' tasks waiting on the owner; the rest is one `+N more` line naming `start`. */
export const LIVE_WAITING_ROWS = 3;
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

/** Work in hand first (LIVE_ORDER), then plan order on effective dues. */
function byLiveOrder(tree: TaskTree): (a: Task, b: Task) => number {
  return (a, b) => LIVE_ORDER.indexOf(a.status) - LIVE_ORDER.indexOf(b.status) || tree.byPlanOrder(a, b);
}

/** What a waiting task waits on: its reasons, ready ones marked; for a task without reasons, its note. */
function waitingText(task: Task, context: WaitContext): string {
  if (task.status !== 'waiting') {
    return '';
  }
  if (task.waits.length > 0) {
    return ` (waiting: ${waitsText(task.waits, context.zone, context)})`;
  }
  return task.note === null ? '' : ` (waiting: ${cut(task.note, LIVE_NOTE_CHARS)})`;
}

/**
 * `  T12 in-progress, Roadmap, score 6.67, p2, due 01-15 (from T20), after T5 | <title> (waiting: on T5 ready)`: the
 * class and score when the tree ranks, as `list` prints them, the effective due, naming the task it comes from when
 * another task's earlier date holds this one, and only the plan dependencies not finished yet.
 */
function liveRow(task: Task, tree: TaskTree): string {
  const parts = [`${task.id} ${task.status}`, ...rankParts(task, tree), priorityText(task.priority)];
  const due = tree.effectiveDue(task.id);
  if (due !== undefined) {
    parts.push(`due ${showStored(due.due, tree.zone)}${due.from === null ? '' : ` (from ${due.from})`}`);
  }
  const after = unfinishedAfter(task.after, tree.context);
  if (after.length > 0) {
    parts.push(`after ${after.join(',')}`);
  }
  return `  ${parts.join(', ')} | ${cut(task.title, LIVE_TITLE_CHARS)}${waitingText(task, tree.context)}`;
}

/**
 * `WAITING ON YOU 2 task(s) of other sessions:` and a row each: the active tasks of other sessions that need the
 * owner's unfinished tasks or wait on its decision or approval, in the order given, at most LIVE_WAITING_ROWS of them
 * and a `+N more` line naming `start`; nothing when none waits.
 */
function waitingLines(owner: string, waiting: readonly WaitingOnYou[], tree: TaskTree, command: string): string[] {
  if (waiting.length === 0) {
    return [];
  }
  const rows = waiting.slice(0, LIVE_WAITING_ROWS).map((entry) => `  ${formatWaitingOnYou(entry, LIVE_TITLE_CHARS, tree)}`);
  const left = waiting.length - rows.length;
  const more = left > 0 ? [`  +${left} more: \`${command} start --session ${owner} --all\``] : [];
  return [`WAITING ON YOU ${waiting.length} task(s) of other sessions:`, ...rows, ...more];
}

export interface LiveTasksInput {
  /** Every task of the register read; the block keeps the owner's active ones. */
  readonly tasks: Iterable<Task>;
  /** The session whose tasks these are. */
  readonly owner: string;
  /** The dependency tree of the same read: which wait reasons are ready and which plan dependencies are finished, and each task's effective due. */
  readonly tree: TaskTree;
  /** The other sessions' tasks waiting on the owner, in the order the block lists them. */
  readonly waiting: readonly WaitingOnYou[];
  /** The CLI name the `+N more` line tells the session to run. */
  readonly command: string;
}

/**
 * The block: a heading that says the register wins over the handover and a compaction summary, then the owner's
 * active tasks (work in hand first, then plan order on effective dues), at most LIVE_TASK_ROWS of them and a
 * `+N more` line naming the command that lists the rest (one line when the owner has none), then the other
 * sessions' tasks waiting on the owner, when some do.
 */
export function liveTasksNote({ tasks, owner, tree, waiting, command }: LiveTasksInput): string {
  const active = [...tasks].filter((task) => task.owner === owner && ACTIVE_STATUSES.includes(task.status) && !tree.isParked(task)).sort(byLiveOrder(tree));
  const source = `LIVE TASKS of ${owner}, read from the register at this start`;
  const wins = 'where your handover or a compaction summary says otherwise, the register wins';
  const waitingRows = waitingLines(owner, waiting, tree, command);
  if (active.length === 0) {
    return [`${source}: none active; ${wins}.`, ...waitingRows].join('\n');
  }
  const rows = active.slice(0, LIVE_TASK_ROWS).map((task) => liveRow(task, tree));
  const left = active.length - rows.length;
  const more = left > 0 ? [`  +${left} more: \`${command} list --session ${owner}\``] : [];
  return [`${source} (${active.length} active; ${wins}):`, ...rows, ...more, ...waitingRows].join('\n');
}

/** What `start` prints before the task list, read at the start whose note carries the live-task block (T1529). */
export interface BlockStart {
  /** The start's time on the team's clock, as `start` prints it: `Sat 10-31 12:51 IST`. */
  readonly at: string;
  /** `start`'s MEETINGS line (cli/commands/meetings.ts startMeetingLine); undefined when no meeting is due today. */
  readonly meetings: string | undefined;
  /** `start`'s week line (budget/report.ts weekLine), from the week as last stored; undefined when it could not be read. */
  readonly week: string | undefined;
  /** The lead's resets line (budget/resets.ts resetSummaryLine); absent for any other session or with no grants. */
  readonly resets?: string;
}

/**
 * The lines before the live-task block that make the note the session's work-block start (T1529): `start`'s first line
 * and what it means, its MEETINGS line when there is one, its week line and the lead's resets line. A refreshed or compacted session ran
 * `start` right after the note in 4 of 5 starts (T1379), re-reading its whole context for what the note already holds;
 * `start` adds only the check flags and the list past the block's rows, so it waits for the next work block.
 */
export function blockStartLines(owner: string, start: BlockStart, command: string): string[] {
  const counts = `${BLOCK_START_WORDS}, so run no \`${command} start\` now; it would add only the check flags and the rest of the list (run it at your next work block)`;
  return [`START ${owner}, ${start.at}: ${counts}.`, ...(start.meetings === undefined ? [] : [start.meetings]), ...(start.week === undefined ? [] : [start.week]), ...(start.resets === undefined ? [] : [start.resets])];
}

/** The block's one line when the start note has no room for it (T1376): the command that prints it, run first. */
export function liveTasksPointer(owner: string, command: string): string {
  return `LIVE TASKS of ${owner}: this start has no room for them; run \`${command} start --session ${owner}\` first, and where your handover or a compaction summary says otherwise, the register wins.`;
}
