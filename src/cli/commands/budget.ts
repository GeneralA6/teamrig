import { basename, isAbsolute, join } from 'node:path';
import { DEFAULT_STATUS_LINE } from '../../config/defaults.ts';
import type { Roster } from '../../config/roster.ts';
import type { BudgetConfig, KitConfig, StatusLineConfig } from '../../config/types.ts';
import { errorMessage } from '../../core/guards.ts';
import { resolveKitHome, type TeamPaths } from '../../core/home.ts';
import type { Clock } from '../../core/lock.ts';
import { resolveTeam } from '../../core/team.ts';
import { formatUtcDay, MS_PER_DAY, parseUtcDay, typedDeadline, typedTimeHint } from '../../core/time.ts';
import { activeBurst, withBurst, type BurstRecord } from '../../budget/burst.ts';
import { BurstLog } from '../../budget/burst-log.ts';
import { claudeProjectsDir, type TranscriptSource } from '../../budget/discover.ts';
import { activeLift, decideLift, LiftLog, liftText, type Lift } from '../../budget/lift.ts';
import { CATCH_UP_CHUNK_BYTES, MAX_RUNS_PER_SESSION, measure, OUTSIDE_ID, type Measured } from '../../budget/measure.ts';
import { dailyBudgetOf, liftedParts, type BudgetSplit } from '../../budget/parts.ts';
import { nextPeriod, PeriodStore, sightOf, type Period } from '../../budget/period.ts';
import {
  burnLines,
  loopLines,
  missLines,
  missMatrixLines,
  recountLines,
  sessionLines,
  sumDays,
  sumUsage,
  todayLines,
  weekLine,
  type SessionToday,
} from '../../budget/report.ts';
import { datedSnapshot, formatSnapshot, parseSnapshot, readSnapshots, snapshotOfStatus, statusLineText, weekUseOf, type StatusLineView } from '../../budget/snapshot.ts';
import { CURSOR_DAYS_KEPT, DAYS_KEPT, EMPTY_USAGE, MemoryUsageStore, UsageStore, type UsageState } from '../../budget/store.ts';
import { meteredOf, readWeek, wSince, type WeekReading } from '../../budget/week.ts';
import { readWork } from '../../budget/work.ts';
import { JsonlMarkLog } from '../../inbox/store.ts';
import { indexMarks } from '../../inbox/marks.ts';
import type { RepoState } from '../../push-guard/push.ts';
import { customTitleOf, TRANSCRIPT_TAIL_BYTES } from '../../names/title.ts';
import { UsageError, onePositional, requiredFlag, type Flags, type ParsedArgs } from '../args.ts';
import { callerOf, type TypedTimes } from '../inputs.ts';
import { openKit, openTeamKit, requireConfig, rosterOf, sessionIdOf, teamFolders, teamZone, type Kit } from '../kit.ts';
import { EXIT, RefusedError, type CliRuntime, type ExitCode } from '../runtime.ts';

/**
 * The weekly budget from the command line: `budget` measures every session's use from the Claude Code
 * transcripts and shows it against the week's pace; `budget lift` is the lead's lift of one session's
 * daily budget; `statusline` is a status line that saves the plan's own reading for `budget`. Measuring
 * and showing only: nothing here blocks or stops a session.
 */

/** Days the loop table shows by default; `--all` shows every stored day. */
export const LOOP_DAYS_SHOWN = 4;

/** Where the status line snapshots are: `budget.statusSnapshotDir` (relative to the team's folder), else `<kit home>/usage/live`. */
export function snapshotDirOf(budget: Pick<BudgetConfig, 'statusSnapshotDir'>, paths: Pick<TeamPaths, 'home' | 'kitHome'>): string {
  const dir = budget.statusSnapshotDir;
  if (dir === undefined) {
    return defaultSnapshotDir(paths.kitHome);
  }
  return isAbsolute(dir) ? dir : join(paths.home, dir);
}

export function defaultSnapshotDir(kitHome: string): string {
  return join(kitHome, 'usage', 'live');
}

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
  const { marks } = await new JsonlMarkLog(files, kit.paths.inboxMarks).read();
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
      roster,
      areaBySession: indexMarks(marks).areaBySession,
      subagentWeight: config.budget.subagentWeight,
      chunkBytes: CATCH_UP_CHUNK_BYTES,
      maxRuns: MAX_RUNS_PER_SESSION,
    },
  );
  const snapshots = recount ? [] : await readSnapshots(files, snapshotDirOf(config.budget, kit.paths));
  const statusUse = weekUseOf(snapshots, now);
  const states = [...measured.bySession.values(), measured.outside];
  const period = recount
    ? recountPeriodOf(config.budget, now)
    : await new PeriodStore(files, kit.paths.period).periodAt(config.budget, statusUse, now, meteredOf(config.budget, states, now));
  const week = readWeek({ budget: config.budget, now, statusUse, period, states });
  const lifts = recount ? [] : (await new LiftLog(files, kit.paths.lifts).read()).lifts;
  const bursts = recount ? [] : (await new BurstLog(files, kit.paths.bursts).read()).records;
  return { now, measured, week, lifts, bursts };
}

