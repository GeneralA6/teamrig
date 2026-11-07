import { KIT_NAME } from '../core/home.ts';
import type { TimeZone } from '../core/zone.ts';
import type { DecisionBatch } from '../decisions/batch.ts';
import { checkDecisionLines } from '../decisions/lines.ts';
import { formatHireFlag, type HireFlag } from '../hiring/due.ts';
import { FLAG_KINDS, formatFlag, type Flag, type FlagKind } from '../register/check.ts';
import type { Task } from '../register/fold.ts';
import type { TaskStatus } from '../register/model.ts';
import { planOrder, type TaskTree, type WaitingOnYou } from '../register/tree.ts';
import { aheadText, formatShortTask, formatTask, formatWaitingOnYou, type PlacedRow } from '../register/views.ts';
import { formatSkillFlag, type SkillFlag } from '../skills/lint.ts';
import { unownedHeading, unownedRow, type UnownedWarning } from './unowned.ts';

/**
 * What `list` and `check` print. A session's reads stay in its context and are re-read on every later call, so by
 * default both print a short form of at most SHORT_FORM_CHARS characters; `--all` prints the long form, every field
 * of every row.
 */

/** The most a short form prints, each line counted with its newline. */
export const SHORT_FORM_CHARS = 3_000;
/** A short row cuts the task title to this many characters. */
export const SHORT_TITLE_CHARS = 60;
/** The short `check` shows at most this many flags of each kind, fewer when they would pass SHORT_FORM_CHARS. */
export const MAX_FLAGS_PER_KIND = 5;
/** `start` shows at most this many tasks waiting on the session, then a `+N more` line; `--all` shows every one. */
export const MAX_WAITING_ROWS = 5;

/** The order of the status counts on a short `list` owner line: what moves first, what waits last. */
const SUMMARY_STATUSES: readonly TaskStatus[] = ['in-progress', 'verifying', 'waiting', 'open', 'done', 'dropped'];

/**
 * A task with the team a roll-up names its id by (`web/T4`), undefined in a one-team read, and the dependency tree
 * of its register: which of a waiting task's reasons are ready, its effective due and what needs it.
 */
export interface TaskRow {
  readonly task: Task;
  readonly team: string | undefined;
  readonly tree: TaskTree;
}

/** One register's flags, with the team a roll-up names its ids by and the dependency tree of the read that raised them. */
export interface CheckSection {
  readonly team: string | undefined;
  readonly flags: readonly Flag[];
  readonly tree: TaskTree;
}

export interface CheckReport {
  readonly sections: readonly CheckSection[];
  /** `week 2030-01-07`, or why the week checks were skipped; narrowed to one session, led by whose flags these are. */
  readonly scope: string;
  /** The skill flags a session on the team owns. */
  readonly skills: readonly SkillFlag[];
  readonly skillsDir: string;
  /** The hire flags: SCALE-OUT on an area, then RETIRE-DUE and REVIEW-DUE on a hired session; printed only when there are some. */
  readonly hires: readonly HireFlag[];
  /**
   * The warnings no session owns (src/cli/unowned.ts): doctor's context-size, context-lists, allow-wide and deny-missing findings,
   * the skill flags with no owner on the team, the idle pass's FLEET-STALE, a repository's SECRET-HOOK, SECRET-GUARD-OFF
   * and the five-hour window's FIVE-HOUR; they go to the lead, printed only when there are some.
   */
  readonly unowned: readonly UnownedWarning[];
  /** The own team's lead, whom the unowned warnings go to. */
  readonly lead: string;
  /** The own team's batch of the owner's decisions, for its lead; printed only while a batch is due. */
  readonly decisions: LeadDecisions | undefined;
}

/** The batch of the owner's decisions the lead asks next (src/decisions/batch.ts). */
export interface LeadDecisions {
  readonly lead: string;
  readonly batch: DecisionBatch;
  /** The team's clock, which the batch times print on. */
  readonly zone: TimeZone;
}

/**
 * A report narrowed to what one session acts on, for `start`: the flags of the tasks it owns, of the skills
 * it fixes (only a task's owner sets its status), on itself as a hired session and a SCALE-OUT on its area. A sub-lead
 * also gets the flags of its group's tasks (`group`, empty for a session that leads no one), since it sets their work
 * order (T782). An UNTRIAGED flag is its task's leader's to act on, so it stays off the task owner's own report. The
 * scope names the session and its group, so the CHECK line says whose flags these are. The warnings no session owns go
 * to the lead, so a narrowed report has none (T951).
 */
export function ownCheck(report: CheckReport, owner: string, group: readonly string[]): CheckReport {
  const owners = new Set([owner, ...group]);
  const groupScope = group.length === 0 ? '' : `its group's tasks (${group.join(', ')}), `;
  const actsOn = (flag: Flag): boolean => owners.has(flag.task.owner) && !(flag.kind === 'UNTRIAGED' && flag.task.owner === owner);
  return {
    ...report,
    sections: report.sections.map((section) => ({ ...section, flags: section.flags.filter(actsOn) })),
    scope: `${owner}'s tasks and skills, ${groupScope}${report.scope}`,
    skills: report.skills.filter((flag) => flag.owner === owner),
    hires: report.hires.filter((flag) => flag.session === owner),
    unowned: [],
    decisions: report.decisions?.lead === owner ? report.decisions : undefined,
  };
}

