import { basename, join } from 'node:path';
import { DEFAULT_STATUS_LINE } from '../../config/defaults.ts';
import { LeadTree } from '../../config/lead-tree.ts';
import type { Roster } from '../../config/roster.ts';
import type { BudgetConfig, KitConfig, StatusLineConfig } from '../../config/types.ts';
import { errorMessage } from '../../core/guards.ts';
import { resolveKitHome } from '../../core/home.ts';
import type { Clock } from '../../core/lock.ts';
import { PlainLogFile } from '../../core/log-file.ts';
import { resolveTeam } from '../../core/team.ts';
import { formatUtcDay, MS_PER_DAY, parseUtcDay, typedDeadline, typedTimeHint } from '../../core/time.ts';
import { activeBurst, burstFloorOf, withBurst, type BurstRecord, type InBurst } from '../../budget/burst.ts';
import { BurstLog } from '../../budget/burst-log.ts';
import { calibrationOf } from '../../budget/calibration.ts';
import { claudeProjectsDir, type TranscriptSource } from '../../budget/discover.ts';
import { ExtraLog, type ExtraEntry } from '../../budget/extra.ts';
import { formatPct, formatUsd } from '../../budget/format.ts';
import { activeGroupLift, activeLift, decideLift, LiftLog, liftText, parentBudgetText, type Lift, type LiftNames } from '../../budget/lift.ts';
import { CATCH_UP_CHUNK_BYTES, MAX_RUNS_PER_SESSION, measure, OUTSIDE_ID, type Measured } from '../../budget/measure.ts';
import { budgetSplitOf, dailyBudgetOf, groupPartsOf, liftPlaceOf, teamPartOf, type BudgetSplit } from '../../budget/parts.ts';
import { pausableOf } from '../../budget/pause.ts';
import { nextPeriod, sightOf, type Period } from '../../budget/period.ts';
import {
  burnLines,
  loopLines,
  missLines,
  missMatrixLines,
  recountLines,
  sessionLines,
  sumDays,
  sumUsage,
  taskLines,
  todayLines,
  weekLine,
  type GroupToday,
  type SessionToday,
} from '../../budget/report.ts';
import {
  datedSnapshot,
  defaultSnapshotDir,
  formatSnapshot,
  parseSnapshot,
  pruneSnapshots,
  snapshotDirOf,
  snapshotOfStatus,
  statusLineText,
  type StatusLineView,
  type StatusSnapshot,
} from '../../budget/snapshot.ts';
import { CURSOR_DAYS_KEPT, DAYS_KEPT, EMPTY_USAGE, MemoryUsageStore, UsageStore, type UsageState } from '../../budget/store.ts';
import { attributedW, taskUseOf } from '../../budget/task-use.ts';
import { teamWeekOf, type TeamWeekPaths } from '../../budget/team-week.ts';
import { foldIntoWeekSummary } from '../../budget/week-summary.ts';
import { readWeek, wSince, type WeekReading } from '../../budget/week.ts';
import { NO_WORK, readWork, type WorkByPriority } from '../../budget/work.ts';
import { JsonlMarkLog } from '../../inbox/store.ts';
import { indexMarks } from '../../inbox/marks.ts';
import type { RepoState } from '../../push-guard/push.ts';
import { customTitleOf, TRANSCRIPT_TAIL_BYTES } from '../../names/title.ts';
import { TASK_ID } from '../../register/model.ts';
import { accountWeekOn, otherTeamsOnAccount } from '../account-teams.ts';
import { UsageError, onePositional, requiredFlag, type Flags, type ParsedArgs } from '../args.ts';
import { callerOf, type TypedTimes } from '../inputs.ts';
import { leadOnly, openKit, openTeamKit, requireConfig, rosterOf, sessionIdOf, teamFolders, teamZone, type Kit } from '../kit.ts';
import { EXIT, RefusedError, type CliRuntime, type ExitCode } from '../runtime.ts';

