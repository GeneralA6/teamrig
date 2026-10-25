import { MS_PER_DAY } from '../core/time.ts';
import { cardLines, cardTexts, GATE_FLAG, namedTaskIds } from '../register/card.ts';
import { isUngated } from '../register/check.ts';
import type { Task } from '../register/fold.ts';
import { ACTIVE_STATUSES } from '../register/model.ts';
import type { TaskTree } from '../register/tree.ts';
import { cut, formatShortTask } from '../register/views.ts';

/**
 * The register's part of the daily meeting's agenda, gathered in one call so the lead spends no turn per item:
 * the owner's decisions as card facts, the late tasks and what finished since the meeting before. The CLI adds
 * the lead's inbox and the week's use and fit (src/cli/commands/meeting.ts).
 */

/** Each list shows at most this many rows, then a `+N more` line with the command that lists them all. */
export const AGENDA_ROWS = 10;
/** A row cuts the task title to this many characters, as the short `list` does. */
export const TITLE_CHARS = 60;
/** A card cuts a task's description and its newest note to these many characters; `show <id>` prints them whole. */
export const DESCRIPTION_CHARS = 400;
export const NOTE_CHARS = 200;
/**
 * The finished work goes back at most this many days, inside the working set's finished tasks (a compaction
 * keeps them 8 days, src/register/compaction.ts), so the agenda never reads the whole history.
 */
export const DONE_WINDOW_DAYS = 7;

/** When the agenda's finished work starts: the meeting before's end, else a day back, and never past DONE_WINDOW_DAYS. */
export function agendaSince(previousEnd: number | undefined, now: number): number {
  return Math.max(previousEnd ?? now - MS_PER_DAY, now - DONE_WINDOW_DAYS * MS_PER_DAY);
}

/** Whether a task waits for a decision or an approval from the owner: a waiting one, or a verifying one's proof. */
export function waitsOnOwner(task: Task, ownerMarker: string): boolean {
  return task.waits.some((reason) => (reason.kind === 'decision' || reason.kind === 'approval') && reason.who === ownerMarker);
}

/**
 * Whether the lead asks the owner a task's wait: it waits on the owner (waitsOnOwner) and, while `requireGate`
 * (`register.requireDecisionCard`) is on, is not ungated (isUngated, T1194): an ungated one is its session's or its
 * leader's to decide, so neither the agenda's DECISIONS nor a decision batch holds it.
 */
export function asksOwner(task: Task, ownerMarker: string, requireGate: boolean): boolean {
  return waitsOnOwner(task, ownerMarker) && !(requireGate && isUngated(task, ownerMarker));
}

export interface AgendaInput {
  readonly tasks: readonly Task[];
  /** The dependency tree of the same read: effective dues, ready reasons and what needs each task. */
  readonly tree: TaskTree;
  readonly now: number;
  /** When the finished work starts (agendaSince). */
  readonly since: number;
  /** The register's marker for the owner (`register.ownerSource`), which a decision or approval reason names. */
  readonly ownerMarker: string;
  /** `register.requireDecisionCard`: a wait on the owner's decision names its gate, so an ungated one leaves DECISIONS. */
  readonly requireGate: boolean;
  /** The lead's session id, which records the decisions. */
  readonly lead: string;
  readonly command: string;
}

/** Text on one line: line breaks and runs of spaces become one space. */
export function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function rowOf(task: Task, tree: TaskTree): string {
  return `  ${formatShortTask(task, TITLE_CHARS, undefined, tree)}`;
}

/** A list's heading, its first AGENDA_ROWS rows and a `+N more` line naming the command that lists them all. */
function listed(head: string, rows: readonly string[], all: string): string[] {
  const more = rows.length > AGENDA_ROWS ? [`  +${rows.length - AGENDA_ROWS} more: ${all}`] : [];
  return [head, ...rows.slice(0, AGENDA_ROWS), ...more];
}

/**
 * Each other task a decision's texts name, by its title, so no number stands alone: `T5: <title>`, or
 * `T5: not in the working set` for one a compaction retired (`show T5` still finds it in the archive).
 */
function namedLines(task: Task, texts: readonly string[], byId: ReadonlyMap<string, Task>): string[] {
  return namedTaskIds(texts)
    .filter((id) => id !== task.id)
    .map((id) => {
      const named = byId.get(id);
      return `    ${id}: ${named === undefined ? 'not in the working set' : cut(oneLine(named.title), TITLE_CHARS)}`;
    });
}

/**
 * A decision's card facts: its row, then what and why, then its card (card.ts) or that it has none, then since when
 * it waits with its newest note, where it was asked, and the title of each other task these name.
 */
