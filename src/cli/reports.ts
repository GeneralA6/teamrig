import { formatHireFlag, type HireFlag } from '../hiring/due.ts';
import { FLAG_KINDS, formatFlag, type Flag, type FlagKind } from '../register/check.ts';
import type { Task } from '../register/fold.ts';
import type { TaskStatus } from '../register/model.ts';
import { byPlanOrder, formatShortTask, formatTask } from '../register/views.ts';
import type { WaitContext } from '../register/waits.ts';
import { formatSkillFlag, type SkillFlag } from '../skills/lint.ts';

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

/** The order of the status counts on a short `list` owner line: what moves first, what waits last. */
const SUMMARY_STATUSES: readonly TaskStatus[] = ['in-progress', 'verifying', 'waiting', 'open', 'done', 'dropped'];

/**
 * A task with the team a roll-up names its id by (`web/T4`), undefined in a one-team read, and the read of its
 * register that tells which of a waiting task's reasons are ready.
 */
export interface TaskRow {
  readonly task: Task;
  readonly team: string | undefined;
  readonly context: WaitContext;
}

/** One register's flags, with the team a roll-up names its ids by and the read that judged its waiting tasks. */
export interface CheckSection {
  readonly team: string | undefined;
  readonly flags: readonly Flag[];
  readonly context: WaitContext;
}

export interface CheckReport {
  readonly sections: readonly CheckSection[];
  /** `week 2030-01-07`, or why the week checks were skipped; narrowed to one session, led by whose flags these are. */
  readonly scope: string;
  readonly skills: readonly SkillFlag[];
  readonly skillsDir: string;
  /** The flags on hired sessions (RETIRE-DUE, REVIEW-DUE); printed only when there are some. */
  readonly hires: readonly HireFlag[];
}

/**
 * A report narrowed to what one session acts on, for `start`: the flags of the tasks it owns, of the skills
 * it fixes (only a task's owner sets its status) and on itself as a hired session. The scope names the session,
 * so the CHECK line says whose flags these are.
 */
export function ownCheck(report: CheckReport, owner: string): CheckReport {
  return {
    ...report,
    sections: report.sections.map((section) => ({ ...section, flags: section.flags.filter((flag) => flag.task.owner === owner) })),
    scope: `${owner}'s tasks and skills, ${report.scope}`,
    skills: report.skills.filter((flag) => flag.owner === owner),
    hires: report.hires.filter((flag) => flag.session === owner),
  };
}

interface TeamFlag {
  readonly flag: Flag;
  readonly team: string | undefined;
  readonly context: WaitContext;
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

/** `list`: every field of every row with `all`, else the short form. */
export function listLines(rows: readonly TaskRow[], all: boolean): string[] {
  return all ? rows.map(({ task, team, context }) => formatTask(task, team, context)) : shortList(rows);
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
 * a line per owner with its status counts, the busiest first; then the short rows in plan order across every team,
 * cut to SHORT_FORM_CHARS with a `+N more` line.
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
  const sorted = [...rows].sort((a, b) => byPlanOrder(a.task, b.task));
  return fitBudget(
    [`LIST ${rows.length} task(s)${ownerCount}${hint}`, ...summary, ...sorted.map(({ task, team, context }) => formatShortTask(task, SHORT_TITLE_CHARS, team, context))],
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

/** Each register's `CHECK` line and flags, then the hire flags, then the skill flags: every flag, every field. */
function longCheck(report: CheckReport): string[] {
  return [
    ...report.sections.flatMap(({ team, flags, context }) => [
      `CHECK${team === undefined ? '' : ` ${team}:`} ${flags.length} flag(s), ${report.scope}`,
      ...flags.map((flag) => formatFlag(flag, team, context)),
    ]),
    ...hireLines(report, ''),
    skillsLine(report),
    ...report.skills.map(formatSkillFlag),
  ];
}

/** A kind's heading and its first `shown` flags; a detail every flag of the kind shares moves to the heading. */
function kindLines(kind: FlagKind, rows: readonly TeamFlag[], shown: number): string[] {
  const details = new Set(rows.map(({ flag }) => flag.detail));
  const [shared] = details.size === 1 ? [...details] : [];
  const lines = rows.map(({ flag, team, context }) => {
    const detail = shared === undefined ? `(${flag.detail}) ` : '';
    return `  ${detail}${formatShortTask(flag.task, SHORT_TITLE_CHARS, team, context)}`;
  });
  return [`${kind} ${rows.length}${shared === undefined ? '' : ` (${shared})`}`, ...firstOf(lines, shown)];
}

/**
 * The short `check`: one `CHECK` line over every register, then each kind with its count and its first flags in plan
 * order, then every hire flag (at most two per hired session), then the skill flags the same way as the kinds. Each kind shows MAX_FLAGS_PER_KIND flags, or fewer, the same number for
 * every kind, so the whole fits in SHORT_FORM_CHARS; at one each, lines past the budget give way to a `+N more` line.
 */
function shortCheck(report: CheckReport): string[] {
  const flags = report.sections.flatMap(({ team, flags: own, context }) => own.map((flag) => ({ flag, team, context })));
  const kinds = FLAG_KINDS.map((kind) => ({
    kind,
    rows: flags.filter(({ flag }) => flag.kind === kind).sort((a, b) => byPlanOrder(a.flag.task, b.flag.task)),
  })).filter(({ rows }) => rows.length > 0);
  const teams = report.sections.length > 1 ? ` in ${report.sections.length} team(s)` : '';
  const hint = flags.length + report.skills.length + report.hires.length > 0 ? ' (short form; --all for every flag in full)' : '';
  const head = `CHECK ${flags.length} flag(s)${teams}, ${report.scope}${hint}`;
  const linesShowing = (shown: number): string[] => [
    head,
    ...kinds.flatMap(({ kind, rows }) => kindLines(kind, rows, shown)),
    ...hireLines(report, '  '),
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