/**
 * The weekly budget from the command line: `budget` measures every session's use from the Claude Code
 * transcripts and shows it against the week's pace, or with `--task` what each session spent on one task;
 * `budget lift` is a leader's lift of one session's, or a sub-lead's group's,
 * daily budget; `statusline` is a status line that saves the plan's own reading for `budget`. Measuring
 * and showing only: nothing here blocks or stops a session.
 */

/** Days the loop table shows by default; `--all` shows every stored day. */
export const LOOP_DAYS_SHOWN = 4;

/** The title the user gave a Claude Code session, from its transcript's last `TRANSCRIPT_TAIL_BYTES`. */
async function titleOf(transcripts: TranscriptSource, path: string): Promise<string | undefined> {
  const size = (await transcripts.size(path)) ?? 0;
  const length = Math.min(size, TRANSCRIPT_TAIL_BYTES);
  return length === 0 ? undefined : customTitleOf((await transcripts.read(path, size - length, length)).toString('utf8'));
}

function dayStartOf(at: number): number {
  return at - (at % MS_PER_DAY);
}

interface Reading {
  readonly now: number;
  readonly measured: Measured;
  readonly week: WeekReading;
  /** The account's week files the week was read in (`accountWeekOn`); a recount reads none, and names the team's own. */
  readonly weekPaths: TeamWeekPaths;
  readonly lifts: readonly Lift[];
  readonly bursts: readonly BurstRecord[];
}

interface ReadOptions {
  /** A past day to recount into memory, writing nothing; undefined measures up to now into the usage files. */
  readonly recountDay: number | undefined;
}

/** Measures every session up to now (or through the recounted day) and reads the week. */
async function readBudget(runtime: CliRuntime, kit: Kit, config: KitConfig, roster: Roster, options: ReadOptions): Promise<Reading> {
  const { files } = runtime;
  const recount = options.recountDay !== undefined;
  const now = options.recountDay === undefined ? runtime.clock.now() : options.recountDay + MS_PER_DAY - 1;
  const clock: Clock = { now: () => now };
  const { marks } = await new JsonlMarkLog(new PlainLogFile(files, kit.paths.inboxMarks)).read();
  const measured = await measure(
    {
      transcripts: runtime.transcripts,
      titleOf: (path) => titleOf(runtime.transcripts, path),
      team: recount ? new MemoryUsageStore() : new UsageStore(files, kit.paths.usage),
      outside: recount ? new MemoryUsageStore() : new UsageStore(files, join(kit.paths.usage, 'outside')),
      clock,
    },
    {
      projectsDir: claudeProjectsDir(runtime.env, runtime.userHome),
      since: options.recountDay ?? dayStartOf(now) - (CURSOR_DAYS_KEPT - 1) * MS_PER_DAY,
      team: kit.paths.team,
      roster,
      areaBySession: indexMarks(marks).areaBySession,
      subagentWeight: config.budget.subagentWeight,
      chunkBytes: CATCH_UP_CHUNK_BYTES,
      maxRuns: MAX_RUNS_PER_SESSION,
    },
  );
  const account = recount ? undefined : await accountWeekOn(runtime, config.budget, kit.paths, now);
  const states = [...measured.bySession.values(), measured.outside];
  const input = { budget: config.budget, now, statusUse: account?.statusUse, states };
  // A recount reads no team state, the meter log included: its rate is the configured one.
  const week =
    account === undefined
      ? readWeek({ ...input, period: recountPeriodOf(config.budget, now), calibration: calibrationOf([]), readings: [] })
      : await teamWeekOf(files, account.paths, input);
  const lifts = recount ? [] : (await new LiftLog(files, kit.paths.lifts).read()).lifts;
  const bursts = recount ? [] : (await new BurstLog(files, kit.paths.bursts).read()).records;
  return { now, measured, week, weekPaths: account?.paths ?? kit.paths, lifts, bursts };
}

/** The week now and each team session's usage, measured up to now as `budget` measures them. */
export interface UsageReading {
  readonly week: WeekReading;
  readonly bySession: ReadonlyMap<string, UsageState>;
}

/** The week and the team's usage now, for `burst`: its floor reads its sessions' use today. */
export async function usageReadingOf(runtime: CliRuntime, kit: Kit, config: KitConfig, roster: Roster): Promise<UsageReading> {
  const { week, measured } = await readBudget(runtime, kit, config, roster, { recountDay: undefined });
  return { week, bySession: measured.bySession };
}