interface TeamFlag {
  readonly flag: Flag;
  readonly team: string | undefined;
  readonly tree: TaskTree;
}

/** Plan order on effective dues across registers: each task placed by its own register's tree. */
function byRowPlanOrder(a: PlacedRow, b: PlacedRow): number {
  return planOrder(a.tree.placeOf(a.task), b.tree.placeOf(b.task));
}

/** The characters `lines` print, each with its newline. */
export function printedChars(lines: readonly string[]): number {
  return lines.reduce((sum, line) => sum + line.length + 1, 0);
}

/** The first lines that fit in `budget` printed characters, then `more(n)` for the n left out; all of them when they fit. */
export function fitBudget(lines: readonly string[], budget: number, more: (left: number) => string): string[] {
  if (printedChars(lines) <= budget) {
    return [...lines];
  }
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    const after = used + line.length + 1;
    if (after + more(lines.length - kept.length - 1).length + 1 > budget) {
      break;
    }
    kept.push(line);
    used = after;
  }
  return [...kept, more(lines.length - kept.length)];
}

/** The first `shown` lines, then `  +N more` for the rest. */
function firstOf(lines: readonly string[], shown: number): string[] {
  return lines.length <= shown ? [...lines] : [...lines.slice(0, shown), `  +${lines.length - shown} more`];
}

/**
 * `list`: every field of every row with `all`, in the given order, else the short form; each row ends with why it
 * sorts ahead of the next one ({@link aheadText}).
 */
export function listLines(rows: readonly TaskRow[], all: boolean): string[] {
  return all ? rows.map((row, index) => `${formatTask(row.task, row.team, row.tree)}${aheadText(row, rows[index + 1])}`) : shortList(rows);
}

function ownerOf({ task, team }: TaskRow): string {
  return team === undefined ? task.owner : `${team}/${task.owner}`;
}

/** `  alpha 7: 2 in-progress, 1 waiting, 4 open`. */
function ownerLine(owner: string, rows: readonly TaskRow[]): string {
  const counts = SUMMARY_STATUSES.flatMap((status) => {
    const count = rows.filter(({ task }) => task.status === status).length;
    return count > 0 ? [`${count} ${status}`] : [];
  });
  return `  ${owner} ${rows.length}: ${counts.join(', ')}`;
}

/**
 * The short `list`: `LIST 12 task(s) of 3 owners (short rows; --all for every field)`; when several owners have tasks,
 * a line per owner with its status counts, the busiest first; then the short rows in plan order across every team, each
 * with why it sorts ahead of the next (`· ahead: due`), cut to SHORT_FORM_CHARS with a `+N more` line.
 */
function shortList(rows: readonly TaskRow[]): string[] {
  const owners = new Map<string, TaskRow[]>();
  for (const row of rows) {
    owners.set(ownerOf(row), [...(owners.get(ownerOf(row)) ?? []), row]);
  }
  const ownerCount = owners.size > 1 ? ` of ${owners.size} owners` : '';
  const hint = rows.length > 0 ? ' (short rows; --all for every field)' : '';
  const summary =
    owners.size > 1
      ? [...owners].sort(([a, x], [b, y]) => y.length - x.length || a.localeCompare(b)).map(([owner, owned]) => ownerLine(owner, owned))
      : [];
  const sorted = [...rows].sort(byRowPlanOrder);
  return fitBudget(
    [`LIST ${rows.length} task(s)${ownerCount}${hint}`, ...summary, ...sorted.map((row, index) => `${formatShortTask(row.task, SHORT_TITLE_CHARS, row.team, row.tree)}${aheadText(row, sorted[index + 1])}`)],
    SHORT_FORM_CHARS,
    (left) => `+${left} more (--all lists every task in full)`,
  );
}

/** `check`: every flag in full with `all`, else the short form. */
export function checkLines(report: CheckReport, all: boolean): string[] {
  return all ? longCheck(report) : shortCheck(report);
}

function skillsLine({ skills, skillsDir }: CheckReport): string {
  return `SKILLS ${skills.length} flag(s) in ${skillsDir}`;
}

/** The hire flags' `HIRES` line and each flag; nothing on a team with none. */
function hireLines({ hires }: CheckReport, indent: string): string[] {
  return hires.length === 0 ? [] : [`HIRES ${hires.length} flag(s)`, ...hires.map((flag) => `${indent}${formatHireFlag(flag)}`)];
}

/** The `UNOWNED` heading, naming the lead they go to, then the first `shown` warnings, each with its source; nothing while no warning is unowned. */
function unownedLines({ unowned, lead }: CheckReport, indent: string, shown: number): string[] {
  return unowned.length === 0 ? [] : [unownedHeading(unowned.length, lead), ...firstOf(unowned.map((warning) => `${indent}${unownedRow(warning)}`), shown)];
}

