import { formatCount, formatPct, formatTimeOfDay, formatW, formatWeekdayMinute } from './format.ts';
import { liftText, type Lift } from './lift.ts';
import { emptyPatterns, PATTERN_FIELDS, type PatternField } from './patterns.ts';
import type { DayUsage, UsageState } from './store.ts';
import type { WeekReading } from './week.ts';

/** The lines of `teamrig budget`: short by default, the key numbers and anything past its budget. */

/** Sessions listed by default; `--all` lists every one. */
export const SESSION_ROWS_SHOWN = 7;
/** Titles of sessions outside the team named by default. */
export const OUTSIDE_TITLES_SHOWN = 5;

/** What a session past its daily budget does: never skip a test or check (G-B1 wording). */
export const OVER_BUDGET_ADVICE =
  'Finish the step in hand and start no new work items or helpers. Never skip a test or check to save budget. The lead can lift it.';

export const W_EXPLAINED = 'W = weighted tokens: input 1, cache writes 1.25 to 2, cache reads 0.1, output 5.';

/** One session's use today and its budget. */
export interface SessionToday {
  readonly id: string;
  readonly name: string;
  readonly w: number;
  readonly calls: number;
  /** Its daily budget in percent of the week, its lift's while lifted; undefined when unknown. */
  readonly budgetPct: number | undefined;
  readonly lift: Lift | undefined;
}

export interface OutsideToday {
  readonly w: number;
  readonly calls: number;
  readonly sessions: number;
  readonly titles: readonly string[];
}

export interface TodayReport {
  readonly week: WeekReading;
  /** Every team session, in roster order. */
  readonly sessions: readonly SessionToday[];
  readonly outside: OutsideToday;
  /** The names of sessions whose transcripts still have unread lines. */
  readonly behind: readonly string[];
  readonly all: boolean;
}

function pctOf(w: number, week: WeekReading): number | undefined {
  return week.wPerPct === undefined ? undefined : w / week.wPerPct;
}

function useText(w: number, calls: number): string {
  return `${formatW(w)} W in ${formatCount(calls)} call${calls === 1 ? '' : 's'}`;
}

/** The week's use and its pace: the first line of `budget`, and the last of `start`. */
export function weekLine(week: WeekReading): string {
  if (week.usedPct === undefined || week.reset === undefined) {
    return "Week: its use is unknown: no status line reading (run teamrig statusline install) and no budget.weeklyLimitW.";
  }
  const source = week.statusAt === undefined ? ' (metered)' : ` at ${formatTimeOfDay(week.statusAt)} (status line)`;
  const pace = week.pace;
  const paceText =
    pace === undefined
      ? ''
      : `; the pace line is at ${formatPct(pace.linePct)}: ${pace.state === 'on pace' ? 'on pace' : `${Math.abs(pace.gapPts).toFixed(1)} points ${pace.state}`}`;
  return `Week: ${formatPct(week.usedPct)} used${source}${paceText}. Resets ${formatWeekdayMinute(week.reset)}.`;
}

/** "<who> used 1.1% of the week today; its daily budget is 1.0%. 7.50M W in 310 calls." */
function useLine(who: string, w: number, calls: number, budgetPct: number | undefined, lifted: boolean, week: WeekReading, when = 'today'): string {
  const used = pctOf(w, week);
  if (used === undefined) {
    return `${who} used ${useText(w, calls)} ${when}.`;
  }
  const budget = budgetPct === undefined ? '' : `; its daily budget is ${formatPct(budgetPct)}${lifted ? ' (lifted)' : ''}`;
  return `${who} used ${formatPct(used)} of the week ${when}${budget}. ${useText(w, calls)}.`;
}

function isPast(w: number, budgetPct: number | undefined, week: WeekReading): boolean {
  const used = pctOf(w, week);
  return used !== undefined && budgetPct !== undefined && used > budgetPct;
}

/**
 * The rows of the sessions with use, busiest first: the first seven, then a count of the rest; with
 * `--all` every one, then the idle ones by name.
 */
function sessionRows(sessions: readonly SessionToday[], all: boolean, when: string, row: (session: SessionToday) => string): string[] {
  const used = [...sessions].filter((session) => session.w > 0).sort((a, b) => b.w - a.w);
  const shown = all ? used : used.slice(0, SESSION_ROWS_SHOWN);
  const lines = shown.map(row);
  if (shown.length < used.length) {
    lines.push(`+${used.length - shown.length} more sessions with use ${when} (--all lists them).`);
  }
  const idle = sessions.filter((session) => session.w === 0).map((session) => session.name);
  if (all && idle.length > 0) {
    lines.push(`No use ${when}: ${idle.join(', ')}.`);
  }
  return lines;
}