export function cardFacts(task: Task, tree: TaskTree, byId: ReadonlyMap<string, Task>): string[] {
  const note = task.note === null ? '' : `: ${cut(oneLine(task.note), NOTE_CHARS)}`;
  const texts = [task.title, task.description ?? '', task.note ?? '', ...(task.card === null ? [] : cardTexts(task.card))];
  return [
    rowOf(task, tree),
    ...(task.description === null ? [] : [`    what and why: ${cut(oneLine(task.description), DESCRIPTION_CHARS)}`]),
    ...(task.card === null ? [`    no card yet: ask ${task.owner} for one (check flags it NO-CARD)`] : cardLines(task.card, '    ')),
    `    waiting since ${tree.zone.shortMinute(new Date(task.statusAt))}${note}`,
    ...(task.ref === null ? [] : [`    asked at: ${task.ref}`]),
    ...namedLines(task, texts, byId),
  ];
}

/**
 * DECISIONS: the tasks waiting on the owner, each with its card facts, then how to card and record them. The
 * card form is the owner's: each item readable alone, with the numbers to decide by and one exact action.
 */
function decisionLines(input: AgendaInput): string[] {
  const waiting = input.tree.inPlanOrder(input.tasks.filter((task) => asksOwner(task, input.ownerMarker, input.requireGate)));
  const head = `DECISIONS ${waiting.length} waiting on ${input.ownerMarker} (decision or approval)`;
  if (waiting.length === 0) {
    return [head];
  }
  return [
    head,
    ...waiting.flatMap((task) => cardFacts(task, input.tree, new Map(input.tasks.map((other) => [other.id, other])))),
    `  Read each card to ${input.ownerMarker} as it stands, each figure explained; where one says no card yet, ask its owner for it (check flags it NO-CARD). Never point to a doc; \`${input.command} show <id>\` prints a task whole.`,
    `  A question a card does not answer is its task owner's to find: ${input.command} add --owner <id> --due <date> --session ${input.lead}, then relay the answer; never look it up yourself.`,
    `  Record each answer in the same turn: ${input.command} update <id> --note "${input.ownerMarker} decided: <decision>" --session ${input.lead}; meeting end tells each task's owner.`,
  ];
}

/**
 * UNGATED: the waits on the owner's decision whose card names no owner gate or business decision (isUngated), each
 * its session's or its leader's to decide, so the lead never reads one out; none while `requireGate` is off, and
 * no block when none waits.
 */
function ungatedLines(input: AgendaInput): string[] {
  const ungated = input.requireGate ? input.tree.inPlanOrder(input.tasks.filter((task) => isUngated(task, input.ownerMarker))) : [];
  if (ungated.length === 0) {
    return [];
  }
  return [
    ...listed(
      `UNGATED ${ungated.length} waiting on ${input.ownerMarker}'s decision with no gate: never read to ${input.ownerMarker}`,
      ungated.map((task) => rowOf(task, input.tree)),
      `${input.command} check`,
    ),
    `  Each is its session's or its leader's to decide: decide those of the sessions you lead and send each its answer as an inbox line; where an owner gate or a business decision does apply, its owner sets it again with ${GATE_FLAG} "<the owner gate, or business>".`,
  ];
}

/** LATE: the active tasks past their effective due date (their own, or an earlier one of a task that needs them), in plan order. */
function lateLines(input: AgendaInput): string[] {
  const { tree } = input;
  const late = tree.inPlanOrder(input.tasks.filter((task) => ACTIVE_STATUSES.includes(task.status) && (tree.dueTime(task) ?? Number.POSITIVE_INFINITY) < input.now));
  return listed(
    `LATE ${late.length} past their due date`,
    late.map((task) => rowOf(task, tree)),
    `${input.command} check`,
  );
}

/** DONE: the tasks done or dropped since the agenda's start, in plan order. */
function doneLines(input: AgendaInput): string[] {
  const done = input.tree.inPlanOrder(input.tasks.filter((task) => (task.status === 'done' || task.status === 'dropped') && Date.parse(task.statusAt) >= input.since));
  return listed(
    `DONE ${done.length} done or dropped since ${input.tree.zone.weekdayMinute(new Date(input.since))}`,
    done.map((task) => rowOf(task, input.tree)),
    `${input.command} list --status done,dropped`,
  );
}

/**
 * The register's agenda: the owner's decisions first, as they are what the meeting is for, then the ungated waits
 * that are not, then the late tasks, then the finished ones.
 */
export function agendaLines(input: AgendaInput): string[] {
  return [...decisionLines(input), ...ungatedLines(input), ...lateLines(input), ...doneLines(input)];
}
