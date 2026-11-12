import type { Weekday } from '../config/types.ts';
import { MS_PER_DAY } from '../core/time.ts';
import { cardLines, cardTexts, GATE_FLAG, namedTaskIds } from '../register/card.ts';
import type { RunFiles } from '../register/hand-step.ts';
import { doneGroups, doneGroupTitle } from '../register/done-groups.ts';
import type { Task } from '../register/fold.ts';
import { isLate, type GoalScore } from '../register/goal-board.ts';
import { ACTIVE_STATUSES } from '../register/model.ts';
import { asksOwner, isDedicated, isUngated, ownerLater } from '../register/owner-waits.ts';
import type { TaskTree } from '../register/tree.ts';
import { cut, formatShortTask } from '../register/views.ts';
import { decisionOrder, isImprovementsDay, type Decision, type DecisionFocus, type DecisionRead } from './decision-order.ts';

/**
 * The register's part of the daily meeting's agenda, gathered in one call so the lead spends no turn per item, in the
 * order the meeting works through it (T2076 2D): the goal scoreboard, the owner's decisions as card facts, ranked by
 * what they unblock, the Maintenance incidents, then the waits nobody reads out, the late tasks and what finished since
 * the meeting before, in the done groups (src/register/done-groups.ts). The CLI hands it the scoreboard's rows, and adds
 * the stats' top lines, the lead's inbox and the week's use and fit below it (src/cli/commands/meeting.ts).
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
 * keeps them 8 days, src/register/compaction.ts), so the DONE block needs no read of the whole history.
 */
export const DONE_WINDOW_DAYS = 7;

/** When the agenda's finished work starts: the meeting before's end, else a day back, and never past DONE_WINDOW_DAYS. */
export function agendaSince(previousEnd: number | undefined, now: number): number {
  return Math.max(previousEnd ?? now - MS_PER_DAY, now - DONE_WINDOW_DAYS * MS_PER_DAY);
}

/** A register under the lead's team, whose waits on the owner the lead asks too (T1018), read on its own clock and config. */
export interface AgendaTeam {
  readonly team: string;
  readonly tasks: readonly Task[];
  readonly tree: TaskTree;
  readonly ownerMarker: string;
  readonly requireGate: boolean;
  /** Its own class names, which its decisions and incidents read. */
  readonly focus: DecisionFocus;
  /** Its `decisions.dedicatedOwners`: their waits go to DEDICATED, not to the cards (T868). */
  readonly dedicatedOwners: readonly string[];
}

/** A register the agenda reads the owner's waits of: the lead's own (AgendaInput) or one under it (AgendaTeam). */
type AgendaRegister = Omit<AgendaTeam, 'team'>;

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
  /** The registers of every team under the lead's, depth first: a child team's waits on the owner go up to the lead at its tree's root. */
  readonly below: readonly AgendaTeam[];
  /** The lead's session id, which records the decisions. */
  readonly lead: string;
  readonly command: string;
  /** The ranked goals' rows, best rank first (goalScores). */
  readonly board: readonly GoalScore[];
  /** The team's class names, handed in as a tree keeps its ranking to itself. */
  readonly focus: DecisionFocus;
  /** `decisions.dedicatedOwners`: the sessions whose waits on the owner go to DEDICATED, not to the cards (T868). */
  readonly dedicatedOwners: readonly string[];
  /** `focus.improvementsDay`: the UTC weekday the Improvements batch is asked. */
  readonly improvementsDay: Weekday;
  /** What the hand step file of each card asked, the lead's team's and those under it, hashes to now (T2312). */
  readonly runFiles: RunFiles;
}

/** Text on one line: line breaks and runs of spaces become one space. */
export function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function rowOf(task: Task, tree: TaskTree, team?: string): string {
  return `  ${formatShortTask(task, TITLE_CHARS, team, tree)}`;
}

/** A list's heading, its first AGENDA_ROWS rows and a `+N more` line naming the command that lists them all. */
export function listed(head: string, rows: readonly string[], all: string): string[] {
  const more = rows.length > AGENDA_ROWS ? [`  +${rows.length - AGENDA_ROWS} more: ${all}`] : [];
  return [head, ...rows.slice(0, AGENDA_ROWS), ...more];
}

