import { join } from 'node:path';
import { formatW } from '../budget/format.ts';
import { parseRollup, rollupDayOf, type TeamDayRollup } from '../budget/rollup-file.ts';
import { planUse, type ClassUse, type PlanUse, type TaskPlace, type UseTotal } from '../budget/rollup-use.ts';
import type { FocusConfig } from '../config/types.ts';
import { MS_PER_DAY } from '../core/time.ts';
import { inWeek } from '../register/done-groups.ts';
import { classOf } from '../register/focus.ts';
import type { RegisterSnapshot } from '../register/snapshot.ts';
import type { StatsScope } from '../register/stats.ts';
import { weekTagAt, weekTagsOf } from '../register/week-tags.ts';
import { teamZone } from './kit.ts';
import type { RolledTeam } from './roll-up.ts';
import type { CliRuntime } from './runtime.ts';

/** A team of a roll-up with its whole history, read once for all of `stats`. */
export interface TeamHistory {
  readonly rolled: RolledTeam;
  readonly history: RegisterSnapshot;
}

export interface UseLinesInput {
  readonly teams: readonly TeamHistory[];
  /** The focus the shares are read against: the caller's team's, in a tree too. */
  readonly focus: FocusConfig;
  /** The days of the range, as `stats` lists them. */
  readonly days: readonly string[];
  readonly scope?: StatsScope;
}

const SECONDS_PER_MINUTE = 60;

/**
 * Where a team's work on a task counts on a UTC day. A task is planned that day when the tag in force at the day's end
 * names a week holding the day's noon: a tag set mid-week reads planned from that day on, and a later retag leaves the
 * days before it as they were. A task the team's events never name was another register's, read by its tag of today.
 */
function placerOf({ rolled, history }: TeamHistory, runtime: CliRuntime): (day: string, id: string) => TaskPlace {
  const { focus, register } = rolled.config;
  const zone = teamZone(rolled.config, runtime);
  const tags = weekTagsOf(history.read.events);
  return (day, id) => {
    const task = history.state.tasks.get(id) ?? rolled.elsewhere.get(id)?.task;
    const noon = Date.parse(`${day}T12:00:00.000Z`);
    const held = tags.get(id);
    const week = held === undefined ? (task?.week ?? null) : weekTagAt(held, noon + MS_PER_DAY / 2);
    return { workClass: classOf({ workClass: task?.workClass ?? null }, focus), planned: week !== null && inWeek(week, noon, zone, register.check.weekLengthDays) };
  };
}

/** The team's rollup files of `days`; a damaged one is named and left out, so it shows as a day short and never as a low day. */
async function rolledDays(runtime: CliRuntime, { paths }: RolledTeam, days: ReadonlySet<string>): Promise<readonly TeamDayRollup[]> {
  const read: TeamDayRollup[] = [];
  for (const name of (await runtime.files.list(paths.rollup)).sort()) {
    const day = rollupDayOf(name);
    if (day === undefined || !days.has(day)) {
      continue;
    }
    const path = join(paths.rollup, name);
    const parsed = parseRollup((await runtime.files.read(path)) ?? '');
    if (parsed === undefined) {
      runtime.out.stderr(`WARN ${path}: damaged or from a newer teamrig, left out of the USE lines`);
    } else {
      read.push(parsed);
    }
  }
  return read;
}

function totalText({ w, seconds }: UseTotal): string {
  return `${formatW(w)} W, ${Math.round(seconds / SECONDS_PER_MINUTE)} min`;
}

function sumOf(a: UseTotal, b: UseTotal): UseTotal {
  return { w: a.w + b.w, seconds: a.seconds + b.seconds };
}

/** A share against its target, its gap in whole points so the line's numbers add up as printed. */
function shareText(pct: number | null, targetPct: number | null): string {
  const share = pct === null ? null : Math.round(pct);
  const target = targetPct === null ? '' : `, target ${targetPct}%`;
  const gap = share === null || targetPct === null ? '' : `, gap ${share >= targetPct ? '+' : ''}${share - targetPct}`;
  return `${share === null ? 'none' : `${share}%`} of task W${target}${gap}`;
}

function splitText({ planned, unplanned }: Pick<PlanUse, 'planned' | 'unplanned'>): string {
  return `planned ${totalText(planned)}; unplanned ${totalText(unplanned)}`;
}

function classLine(use: ClassUse): string {
  return `USE ${use.workClass} ${shareText(use.sharePct, use.targetPct)}: ${splitText(use)}`;
}

/**
 * The lines of T2076's 3A: how much of the range's task W the plan held, and each class against `focus.allocation`,
 * from the daily rollups, so only closed UTC days count: today has no file yet. W is raw, as the rollup holds it.
 */
export async function useLines(runtime: CliRuntime, { teams, focus, days, scope }: UseLinesInput): Promise<string[]> {
  const inRange = new Set(days);
  const rolled: TeamDayRollup[] = [];
  const placers = new Map<string, (day: string, id: string) => TaskPlace>();
  for (const team of teams) {
    rolled.push(...(await rolledDays(runtime, team.rolled, inRange)));
    placers.set(team.rolled.team, placerOf(team, runtime));
  }
  const rolledUp = new Set(rolled.map((day) => day.day)).size;
  const span = `USE ${rolledUp} of ${days.length} days rolled up`;
  if (rolledUp === 0) {
    return [`${span}: teamrig budget rollup --apply writes the closed days`];
  }
  const use = planUse({
    days: rolled,
    placeOf: (team, day, task) => placers.get(team)?.(day, task) ?? { workClass: focus.defaultClass, planned: false },
    focus,
    ...(scope === undefined ? {} : { session: scope }),
  });
  return [`${span}: task work ${totalText(sumOf(use.planned, use.unplanned))}; no task ${totalText(use.noTask)}`, `USE planned ${shareText(use.coveragePct, use.targetPct)}: ${splitText(use)}`, ...use.classes.map(classLine)];
}