/** The lead's `DECISIONS` line while a batch of the owner's decisions is due; nothing otherwise. */
function decisionLines({ decisions }: CheckReport): string[] {
  return decisions === undefined ? [] : checkDecisionLines(decisions.batch, KIT_NAME, decisions.lead, decisions.zone);
}

/** Each register's `CHECK` line and flags, then the hire flags, the unowned warnings, the lead's due batch of decisions, then the skill flags: every flag, every field. */
function longCheck(report: CheckReport): string[] {
  return [
    ...report.sections.flatMap(({ team, flags, tree }) => [
      `CHECK${team === undefined ? '' : ` ${team}:`} ${flags.length} flag(s), ${report.scope}`,
      ...flags.map((flag) => formatFlag(flag, team, tree)),
    ]),
    ...hireLines(report, ''),
    ...unownedLines(report, '', report.unowned.length),
    ...decisionLines(report),
    skillsLine(report),
    ...report.skills.map(formatSkillFlag),
  ];
}

/** A kind's heading and its first `shown` flags; a detail every flag of the kind shares moves to the heading. */
function kindLines(kind: FlagKind, rows: readonly TeamFlag[], shown: number): string[] {
  const details = new Set(rows.map(({ flag }) => flag.detail));
  const [shared] = details.size === 1 ? [...details] : [];
  const lines = rows.map(({ flag, team, tree }) => {
    const detail = shared === undefined ? `(${flag.detail}) ` : '';
    return `  ${detail}${formatShortTask(flag.task, SHORT_TITLE_CHARS, team, tree)}`;
  });
  return [`${kind} ${rows.length}${shared === undefined ? '' : ` (${shared})`}`, ...firstOf(lines, shown)];
}

/**
 * The short `check`: one `CHECK` line over every register, then each kind with its count and its first flags in plan
 * order, then every hire flag (at most two per hired session), the unowned warnings and the skill flags the same way as the kinds, with the lead's due batch of decisions between them. Each kind shows MAX_FLAGS_PER_KIND flags, or fewer, the same number for
 * every kind, so the whole fits in SHORT_FORM_CHARS; at one each, lines past the budget give way to a `+N more` line.
 */
function shortCheck(report: CheckReport): string[] {
  const flags = report.sections.flatMap(({ team, flags: own, tree }) => own.map((flag) => ({ flag, team, tree })));
  const kinds = FLAG_KINDS.map((kind) => ({
    kind,
    rows: flags.filter(({ flag }) => flag.kind === kind).sort((x, y) => planOrder(x.tree.placeOf(x.flag.task), y.tree.placeOf(y.flag.task))),
  })).filter(({ rows }) => rows.length > 0);
  const teams = report.sections.length > 1 ? ` in ${report.sections.length} team(s)` : '';
  const hint = flags.length + report.skills.length + report.hires.length + report.unowned.length > 0 ? ' (short form; --all for every flag in full)' : '';
  const head = `CHECK ${flags.length} flag(s)${teams}, ${report.scope}${hint}`;
  const linesShowing = (shown: number): string[] => [
    head,
    ...kinds.flatMap(({ kind, rows }) => kindLines(kind, rows, shown)),
    ...hireLines(report, '  '),
    ...unownedLines(report, '  ', shown),
    ...decisionLines(report),
    skillsLine(report),
    ...firstOf(
      report.skills.map((flag) => `  ${formatSkillFlag(flag)}`),
      shown,
    ),
  ];
  for (let shown = MAX_FLAGS_PER_KIND; shown > 1; shown -= 1) {
    const lines = linesShowing(shown);
    if (printedChars(lines) <= SHORT_FORM_CHARS) {
      return lines;
    }
  }
  return fitBudget(linesShowing(1), SHORT_FORM_CHARS, (left) => `+${left} more line(s) (--all for every flag in full)`);
}

/**
 * `start`'s `WAITING ON YOU` block: the active tasks of other sessions that need the session's unfinished tasks or
 * wait on its decision or approval (TaskTree.waitingOn), in the order given, at most MAX_WAITING_ROWS of them unless
 * `all`; nothing when none waits.
 */
export function waitingOnLines(owner: string, waiting: readonly WaitingOnYou[], tree: TaskTree, all: boolean): string[] {
  if (waiting.length === 0) {
    return [];
  }
  const rows = waiting.map((entry) => `  ${formatWaitingOnYou(entry, SHORT_TITLE_CHARS, tree)}`);
  const shown = all || rows.length <= MAX_WAITING_ROWS ? rows : [...rows.slice(0, MAX_WAITING_ROWS), `  +${rows.length - MAX_WAITING_ROWS} more (--all lists every one)`];
  return [`WAITING ON YOU ${waiting.length} task(s) of other sessions wait on ${owner}`, ...shown];
}