/**
 * Each other task a decision's texts name, by its title, so no number stands alone: `T5: <title>` (`web/T5` for
 * another team's), or `T5: not in the working set` for one a compaction retired (`show T5` still finds it in the archive).
 */
function namedLines(task: Task, texts: readonly string[], tree: TaskTree, team: string | undefined): string[] {
  return namedTaskIds(texts)
    .filter((id) => id !== task.id)
    .map((id) => {
      const named = tree.task(id);
      return `    ${team === undefined ? id : `${team}/${id}`}: ${named === undefined ? 'not in the working set' : cut(oneLine(named.title), TITLE_CHARS)}`;
    });
}

/** The line of a decision with no card: its owner is asked for one, through its team's lead for another team's. */
function noCardLine(task: Task, team: string | undefined): string {
  return team === undefined
    ? `    no card yet: ask ${task.owner} for one (check flags it NO-CARD)`
    : `    no card yet: ${task.owner} owes one, and team ${team}'s check flags it NO-CARD to its lead`;
}

/**
 * A decision's card facts: its row, then what and why, then its card (card.ts) or that it has none, then since when
 * it waits with its newest note, where it was asked, and the title of each other task these name. `tree` is the read
 * of the register that holds the task, `runFiles` what its card's hand step file hashes to now, and `team` names that
 * register when it is another team's (`web/T5`).
 */
export function cardFacts(task: Task, tree: TaskTree, runFiles: RunFiles, team?: string): string[] {
  const note = task.note === null ? '' : `: ${cut(oneLine(task.note), NOTE_CHARS)}`;
  const texts = [task.title, task.description ?? '', task.note ?? '', ...(task.card === null ? [] : cardTexts(task.card))];
  return [
    rowOf(task, tree, team),
    ...(task.description === null ? [] : [`    what and why: ${cut(oneLine(task.description), DESCRIPTION_CHARS)}`]),
    ...(task.card === null ? [noCardLine(task, team)] : cardLines(task.card, '    ', task.audits, runFiles)),
    `    waiting since ${tree.zone.shortMinute(new Date(task.statusAt))}${note}`,
    ...(task.ref === null ? [] : [`    asked at: ${task.ref}`]),
    ...namedLines(task, texts, tree, team),
  ];
}

/** A register's tasks the lead asks the owner now (asksOwner), in its plan order. */
function ownerAsks({ tasks, tree, ownerMarker, requireGate }: AgendaRegister): Task[] {
  return tree.inPlanOrder(tasks.filter((task) => asksOwner(task, ownerMarker, requireGate, tree.context)));
}

/** A register's tasks the lead asks the owner now as cards: all but the dedicated ones; `team` labels a register under the lead's. */
function decisionRead(register: AgendaRegister, team: string | undefined): DecisionRead {
  const tasks = ownerAsks(register).filter((task) => !isDedicated(task, register.dedicatedOwners));
  return { tasks, tree: register.tree, team, focus: register.focus };
}

function cardsOf(decisions: readonly Decision[], runFiles: RunFiles): string[] {
  return decisions.flatMap(({ task, tree, team }) => cardFacts(task, tree, runFiles, team));
}

/**
 * How the lead, or a session `meet` brings to the owner (src/meeting/meet.ts), asks the owner the cards it read: in
 * plain text, the owner answering in their own words (T1278); the picker guard refuses the question picker (T2256).
 */
export function askLine(ownerMarker: string): string {
  return `  Ask in plain text, never with the question picker: each card's options numbered, your recommendation first; ${ownerMarker} answers in their own words.`;
}

/**
 * How the lead records a card the owner puts off to a date, in place of an answer (T1295); `until` says where it waits
 * meanwhile: the agenda's LATER block, or out of the batches.
 */
export function laterLine(command: string, ownerMarker: string, lead: string, until: string): string {
  return `  A card ${ownerMarker} puts off to a date: ${command} update <id> --later <date> --note "${ownerMarker} put it off: <why>" --session ${lead}; ${until}.`;
}

/** What the agenda reads the owner's decisions from: the lead's register, those under it, and the day for the batch. */
export type DecisionAgenda = AgendaRegister & Pick<AgendaInput, 'below' | 'now' | 'improvementsDay'>;