/** The week's use line, measured up to now as `budget` measures it, for `start`. */
export async function weekLineOf(runtime: CliRuntime, kit: Kit, config: KitConfig, roster: Roster): Promise<string> {
  return weekLine((await usageReadingOf(runtime, kit, config, roster)).week, teamZone(config, runtime));
}

/** How the team's part of the day is split among its sessions: down its lead tree, by their queued work (`work`), the lifts in force and the sessions a short day may pause. */
function splitOf(reading: Reading, team: string, roster: Roster, config: Pick<KitConfig, 'budget' | 'leads' | 'roles'>, work: ReadonlyMap<string, WorkByPriority>): BudgetSplit {
  return budgetSplitOf({ team, ids: roster.ids, sessions: config.budget.sessions, leads: config.leads, work, pausable: pausableOf(config, team, roster.ids), lifts: reading.lifts, now: reading.now, usedPct: reading.week.usedPct });
}

/** Each session today: its use, and its part (`split`) of the team's part of the account's daily budget beside the `others` on it, its lift and the burst. */
function sessionsToday(reading: Reading, roster: Roster, budget: BudgetConfig, split: BudgetSplit, others: readonly BudgetSplit[]): SessionToday[] {
  const today = formatUtcDay(new Date(reading.now));
  const inForce = activeBurst(reading.bursts, reading.now, reading.week.usedPct);
  const burstNow: InBurst | undefined =
    inForce === undefined ? undefined : { burst: inForce, floorPct: burstFloorOf(inForce, reading.week, reading.measured.bySession, budget, reading.now) };
  return roster.ids.map((id) => {
    const state = reading.measured.bySession.get(id);
    const w = state === undefined ? 0 : wSince([state], reading.week.todayFrom, reading.now);
    const lift = activeLift(reading.lifts, id, reading.now, reading.week.usedPct);
    const inBurst = burstNow !== undefined && burstNow.burst.sessions.includes(id) ? burstNow : undefined;
    const budgetPct = withBurst(dailyBudgetOf(reading.week.allowancePct, id, split, others), inBurst?.floorPct);
    return { id, name: roster.nameOf(id) ?? id, w, calls: state?.byDay[today]?.calls ?? 0, budgetPct, lift, ...liftNamesOf(split, roster, id, lift), inBurst };
  });
}

/** Each sub-lead's group today: its part of the day (`groupPartsOf`) and its group lift by name. */
function groupsToday(reading: Reading, roster: Roster, split: BudgetSplit, others: readonly BudgetSplit[]): GroupToday[] {
  return groupPartsOf(reading.week.allowancePct, split, others).map((group) => {
    const lift = activeGroupLift(reading.lifts, group.id, reading.now, reading.week.usedPct);
    return { id: group.id, name: roster.nameOf(group.id) ?? group.id, sessions: group.sessions, budgetPct: group.budgetPct, lift, ...liftNamesOf(split, roster, group.id, lift) };
  });
}

/**
 * The lift of session `id`, or of the group sub-lead `id` leads, by name: the leader that gave it and the sub-lead
 * whose group's daily budget it is a part of (`split`'s tree).
 */
export function liftNamesOf(split: BudgetSplit, roster: Roster, id: string, lift: Lift | undefined): LiftNames {
  if (lift === undefined) {
    return { liftBy: undefined, liftParent: undefined };
  }
  const parent = liftPlaceOf(split, id, lift.group)?.parent;
  return { liftBy: roster.nameOf(lift.by) ?? lift.by, liftParent: parent === undefined ? undefined : (roster.nameOf(parent) ?? parent) };
}

/** The days a loop table shows, oldest first, ending at `now`'s day. */
function loopDays(now: number, count: number): string[] {
  return Array.from({ length: count }, (_, index) => formatUtcDay(new Date(now - (count - 1 - index) * MS_PER_DAY)));
}