/** "N Claude Code sessions (titled a, b, +2 more)": the first five titles, or every one with `--all`. */
function outsideSessionsText(outside: OutsideToday, all: boolean): string {
  const shown = all ? outside.titles : outside.titles.slice(0, OUTSIDE_TITLES_SHOWN);
  const more = outside.titles.length - shown.length;
  const titles = shown.length === 0 ? '' : ` (titled ${shown.join(', ')}${more > 0 ? `, +${more} more` : ''})`;
  return `${outside.sessions} Claude Code session${outside.sessions === 1 ? '' : 's'}${titles}`;
}

function outsideLine(outside: OutsideToday, all: boolean): string | undefined {
  if (outside.sessions === 0 && outside.w === 0) {
    return undefined;
  }
  return (
    `Not on the team: ${outsideSessionsText(outside, all)}, ${formatW(outside.w)} W today. ` +
    'A tab counts for a session once it runs teamrig inbox read --session <id> or is named after it.'
  );
}

/** `teamrig budget`: the week, the team and each session today, lifts, use outside the team, and who is past budget. */
export function todayLines(report: TodayReport): string[] {
  const { week, sessions, outside, all } = report;
  const teamW = sessions.reduce((sum, session) => sum + session.w, 0);
  const teamCalls = sessions.reduce((sum, session) => sum + session.calls, 0);
  const lines = [
    weekLine(week),
    useLine('The team', teamW, teamCalls, week.allowancePct, false, week),
    ...sessionRows(sessions, all, 'today', (session) => useLine(session.name, session.w, session.calls, session.budgetPct, session.lift !== undefined, week)),
  ];
  for (const session of sessions) {
    if (session.lift !== undefined) {
      lines.push(`Budget: the lead lifted ${liftText(session.lift, session.name)}`);
    }
  }
  const outsideText = outsideLine(outside, all);
  if (outsideText !== undefined) {
    lines.push(outsideText);
  }
  if (report.behind.length > 0) {
    lines.push(`Still reading: ${report.behind.join(', ')}; run teamrig budget again for the rest.`);
  }
  const past = [
    ...(isPast(teamW, week.allowancePct, week) ? ['the team'] : []),
    ...sessions.filter((session) => isPast(session.w, session.budgetPct, week)).map((session) => session.name),
  ];
  if (past.length > 0) {
    lines.push(`Past the daily budget: ${past.join(', ')}. ${OVER_BUDGET_ADVICE}`);
  }
  if (week.usedPct !== undefined && week.wPerPct === undefined) {
    lines.push('Daily budgets need the week in W: set budget.weeklyLimitW, or let teamrig meter a whole week to estimate it.');
  }
  lines.push(week.limitEstimated && week.wPerPct !== undefined ? `${W_EXPLAINED} 1% of the week is about ${formatW(week.wPerPct)} W, estimated from the status line.` : W_EXPLAINED);
  return lines;
}

/** `teamrig budget --day <day>`: that day recounted from the transcripts, with nothing written. */
export function recountLines(day: string, report: Pick<TodayReport, 'sessions' | 'outside' | 'all' | 'week'>): string[] {
  const { sessions, outside, all, week } = report;
  const teamW = sessions.reduce((sum, session) => sum + session.w, 0);
  const teamCalls = sessions.reduce((sum, session) => sum + session.calls, 0);
  const lines = [
    `${day} (UTC), recounted from the transcripts; nothing was written.`,
    useLine('The team', teamW, teamCalls, undefined, false, week, 'that day'),
    ...sessionRows(sessions, all, 'that day', (session) => useLine(session.name, session.w, session.calls, undefined, false, week, 'that day')),
  ];
  if (outside.sessions > 0 || outside.w > 0) {
    lines.push(`Not on the team: ${outsideSessionsText(outside, all)}, ${useText(outside.w, outside.calls)}.`);
  }
  lines.push(W_EXPLAINED);
  return lines;
}

/** `teamrig budget <session>`: its use on each stored day, its budget today and its lift. */
export function sessionLines(session: SessionToday, state: UsageState, week: WeekReading): string[] {
  const days = Object.keys(state.byDay).sort().reverse();
  const lines = [`${session.name} (${session.id}), by UTC day:`];
  for (const day of days) {
    const usage = state.byDay[day];
    if (usage !== undefined) {
      const used = pctOf(usage.w, week);
      lines.push(`  ${day}  ${useText(usage.w, usage.calls)}${used === undefined ? '' : `, ${formatPct(used)} of the week`}`);
    }
  }
  if (days.length === 0) {
    lines.push('  no use in the last 8 days');
  }
  if (session.budgetPct !== undefined) {
    lines.push(`Its daily budget today is ${formatPct(session.budgetPct)} of the week${session.lift === undefined ? '' : ' (lifted)'}.`);
  }
  if (session.lift !== undefined) {
    lines.push(`Budget: the lead lifted ${liftText(session.lift, session.name)}`);
  }
  lines.push(W_EXPLAINED);
  return lines;
}