/** The week now, measured up to now as `budget` measures it, for `burst`. */
export async function weekReadingOf(runtime: CliRuntime, kit: Kit, config: KitConfig, roster: Roster): Promise<WeekReading> {
  return (await readBudget(runtime, kit, config, roster, { recountDay: undefined })).week;
}

/** The week's use line, measured up to now as `budget` measures it, for `start`. */
export async function weekLineOf(runtime: CliRuntime, kit: Kit, config: KitConfig, roster: Roster): Promise<string> {
  return weekLine(await weekReadingOf(runtime, kit, config, roster), teamZone(config, runtime));
}

/** Each session today: its use, and its part of the team's daily budget by its queued work (`work`), its lift and the burst. */
function sessionsToday(reading: Reading, roster: Roster, budget: BudgetConfig, work: ReadonlyMap<string, number>): SessionToday[] {
  const today = formatUtcDay(new Date(reading.now));
  const inForce = activeBurst(reading.bursts, reading.now, reading.week.usedPct);
  const split: BudgetSplit = { ids: roster.ids, sessions: budget.sessions, work, lifted: liftedParts(reading.lifts, roster.ids, reading.now, reading.week.usedPct) };
  return roster.ids.map((id) => {
    const state = reading.measured.bySession.get(id);
    const w = state === undefined ? 0 : wSince([state], reading.week.todayFrom, reading.now);
    const lift = activeLift(reading.lifts, id, reading.now, reading.week.usedPct);
    const burst = inForce !== undefined && inForce.sessions.includes(id) ? inForce : undefined;
    const budgetPct = withBurst(dailyBudgetOf(reading.week.allowancePct, id, split), burst, id);
    return { id, name: roster.nameOf(id) ?? id, w, calls: state?.byDay[today]?.calls ?? 0, budgetPct, lift, burst };
  });
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

/** `budget [<session>] [--loops|--burn|--misses] [--day <day>] [--all]`. */
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
  const kit = await openTeamKit(runtime);
  const config = requireConfig(kit, runtime, 'read');
  const roster = await rosterOf(runtime, kit, config);
  const id = target === undefined ? undefined : sessionIdOf(roster, target);
  const reading = await readBudget(runtime, kit, config, roster, { recountDay });
  const work = recountDay === undefined ? await readWork(runtime.files, kit.paths.events, config.register.priorities) : new Map<string, number>();
  const sessions = sessionsToday(reading, roster, config.budget, work);
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
    lines = recountDay === undefined ? todayLines({ week, sessions, outside, behind, all, zone }) : recountLines(today, { week, sessions, outside, all });
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

/** `budget lift <session> --part <pct> --stop-pct <n> [--until <time>] [--reserve] --reason "<text>"`: the lead only. */
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
  const by = sessionIdOf(roster, caller);
  const lead = roster.holderOf('lead');
  if (by !== lead) {
    throw new RefusedError(`only the lead${lead === undefined ? '' : ` (${roster.nameOf(lead) ?? lead})`} lifts a session's budget`);
  }
  const id = sessionIdOf(roster, target);
  const { week, lifts } = await readBudget(runtime, kit, config, roster, { recountDay: undefined });
  const others = liftedParts(lifts, roster.ids.filter((each) => each !== id), now, week.usedPct);
  const decision = decideLift(
    { session: id, partPct, stopPct, until, reserve: args.switches.has('reserve'), reason, by, now },
    { usedPct: week.usedPct, reset: week.reset, limits: config.budget.lift, liftedPct: [...others.values()].reduce((sum, part) => sum + part, 0), zone },
  );
  if (decision.kind === 'refused') {
    throw new RefusedError(decision.reason);
  }
  await new LiftLog(runtime.files, kit.paths.lifts).append(decision.lift);
  runtime.out.stdout(`LIFTED ${liftText(decision.lift, roster.nameOf(id) ?? id, zone)}`);
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

/**
 * `statusline`: Claude Code's status line. It saves the status input's reading (the plan's use of the
 * week and its reset) as a snapshot for `budget`, dated by the session's previous snapshot (when the
 * session began to show it, and when it last showed another), and prints a short status: the model, the session's
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
    await runtime.files.write(path, formatSnapshot(datedSnapshot(snapshot, previous === undefined ? undefined : parseSnapshot(previous))));
  } catch (error) {
    runtime.out.stderr(`teamrig statusline: the snapshot was not saved: ${errorMessage(error)}`);
  }
  const dir = snapshot.cwd === '' ? runtime.cwd : snapshot.cwd;
  runtime.out.stdout(pass ? passed : statusLineText(snapshot, statusLineView(runtime.git, dir, show)));
  return EXIT.ok;
}