/** A recount's period: it reads no stored state, so the week before the configured reset, a guess. */
function recountPeriodOf(budget: BudgetConfig, now: number): Period | undefined {
  const sight = sightOf(budget, undefined, now);
  return sight === undefined ? undefined : nextPeriod(undefined, sight);
}

function recountDayOf(text: string | undefined, now: number): number | undefined {
  if (text === undefined) {
    return undefined;
  }
  const day = parseUtcDay(text);
  if (day === undefined) {
    throw new UsageError(`--day "${text}" is not a YYYY-MM-DD day`);
  }
  if (day.getTime() > now) {
    throw new UsageError(`--day ${text} has not begun`);
  }
  return day.getTime();
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

/** `budget --task <id>`: each session's W on the task by UTC day, outside the team too, and today's share of W any task got. */
function taskReadingLines(reading: Reading, roster: Roster, task: string): string[] {
  const { measured, week, now } = reading;
  const states = new Map<string, UsageState>([...measured.bySession, [OUTSIDE_ID, measured.outside]]);
  const today = formatUtcDay(new Date(now));
  const usages = [...states.values()];
  return taskLines(taskUseOf(states, task), {
    week,
    nameOf: (session) => (session === OUTSIDE_ID ? 'outside the team' : (roster.nameOf(session) ?? session)),
    today: { w: sum(usages.map((state) => state.byDay[today]?.w ?? 0)), attributed: sum(usages.map((state) => attributedW(state, today))) },
  });
}

/** `budget [<session>] [--loops|--burn|--misses] [--day <day>] [--all]`, or `budget --task <id>` alone. */
export async function budget(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  const [target, extra] = args.positionals;
  if (extra !== undefined) {
    throw new UsageError(`unexpected "${extra}"`);
  }
  const recountDay = recountDayOf(args.flags.get('day'), runtime.clock.now());
  const all = args.switches.has('all');
  const loops = args.switches.has('loops');
  const burn = args.switches.has('burn');
  const misses = args.switches.has('misses');
  if ([loops, burn, misses].filter(Boolean).length > 1) {
    throw new UsageError('--loops, --burn and --misses are three tables: give one');
  }
  const task = args.flags.get('task');
  if (task !== undefined) {
    if (target !== undefined || recountDay !== undefined || all || loops || burn || misses) {
      throw new UsageError('--task reads alone: give no session, table, --day or --all with it');
    }
    if (!TASK_ID.test(task)) {
      throw new UsageError(`--task "${task}" is not a task id such as T734`);
    }
  }
  const kit = await openTeamKit(runtime);
  const config = requireConfig(kit, runtime, 'read');
  const roster = await rosterOf(runtime, kit, config);
  const id = target === undefined ? undefined : sessionIdOf(roster, target);
  const reading = await readBudget(runtime, kit, config, roster, { recountDay });
  if (task !== undefined) {
    for (const line of taskReadingLines(reading, roster, task)) {
      runtime.out.stdout(line);
    }
    return EXIT.ok;
  }
  const { weights: work } = recountDay === undefined ? await readWork(runtime.files, kit.paths.events, config.register.priorities) : NO_WORK;
  const split = splitOf(reading, kit.paths.team, roster, config, work);
  // A recount shows no budgets, so it reads no other team.
  const others = recountDay === undefined ? await otherTeamsOnAccount(runtime, { team: kit.paths.team, config, usageDir: kit.paths.usage }, reading.now, reading.week.usedPct) : [];
  const sessions = sessionsToday(reading, roster, config.budget, split, others);
  const teamPct = teamPartOf(reading.week.allowancePct, split, others);
  const { measured, week, now } = reading;
  const zone = teamZone(config, runtime);
  let lines: string[];
  const days = recountDay === undefined ? loopDays(now, all ? DAYS_KEPT : LOOP_DAYS_SHOWN) : [formatUtcDay(new Date(recountDay))];
  const source = recountDay === undefined ? 'metered' : 'recounted';
  if (misses && id === undefined) {
    const rows = roster.ids.map((each) => ({ name: roster.nameOf(each) ?? each, usage: sumUsage(sumDays([measured.bySession.get(each) ?? EMPTY_USAGE], days)) }));
    lines = missMatrixLines(days, rows);
  } else if (loops || burn || misses) {
    const states: UsageState[] = id === undefined ? [...measured.bySession.values(), measured.outside] : [measured.bySession.get(id) ?? EMPTY_USAGE];
    const table = loops ? loopLines : burn ? burnLines : missLines;
    lines = table(id === undefined ? 'every session, outside the team too' : (roster.nameOf(id) ?? id), days, sumDays(states, days), source);
  } else if (id !== undefined) {
    const session = sessions.find((each) => each.id === id);
    const state = measured.bySession.get(id);
    lines = session === undefined || state === undefined ? [] : sessionLines(session, state, week, zone);
  } else {
    const today = formatUtcDay(new Date(now));
    const outsideToday = measured.outside.byDay[today];
    const outside = { w: wSince([measured.outside], week.todayFrom, now), calls: outsideToday?.calls ?? 0, sessions: measured.outsideSessions, titles: measured.outsideTitles };
    const behind = measured.behind.map((each) => (each === OUTSIDE_ID ? 'outside the team' : (roster.nameOf(each) ?? each)));
    lines = recountDay === undefined ? todayLines({ week, teamPct, sessions, groups: groupsToday(reading, roster, split, others), outside, behind, all, zone }) : recountLines(today, { week, sessions, outside, all });
  }
  for (const line of lines) {
    runtime.out.stdout(line);
  }
  return EXIT.ok;
}

/** A percent flag: above 0 and up to 100, or undefined when it is not given. */
export function pctFlag(flags: Flags, name: string): number | undefined {
  const text = flags.get(name);
  if (text === undefined) {
    return undefined;
  }
  const value = Number(text);
  if (text.trim() === '' || !Number.isFinite(value) || value <= 0 || value > 100) {
    throw new UsageError(`--${name} "${text}" is not a percent above 0 and up to 100`);
  }
  return value;
}

/** A time flag such as `--until`: `HH:MM` today or `YYYY-MM-DD HH:MM`, on the team's clock unless marked UTC; undefined when it is not given. */
export function timeFlag(flags: Flags, name: string, times: TypedTimes): number | undefined {
  const text = flags.get(name);
  if (text === undefined) {
    return undefined;
  }
  const at = typedDeadline(text, times.nowMs, times.zone);
  if (at === undefined) {
    throw new UsageError(`--${name} "${text}" is not ${typedTimeHint(times.zone, times.nowMs)}`);
  }
  return at.getTime();
}

/** `a`, `a or b`, `a, b or c`. */
function orList(words: readonly string[]): string {
  return words.length <= 1 ? words.join('') : `${words.slice(0, -1).join(', ')} or ${words.at(-1) ?? ''}`;
}

/**
 * Why session `by` may not lift session `id`'s daily budget, or with `group` sub-lead `id`'s group's; undefined when it
 * may. A leader lifts every session and sub-lead's group under it, at any depth, and a sub-lead its own session too,
 * a part of its own group's budget; the lead's group is the whole team, which no lift takes a part of.
 */
function liftRefusalOf(tree: LeadTree, nameOf: (id: string) => string, by: string, id: string, group: boolean): string | undefined {
  const name = nameOf(id);
  if (group) {
    if (id === tree.lead) {
      return `--group lifts a sub-lead's group; ${name} is the lead, whose group is the whole team`;
    }
    if (!tree.isLeader(id)) {
      return `--group lifts a sub-lead's group, and ${name} leads none`;
    }
    return tree.leads(by, id) ? undefined : `${name}'s group's budget is lifted only by ${orList(tree.chainOf(id).map(nameOf))}`;
  }
  if (tree.leads(by, id) || (by === id && tree.isLeader(by))) {
    return undefined;
  }
  return `${name}'s budget is lifted only by ${orList([...(tree.isLeader(id) ? [id] : []), ...tree.chainOf(id)].map(nameOf))}`;
}

/**
 * What a lift too big for sub-lead `group`'s group's budget can do instead, for its refusal: the lift of that group its
 * leader (`leader`) can give, after the group's budget and use today in percent of the week, each left out when unknown.
 */
function beyondGroupText(group: string, leader: string, budgetPct: number | undefined, usedPct: number | undefined): string {
  const facts = [budgetPct === undefined ? undefined : `gets ${formatPct(budgetPct)} of the week today`, usedPct === undefined ? undefined : `has used ${formatPct(usedPct)}`];
  const known = facts.filter((each): each is string => each !== undefined);
  const command = `\`teamrig budget lift ${group} --group --part <pct> --stop-pct <n> --reason "<why>"\``;
  return known.length === 0 ? `${leader} can lift ${group}'s group: ${command}` : `${group}'s group ${known.join(' and ')}; ${leader} can lift it: ${command}`;
}

/**
 * `budget lift <session> [--group] --part <pct> --stop-pct <n> [--until <time>] [--reserve] --reason "<text>"`: a
 * leader lifts a session under it, or with `--group` the group of a sub-lead under it (`liftRefusalOf`).
 */
export async function lift(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  const caller = callerOf(args.flags, runtime.env);
  const target = onePositional(args, 'session');
  const partPct = pctFlag(args.flags, 'part');
  if (partPct === undefined) {
    throw new UsageError('--part is required');
  }
  const stopPct = pctFlag(args.flags, 'stop-pct');
  const reason = requiredFlag(args.flags, 'reason').trim();
  if (reason === '') {
    throw new UsageError('--reason needs a reason');
  }
  const now = runtime.clock.now();
  const kit = await openTeamKit(runtime);
  const config = requireConfig(kit, runtime, 'write');
  const zone = teamZone(config, runtime);
  const until = timeFlag(args.flags, 'until', { nowMs: now, zone });
  const roster = await rosterOf(runtime, kit, config);
  const nameOf = (each: string): string => roster.nameOf(each) ?? each;
  const by = sessionIdOf(roster, caller);
  const id = sessionIdOf(roster, target);
  const group = args.switches.has('group');
  const tree = new LeadTree(config);
  const refusal = liftRefusalOf(tree, nameOf, by, id, group);
  if (refusal !== undefined) {
    throw new RefusedError(refusal);
  }
  const name = nameOf(id);
  const reading = await readBudget(runtime, kit, config, roster, { recountDay: undefined });
  const { week } = reading;
  const { weights: work } = await readWork(runtime.files, kit.paths.events, config.register.priorities);
  const split = splitOf(reading, kit.paths.team, roster, config, work);
  const place = liftPlaceOf(split, id, group);
  if (place === undefined) {
    throw new RefusedError(`${group ? `${name}'s group` : name} has no daily budget to lift: \`leads\` lists it in a loop of sub-leads no leader above reaches`);
  }
  const parent = parentBudgetText(place.parent === undefined ? undefined : nameOf(place.parent));
  let beyondParent: string | undefined;
  if (place.parent !== undefined) {
    const others = await otherTeamsOnAccount(runtime, { team: kit.paths.team, config, usageDir: kit.paths.usage }, reading.now, week.usedPct);
    const part = groupPartsOf(week.allowancePct, split, others).find((each) => each.id === place.parent);
    const states = (part?.sessions ?? []).flatMap((each) => reading.measured.bySession.get(each) ?? []);
    const usedPct = week.todayWPerPct === undefined || part === undefined ? undefined : wSince(states, week.todayFrom, reading.now) / week.todayWPerPct;
    beyondParent = beyondGroupText(nameOf(place.parent), nameOf(tree.leaderOf(place.parent) ?? tree.lead), part?.budgetPct, usedPct);
  }
  const decision = decideLift(
    { session: id, group, partPct, stopPct, until, reserve: args.switches.has('reserve'), reason, by, now },
    { usedPct: week.usedPct, reset: week.reset, limits: config.budget.lift, liftedPct: place.liftedPct, parent, beyondParent, zone },
  );
  if (decision.kind === 'refused') {
    throw new RefusedError(decision.reason);
  }
  await new LiftLog(runtime.files, kit.paths.lifts).append(decision.lift);
  runtime.out.stdout(`LIFTED ${liftText(decision.lift, name, parent, zone)}`);
  return EXIT.ok;
}

/** A dollar flag: `--add` above 0, `--spent` 0 or more; undefined when it is not given. */
function usdFlag(flags: Flags, name: 'add' | 'spent'): number | undefined {
  const text = flags.get(name);
  if (text === undefined) {
    return undefined;
  }
  const value = Number(text);
  const tooSmall = name === 'add' ? value <= 0 : value < 0;
  if (text.trim() === '' || !Number.isFinite(value) || tooSmall) {
    throw new UsageError(`--${name} "${text}" is not a dollar amount ${name === 'add' ? 'above 0' : 'of 0 or more'}`);
  }
  return value;
}

/**
 * `budget extra [--add <usd>] [--spent <usd>]`: the extra-usage pool (budget/extra.ts). An add of the dollars put in
 * the pool, or a reading of the dollars claude.ai shows spent from it so far, is the lead's and goes to the extra log
 * with the week's use and the W metered since the period's start; then, or with no flag, the week line names the pool.
 */
export async function extra(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  const [stray] = args.positionals;
  if (stray !== undefined) {
    throw new UsageError(`unexpected "${stray}"`);
  }
  const added = usdFlag(args.flags, 'add');
  const spent = usdFlag(args.flags, 'spent');
  const writes = added !== undefined || spent !== undefined;
  const caller = writes ? callerOf(args.flags, runtime.env) : undefined;
  const kit = await openTeamKit(runtime);
  const config = requireConfig(kit, runtime, writes ? 'write' : 'read');
  const roster = await rosterOf(runtime, kit, config);
  if (caller !== undefined) {
    leadOnly(roster, caller, 'enters the extra-usage pool');
    const { week, measured, now, weekPaths } = await readBudget(runtime, kit, config, roster, { recountDay: undefined });
    const window = week.window;
    if (window === undefined) {
      throw new RefusedError("the week's period is unknown (no status line reading and no budget.weeklyLimitW), so the entry has no period to belong to");
    }
    const entry: Omit<ExtraEntry, 'kind' | 'usd'> = {
      at: now,
      weekPct: week.statusAt === undefined ? undefined : week.usedPct,
      start: window.start,
      end: window.reset,
      w: wSince([...measured.bySession.values(), measured.outside], window.start, now),
    };
    const log = new ExtraLog(runtime.files, weekPaths.extraLog);
    const logged: string[] = [];
    if (added !== undefined) {
      await log.append({ ...entry, kind: 'add', usd: added });
      logged.push(`added ${formatUsd(added)} to the pool`);
    }
    if (spent !== undefined) {
      await log.append({ ...entry, kind: 'spent', usd: spent });
      logged.push(`${formatUsd(spent)} spent from it so far`);
    }
    runtime.out.stdout(`EXTRA ${logged.join('; ')}.`);
  }
  // Read again after an entry: the pool, and past 100% of the week the team's allowance, now count it.
  const { week } = await readBudget(runtime, kit, config, roster, { recountDay: undefined });
  runtime.out.stdout(weekLine(week, teamZone(config, runtime)));
  if (week.pool === undefined) {
    runtime.out.stdout('Extra usage: none in the pool (the lead adds the dollars put in it: teamrig budget extra --add <usd>).');
  }
  return EXIT.ok;
}

/** Where the status line saves its snapshot, and what it shows. */
interface StatusLineSetup {
  readonly snapshotDir: string;
  readonly show: StatusLineConfig;
}

/** The status line setup of the team the session works in; outside a team, or with its config unreadable, the kit's default folder and display. */
async function statusLineSetup(runtime: CliRuntime, cwd: string): Promise<StatusLineSetup> {
  const fallback: StatusLineSetup = { snapshotDir: defaultSnapshotDir(resolveKitHome(runtime.env, runtime.userHome)), show: DEFAULT_STATUS_LINE };
  const found = await resolveTeam(runtime.files, runtime.env, teamFolders(runtime.env, [cwd === '' ? undefined : cwd, runtime.cwd]));
  if (found.kind !== 'team') {
    return fallback;
  }
  const kit = await openKit(runtime, found.team);
  if (kit.load.status !== 'loaded') {
    return fallback;
  }
  return { snapshotDir: snapshotDirOf(kit.load.config.budget, kit.paths), show: kit.load.config.statusLine };
}

/** Where the session in `dir` works, as far as `show` asks: git is asked only for a branch it shows, and for the commit only on a detached HEAD. */
function statusLineView(git: Pick<RepoState, 'branch' | 'head'>, dir: string, show: StatusLineConfig): StatusLineView {
  const branch = show.branch ? git.branch(dir) : undefined;
  const commit = show.branch && branch === undefined ? git.head(dir) : undefined;
  return {
    ...(show.folder ? { folder: basename(dir) } : {}),
    ...(branch === undefined ? {} : { branch }),
    ...(commit === undefined ? {} : { commit }),
    resume: show.resume,
  };
}

/** Folds the saved snapshot into the folder's week summary (`foldIntoWeekSummary`); a failure is told on stderr, never breaking the status bar. */
async function foldQuietly(runtime: CliRuntime, dir: string, snapshot: StatusSnapshot): Promise<void> {
  try {
    await foldIntoWeekSummary(runtime.files, dir, snapshot, runtime.clock.now());
  } catch (error) {
    runtime.out.stderr(`teamrig statusline: the week summary was not updated: ${errorMessage(error)}`);
  }
}

/** Prunes the snapshot folder's old snapshots and left temporaries (`pruneSnapshots`); a failure is told on stderr, never breaking the status bar. */
async function pruneQuietly(runtime: CliRuntime, dir: string): Promise<void> {
  try {
    await pruneSnapshots(runtime.files, dir, runtime.clock.now());
  } catch (error) {
    runtime.out.stderr(`teamrig statusline: old snapshots were not pruned: ${errorMessage(error)}`);
  }
}

/**
 * `statusline`: Claude Code's status line. It saves the status input's reading (the plan's use of the
 * week and its reset) as a snapshot for `budget`, dated by the session's previous snapshot (when the
 * session began to show it, and when it last showed another), folds it into the folder's week summary (the
 * newest reading, which readers open instead of every snapshot), removes the folder's snapshots written more
 * than 8 days ago (at most one sweep an hour), and prints a short status: the model, the session's
 * folder and branch, the plan's use and the command that resumes the session, as the team's `statusLine`
 * config shows them. It always exits 0, so a bad input or a full disk never breaks the status bar; what
 * went wrong goes to stderr. With --pass it prints the status input again instead of its own status, for
 * the status line after it in a pipe (`statusline install` puts it in front of one already there).
 */
export async function statusline(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  const [extra] = args.positionals;
  if (extra !== undefined) {
    throw new UsageError(`unexpected "${extra}"`);
  }
  const input = await runtime.readStdin();
  const pass = args.switches.has('pass');
  const passed = input.replace(/\r?\n$/, '');
  const snapshot = snapshotOfStatus(input, runtime.clock.now());
  if (snapshot === undefined) {
    runtime.out.stdout(pass ? passed : 'Claude');
    runtime.out.stderr('teamrig statusline: the status input is not Claude Code status JSON with a session id; nothing saved');
    return EXIT.ok;
  }
  let show = DEFAULT_STATUS_LINE;
  try {
    const setup = await statusLineSetup(runtime, snapshot.cwd);
    show = setup.show;
    const path = join(setup.snapshotDir, `${snapshot.sessionId}.json`);
    const previous = await runtime.files.read(path);
    const dated = datedSnapshot(snapshot, previous === undefined ? undefined : parseSnapshot(previous));
    await runtime.files.write(path, formatSnapshot(dated));
    await foldQuietly(runtime, setup.snapshotDir, dated);
    await pruneQuietly(runtime, setup.snapshotDir);
  } catch (error) {
    runtime.out.stderr(`teamrig statusline: the snapshot was not saved: ${errorMessage(error)}`);
  }
  const dir = snapshot.cwd === '' ? runtime.cwd : snapshot.cwd;
  runtime.out.stdout(pass ? passed : statusLineText(snapshot, statusLineView(runtime.git, dir, show)));
  return EXIT.ok;
}
