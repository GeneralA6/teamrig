import { transcriptTitleOf } from '../../budget/attribute.ts';
import { claudeProjectsDir, discoverTranscripts } from '../../budget/discover.ts';
import { CATCH_UP_CHUNK_BYTES } from '../../budget/measure.ts';
import { applyPlans, attributeInTree, foldTeam, outcomeCounts, planDays, type DayPlan, type RollupRange, type TreeMember } from '../../budget/rollup-run.ts';
import { rollupFileName } from '../../budget/rollup-file.ts';
import { PlainLogFile } from '../../core/log-file.ts';
import { addUtcDays, formatUtcDay, MS_PER_DAY, parseUtcDay } from '../../core/time.ts';
import { indexMarks } from '../../inbox/marks.ts';
import { JsonlMarkLog } from '../../inbox/store.ts';
import { noPositionals, UsageError, type ParsedArgs } from '../args.ts';
import { openTeamKit, requireConfig, rosterOf, type Kit } from '../kit.ts';
import { logRollupRun } from '../rollup-start.ts';
import { EXIT, type CliRuntime, type ExitCode } from '../runtime.ts';
import { loadTree, type KitTree } from '../tree.ts';

/**
 * `budget rollup`: the team's closed UTC days, read from the Claude Code transcripts into a file per day (budget/
 * rollup-file.ts). Without --apply it only counts what a run would do, rule 11's dry run. A day already on disk that now
 * reads differently stays unless --rewrite is given: Claude Code prunes old transcripts, so a later reading of a day can
 * be the poorer one. A full read of the transcripts, so it stays out of every hook: the day start starts it on its own.
 */

/** The newest day the team's rollup folder holds; undefined when it holds none. */
async function newestRolledDay(runtime: CliRuntime, kit: Kit): Promise<string | undefined> {
  const days = (await runtime.files.list(kit.paths.rollup)).flatMap((name) => {
    const day = name.slice(0, -rollupFileName('').length);
    return name === rollupFileName(day) && parseUtcDay(day) !== undefined ? [day] : [];
  });
  return days.sort().at(-1);
}

function dayFlag(args: ParsedArgs, name: string, today: string): string | undefined {
  const day = args.flags.get(name);
  if (day === undefined) {
    return undefined;
  }
  if (parseUtcDay(day) === undefined) {
    throw new UsageError(`--${name} "${day}" is not a day, YYYY-MM-DD`);
  }
  if (day >= today) {
    throw new UsageError(`--${name} ${day} is not a closed day: the last closed UTC day is the one before ${today}`);
  }
  return day;
}

/** The days to read: --from and --to, else the day after the newest on disk, or yesterday alone, through yesterday. */
async function rangeOf(args: ParsedArgs, runtime: CliRuntime, kit: Kit, today: string): Promise<RollupRange | undefined> {
  const from = dayFlag(args, 'from', today);
  const to = dayFlag(args, 'to', today) ?? addUtcDays(today, -1) ?? today;
  if (from !== undefined && from > to) {
    throw new UsageError(`--from ${from} is after --to ${to}`);
  }
  const newest = await newestRolledDay(runtime, kit);
  const start = from ?? (newest === undefined ? to : (addUtcDays(newest, 1) ?? to));
  return start > to ? undefined : { from: start, to };
}

/** The teams of `team`'s tree, each with its inbox marks, in the one order every team's run reads them in. */
async function treeMembersOf(runtime: CliRuntime, { tree, teams }: KitTree, team: string): Promise<readonly TreeMember[]> {
  const members: TreeMember[] = [];
  for (const [id, { kit, roster }] of teams) {
    if (tree.sameTree(id, team)) {
      const { marks } = await new JsonlMarkLog(new PlainLogFile(runtime.files, kit.paths.inboxMarks)).read();
      members.push({ team: id, roster, areaBySession: indexMarks(marks).areaBySession });
    }
  }
  return members;
}

function planLine(plan: DayPlan): string {
  return `  ${plan.day} ${plan.outcome}: ${plan.rows} rows, ${plan.tasks} task rows, ${plan.bytes} bytes`;
}

/** `budget rollup [--from <day>] [--to <day>] [--apply] [--rewrite]`. */
export async function rollup(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  noPositionals(args);
  const apply = args.switches.has('apply');
  const rewrite = args.switches.has('rewrite');
  if (rewrite && !apply) {
    throw new UsageError('--rewrite needs --apply');
  }
  const kit = await openTeamKit(runtime);
  const config = requireConfig(kit, runtime, 'read');
  const now = runtime.clock.now();
  const range = await rangeOf(args, runtime, kit, formatUtcDay(new Date(now)));
  if (range === undefined) {
    runtime.out.stdout(`UP TO DATE ${kit.paths.rollup}: nothing to roll up`);
    if (apply) {
      await logRollupRun(runtime, kit, now, 'UP TO DATE: nothing to roll up');
    }
    return EXIT.ok;
  }
  const team = kit.paths.team;
  const roster = await rosterOf(runtime, kit, config);
  const since = (parseUtcDay(range.from) ?? new Date(now - MS_PER_DAY)).getTime();
  const sessions = await discoverTranscripts(runtime.transcripts, claudeProjectsDir(runtime.env, runtime.userHome), since);
  const tree = await treeMembersOf(runtime, await loadTree(runtime), team);
  const byTeamSession = await attributeInTree({ own: team, tree, sessions, titleOf: (path) => transcriptTitleOf(runtime.transcripts, path) });
  const rollups = await foldTeam(runtime.transcripts, { byTeamSession, lead: roster.holderOf('lead'), chunkBytes: CATCH_UP_CHUNK_BYTES });
  const plans = await planDays(runtime.files, { folder: kit.paths.rollup, team, range, rollups });
  const { inserted, unchanged, changed } = outcomeCounts(plans);
  const counts = `${inserted} inserted, ${unchanged} unchanged, ${changed} changed`;
  const days = `${range.from} to ${range.to}`;
  if (apply) {
    const written = await applyPlans(runtime.files, plans, rewrite);
    const kept = rewrite || changed === 0 ? '' : `; ${changed} changed left as they are (add --rewrite to replace them)`;
    runtime.out.stdout(`WROTE ${kit.paths.rollup}, ${days}: ${counts}; ${written.length} written${kept}`);
    await logRollupRun(runtime, kit, now, `WROTE ${days}: ${counts}; ${written.length} written${kept}`);
  } else {
    runtime.out.stdout(`PREVIEW ${kit.paths.rollup}, ${days}: ${counts}; nothing written (add --apply to write)`);
  }
  plans.forEach((plan) => runtime.out.stdout(planLine(plan)));
  return EXIT.ok;
}