/**
 * The cards the agenda asks today, in its order: the daily ones, then the Improvements batch on its weekday (empty on
 * the others). The meeting's agenda panel lists the same cards in the same order (src/meeting/panel.ts).
 */
export function askedDecisions(input: DecisionAgenda): { readonly daily: readonly Decision[]; readonly batch: readonly Decision[] } {
  const order = decisionOrder([decisionRead(input, undefined), ...input.below.map((team) => decisionRead(team, team.team))]);
  return { daily: order.daily, batch: isImprovementsDay(input.now, input.improvementsDay) ? order.improvements : [] };
}

/**
 * DECISIONS: the tasks waiting on the owner, the lead's team's and those of each team under it (T1018) in one list
 * ranked by what they unblock (decisionOrder), a tie keeping the lead's team first, each with its card facts, then how
 * to card, ask and record them. A decision that frees only Improvements work is asked in its weekly batch, after the
 * daily cards, and no other day shows it. The card form is the owner's: each item readable alone, with the numbers to
 * decide by and one exact action.
 */
function decisionLines(input: AgendaInput): string[] {
  const { daily, batch } = askedDecisions(input);
  const asked = [...daily, ...batch];
  const head = `DECISIONS ${asked.length} waiting on ${input.ownerMarker} (decision or approval)`;
  if (asked.length === 0) {
    return [head];
  }
  const below = asked.some((decision) => decision.team !== undefined);
  const labelled = below ? ' (<team>/<id> for a task of a team under yours, as its row names it)' : '';
  const handed = below ? ' (and --team <team> for a team under yours)' : '';
  return [
    head,
    ...cardsOf(daily, input.runFiles),
    ...(batch.length === 0 ? [] : [`  Improvements batch ${batch.length}, weekly, after the daily cards:`, ...cardsOf(batch, input.runFiles)]),
    `  Read each card to ${input.ownerMarker} as it stands, each figure explained; where one says no card yet, ask its owner for it (check flags it NO-CARD). Never point to a doc; \`${input.command} show <id>\` prints a task whole.`,
    askLine(input.ownerMarker),
    `  A question a card does not answer is its task owner's to find: ${input.command} add --owner <id>${handed} --due <date> --session ${input.lead}, then relay the answer; never look it up yourself.`,
    `  Record each answer in the same turn: ${input.command} update <id>${labelled} --decided --note "${input.ownerMarker} decided: <decision>" --session ${input.lead}; the card leaves the agenda, and meeting end tells each task's owner.`,
    laterLine(input.command, input.ownerMarker, input.lead, 'it waits in LATER until then'),
  ];
}

/** One owning session's dedicated decisions (T868), in its register's plan order; `team` names a register under the lead's. */
interface DedicatedGroup {
  readonly owner: string;
  readonly team: string | undefined;
  readonly tasks: readonly Task[];
  readonly tree: TaskTree;
}

/** A register's dedicated decisions by owning session, the session whose decision comes first in its plan order first. */
function dedicatedGroups(register: AgendaRegister, team: string | undefined): DedicatedGroup[] {
  const byOwner = new Map<string, Task[]>();
  for (const task of ownerAsks(register).filter((task) => isDedicated(task, register.dedicatedOwners))) {
    byOwner.set(task.owner, [...(byOwner.get(task.owner) ?? []), task]);
  }
  return [...byOwner].map(([owner, tasks]) => ({ owner, team, tasks, tree: register.tree }));
}

/**
 * A group's rows, then its two lines: `brief:`, the owner's task asking the session for the full brief by the slot,
 * and `book:`, the scheduled meeting at that slot (`meeting schedule`), which notifies at its time, lists on the
 * agenda's MEETINGS and shows missed once past it, so no one has to remember the slot. `meeting schedule` books in its
 * caller's own team, so a team under the lead's books it from that team's lead.
 */