/** One counter's row: its count, and the W it cost or could save. */
interface CountRow {
  readonly label: string;
  readonly count: PatternField;
  readonly w?: PatternField;
}

/** The loop patterns, biggest first in the design's ranking; see `PATTERN_FIELDS` for what each counts. */
export const LOOP_ROWS: readonly CountRow[] = [
  { label: 'read after read, W', count: 'readChain', w: 'readChainW' },
  { label: 'edit after edit, W saved', count: 'editChain', w: 'editChainSavedW' },
  { label: 'test after an edit, W saved', count: 'editThenTest', w: 'editThenTestSavedW' },
  { label: '  edit and test in one call', count: 'editTestJoined' },
  { label: 'rerun, piped failure, W', count: 'rerunFailedPiped', w: 'rerunFailedPipedW' },
  { label: 'rerun, full failure, W', count: 'rerunFailedFull', w: 'rerunFailedFullW' },
  { label: 'rerun after a pass, W', count: 'rerunAfterPass', w: 'rerunAfterPassW' },
  { label: 'passing test runs, rent W', count: 'passRuns', w: 'passRentW' },
  { label: '  their output tokens', count: 'passTokens' },
];

/** The days' totals over several stores, such as every session's. */
export function sumDays(states: readonly UsageState[], days: readonly string[]): DayUsage[] {
  return days.map((day) => {
    const patterns = emptyPatterns();
    let w = 0;
    let calls = 0;
    for (const usage of states.map((state) => state.byDay[day])) {
      if (usage === undefined) {
        continue;
      }
      w += usage.w;
      calls += usage.calls;
      for (const field of PATTERN_FIELDS) {
        patterns[field] += usage.patterns[field];
      }
    }
    return { w, calls, patterns };
  });
}

/** One row of a day table: its label, and its text for one day. */
interface DayRow {
  readonly label: string;
  readonly cell: (usage: DayUsage) => string;
}

function countRow(row: CountRow): DayRow {
  return {
    label: row.label,
    cell: (usage) => {
      const count = formatCount(usage.patterns[row.count]);
      return row.w === undefined ? count : `${count} ${formatW(usage.patterns[row.w])}`;
    },
  };
}

const ALL_CALLS_ROW: DayRow = { label: 'all calls', cell: (usage) => `${formatCount(usage.calls)} ${formatW(usage.w)}` };

const NOTHING_METERED = 'nothing metered';

/**
 * A table with the days as columns. `leftOut` gives the reason a day is left out, or undefined to show it;
 * the days left out are named under the table by reason, each with the `--day` that reads one.
 */
function dayTable(header: string, rows: readonly DayRow[], days: readonly string[], totals: readonly DayUsage[], leftOut: (usage: DayUsage) => string | undefined): string[] {
  const shown: { readonly day: string; readonly usage: DayUsage }[] = [];
  const skipped = new Map<string, string[]>();
  for (const [index, day] of days.entries()) {
    const usage = totals[index] ?? { w: 0, calls: 0, patterns: emptyPatterns() };
    const reason = leftOut(usage);
    if (reason === undefined) {
      shown.push({ day, usage });
    } else {
      skipped.set(reason, [...(skipped.get(reason) ?? []), day]);
    }
  }
  const notes = [...skipped].map(([reason, each]) => `Left out, ${reason}: ${each.map((day) => day.slice(5)).join(', ')} (add --day ${each[0]} to read one).`);
  if (shown.length === 0) {
    return [header, ...notes];
  }
  const table = [['', ...shown.map(({ day }) => day.slice(5))], ...rows.map((row) => [row.label, ...shown.map(({ usage }) => row.cell(usage))])];
  const widths = shown.map((_, index) => Math.max(...table.map((row) => (row[index + 1] ?? '').length)));
  const labelWidth = Math.max(...table.map((row) => (row[0] ?? '').length));
  const lines = table.map((row) =>
    [(row[0] ?? '').padEnd(labelWidth), ...row.slice(1).map((text, index) => text.padStart(widths[index] ?? 0))].join('  ').trimEnd(),
  );
  return [header, ...lines, ...notes];
}

/**
 * `teamrig budget --loops`: each pattern's count and W per day, the days as columns. From the meter's store
 * a day with no calls was never metered (before the meter started, or outside its window), so its column
 * is left out and named under the table; a recounted day (`--day`) was read, so its zeros are shown.
 */
export function loopLines(who: string, days: readonly string[], totals: readonly DayUsage[], source: 'metered' | 'recounted'): string[] {
  const leftOut = (usage: DayUsage): string | undefined => (source === 'metered' && usage.calls === 0 ? NOTHING_METERED : undefined);
  return dayTable(`Loop patterns, ${who}: count, then W (UTC days)`, [...LOOP_ROWS.map(countRow), ALL_CALLS_ROW], days, totals, leftOut);
}