function dedicatedGroupLines(group: DedicatedGroup, input: AgendaInput): string[] {
  const { owner, team, tasks, tree } = group;
  const ids = tasks.map((task) => task.id);
  const into = team === undefined ? '' : ` --team ${team}`;
  const brief = `A full brief for ${input.ownerMarker}'s dedicated meeting, in this task's files: context, data, each option with its numbers and risks, your recommendation.`;
  const booker = team === undefined ? input.lead : `<${team}'s lead>`;
  const schedule = `${input.command} meeting schedule --meets ${owner} --at "<slot>" --about "${input.ownerMarker}'s core-business decisions" --tasks ${ids.join(',')} --session ${booker}`;
  return [
    `  ${team === undefined ? owner : `${team}/${owner}`}: ${tasks.length} decision(s)`,
    ...tasks.map((task) => `  ${rowOf(task, tree, team)}`),
    `    brief: ${input.command} add${into} --owner ${owner} --source ${input.ownerMarker} --priority p1 --due <slot date> --title "Dedicated meeting with ${input.ownerMarker} at <slot>: brief on ${ids.join(', ')}" --description "${brief}" --session ${input.lead}`,
    `    book: ${team === undefined ? schedule : `team ${team}'s lead runs ${schedule}`}`,
  ];
}

/**
 * DEDICATED: the waits on the owner in the team's core-business areas (`decisions.dedicatedOwners`, T868), the lead's
 * team's first, then each team's under it, by owning session. The owner refused to decide these from a short card, so
 * none is read out: each session gets its own meeting after the daily, with a full brief. No block when none waits.
 */
function dedicatedLines(input: AgendaInput): string[] {
  const groups = [dedicatedGroups(input, undefined), ...input.below.map((team) => dedicatedGroups(team, team.team))].flat();
  if (groups.length === 0) {
    return [];
  }
  const count = groups.reduce((sum, group) => sum + group.tasks.length, 0);
  return [
    `DEDICATED ${count} waiting on ${input.ownerMarker} in core-business areas: never a card; each owning session's own meeting after the daily`,
    ...groups.flatMap((group) => dedicatedGroupLines(group, input)),
    `  Agree a slot after the daily with ${input.ownerMarker} for each session, then run its brief and book lines once; at the slot ${input.ownerMarker} starts the meeting in the session's tab (meeting start M<n>), and the session brings its own cards with its brief and records each answer. Record none here.`,
  ];
}

/** A goal's row: how far its work came, its spend against its size, its risk and what holds it up. */
function goalRow(goal: GoalScore): string {
  const slips = `${goal.slips} ${goal.slips === 1 ? 'slip' : 'slips'}`;
  const waiting = goal.waiting.length === 0 ? '0 waiting' : `${goal.waiting.length} waiting: ${goal.waiting.join(', ')}`;
  const spend = `spent ${goal.spentPct.toFixed(1)}% of ${goal.sizePct.toFixed(1)}% sized`;
  return `  #${goal.rank} ${goal.tag} ${cut(oneLine(goal.title), TITLE_CHARS)} (target ${goal.target}): ${goal.done}/${goal.total} done, ${spend}, ${slips}, ${goal.overdue} overdue, ${waiting}`;
}

/** GOALS: the scoreboard the meeting opens with, or how to rank the goals that fill it. */
function goalLines(input: AgendaInput): string[] {
  return input.board.length === 0
    ? [`GOALS none ranked: ${input.command} goal rank <tag> <n> --session ${input.lead}`]
    : listed(`GOALS ${input.board.length} ranked, best first: done, spend against size, risk, what waits`, input.board.map(goalRow), `${input.command} goal list`);
}

/**
 * True for an active bug or critical task of the Maintenance class. It reads the ranked class, so a task with none counts
 * as the default class: this block only adds to what the lead sees, unlike the batch, which hides.
 */
function isIncident(task: Task, tree: TaskTree, focus: DecisionFocus): boolean {
  return ACTIVE_STATUSES.includes(task.status) && (task.critical || task.type === 'bug') && tree.rankedOf(task)?.workClass === focus.maintenanceClass;
}

/** The rows of a register's incidents, in its plan order; `team` labels a register under the lead's. */
function incidentRows(tasks: readonly Task[], tree: TaskTree, focus: DecisionFocus, team?: string): string[] {
  return tree.inPlanOrder(tasks.filter((task) => isIncident(task, tree, focus))).map((task) => rowOf(task, tree, team));
}

/** INCIDENTS: the Maintenance bugs and critical work, the lead's team's first; no block when none. */
function incidentLines(input: AgendaInput): string[] {
  const rows = [
    ...incidentRows(input.tasks, input.tree, input.focus),
    ...input.below.flatMap((team) => incidentRows(team.tasks, team.tree, team.focus, team.team)),
  ];
  // `list` has no class filter, so the command for all is the whole active list.
  return rows.length === 0 ? [] : listed(`INCIDENTS ${rows.length} active ${input.focus.maintenanceClass} bugs or critical tasks`, rows, `${input.command} list --tree`);
}

/** The rows of a register's waits the owner put off (ownerLater), in its plan order; `team` labels a register under the lead's. */
function laterRows(tasks: readonly Task[], tree: TaskTree, ownerMarker: string, requireGate: boolean, team?: string): string[] {
  return tree.inPlanOrder(tasks.filter((task) => ownerLater(task, ownerMarker, requireGate, tree.context) !== undefined)).map((task) => rowOf(task, tree, team));
}

/**
 * LATER: the waits on the owner put off to a time still to come (T1295), the lead's team's first, then those of each
 * team under it, each row with its time; none is read out, and each comes back to DECISIONS once its time passed. No
 * block when none is put off.
 */
function laterLines(input: AgendaInput): string[] {
  const rows = [
    ...laterRows(input.tasks, input.tree, input.ownerMarker, input.requireGate),
    ...input.below.flatMap((team) => laterRows(team.tasks, team.tree, team.ownerMarker, team.requireGate, team.team)),
  ];
  return rows.length === 0
    ? []
    : listed(`LATER ${rows.length} put off by ${input.ownerMarker}: asked once their time passed, never read out before`, rows, `${input.command} list --status waiting`);
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
  const late = tree.inPlanOrder(input.tasks.filter((task) => isLate(task, tree, input.now)));
  return listed(
    `LATE ${late.length} past their due date`,
    late.map((task) => rowOf(task, tree)),
    `${input.command} check`,
  );
}

/**
 * DONE: the tasks done since the agenda's start in the done groups (doneGroups, T1729): each group's heading and its
 * rows, at most AGENDA_ROWS of them, then Other work and the dropped tasks as one count line each with the command
 * that lists them, so the owner reads the work that matters and one line for the rest. The span has no end: nothing
 * finished before the read is left out.
 */
function doneLines(input: AgendaInput): string[] {
  const { groups, done, dropped } = doneGroups({
    tasks: input.tasks,
    ownerMarker: input.ownerMarker,
    zone: input.tree.zone,
    from: input.since,
    to: Number.POSITIVE_INFINITY,
  });
  const listDone = `${input.command} list --status done`;
  const lines = [`DONE ${done} done, ${dropped.length} dropped since ${input.tree.zone.weekdayMinute(new Date(input.since))}`];
  for (const group of groups) {
    if (group.kind === 'other') {
      lines.push(`  ${doneGroupTitle(group)} ${group.tasks.length}: ${listDone}`);
      continue;
    }
    const more = group.tasks.length > AGENDA_ROWS ? [`    +${group.tasks.length - AGENDA_ROWS} more: ${listDone}`] : [];
    lines.push(`  ${doneGroupTitle(group)} (${group.tasks.length})`, ...group.tasks.slice(0, AGENDA_ROWS).map((task) => `  ${rowOf(task, input.tree)}`), ...more);
  }
  if (dropped.length > 0) {
    lines.push(`  Dropped ${dropped.length}: ${input.command} list --status dropped`);
  }
  return lines;
}

/**
 * The register's agenda: the goals, to read everything after them against, then the owner's decisions, which are what
 * the meeting is for, and the core-business ones it books dedicated meetings for, and the incidents, then those the
 * owner put off and the ungated waits, which are not, then the late tasks, then the finished ones.
 */
export function agendaLines(input: AgendaInput): string[] {
  return [...goalLines(input), ...decisionLines(input), ...dedicatedLines(input), ...incidentLines(input), ...laterLines(input), ...ungatedLines(input), ...lateLines(input), ...doneLines(input)];
}
