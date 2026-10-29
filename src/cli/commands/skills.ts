import { claudeProjectsDir } from '../../budget/discover.ts';
import { formatUtcDay, MS_PER_DAY, parseUtcDay } from '../../core/time.ts';
import { lintSkills } from '../../skills/lint.ts';
import { renderScorecard, scorecardRows, type DayRange } from '../../skills/scorecard-report.ts';
import { SCAN_MAX_BYTES, scanTranscripts } from '../../skills/scorecard-scan.ts';
import { ScorecardStore } from '../../skills/scorecard-store.ts';
import { signatureOf } from '../../skills/signature.ts';
import { SkillDir } from '../../skills/store.ts';
import { noPositionals, UsageError, type Flags, type ParsedArgs } from '../args.ts';
import { openTeamKit, requireConfig } from '../kit.ts';
import { EXIT, type CliRuntime, type ExitCode } from '../runtime.ts';
import { loadTree, skillOwnersElsewhere } from '../tree.ts';

/** The window's length when `--from` is not given: a week, today included. */
const WINDOW_DAYS = 7;

/**
 * `skills scorecard [--from <day>] [--to <day>] [--baseline-from <day>] [--baseline-to <day>]`: per installed skill,
 * its loads, missed uses (its `Signature:` procedure run with no load) and what a run costs, over UTC days (default
 * the last 7, today included) against a baseline (default as many days just before). Each run reads only what the
 * transcripts gained since the last one, into the team's saved scorecard.
 */
export async function scorecard(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  noPositionals(args);
  const kit = await openTeamKit(runtime);
  const config = requireConfig(kit, runtime, 'read');
  const now = runtime.clock.now();
  const to = dayFlag(args.flags, 'to') ?? formatUtcDay(new Date(now));
  const window = rangeOf(dayFlag(args.flags, 'from') ?? addDays(to, 1 - WINDOW_DAYS), to, 'from');
  const baselineTo = dayFlag(args.flags, 'baseline-to') ?? addDays(window.from, -1);
  const baseline = rangeOf(dayFlag(args.flags, 'baseline-from') ?? addDays(baselineTo, -daysIn(window) + 1), baselineTo, 'baseline-from');
  const skills = await new SkillDir(runtime.files, kit.paths.skills).readAll();
  const signatures = skills.map(signatureOf);
  const result = await scanTranscripts(
    { source: runtime.transcripts, store: new ScorecardStore(runtime.files, kit.paths.skillsScorecard), clock: runtime.clock },
    {
      projectsDir: claudeProjectsDir(runtime.env, runtime.userHome),
      skills: { names: new Set(skills.map((skill) => skill.name)), signatures: signatures.filter((signature) => signature.patterns.length > 0) },
      since: startOf(baseline.from < window.from ? baseline.from : window.from),
      maxBytes: SCAN_MAX_BYTES,
    },
  );
  const lint = lintSkills(skills, new Date(now), config, skillOwnersElsewhere(await loadTree(runtime), kit.paths));
  const rows = scorecardRows({ days: result.state.days, skills, signatures, lint }, window, baseline);
  const footer = { window, baseline, since: result.state.since, files: result.files, bytesRead: result.bytesRead, catchingUp: result.catchingUp };
  for (const line of renderScorecard(rows, footer)) {
    runtime.out.stdout(line);
  }
  return EXIT.ok;
}

function dayFlag(flags: Flags, name: string): string | undefined {
  const text = flags.get(name);
  if (text === undefined) {
    return undefined;
  }
  if (parseUtcDay(text) === undefined) {
    throw new UsageError(`--${name} "${text}" is not a YYYY-MM-DD day`);
  }
  return text.trim();
}

function rangeOf(from: string, to: string, fromFlag: string): DayRange {
  if (from > to) {
    throw new UsageError(`--${fromFlag} ${from} is after the range's last day, ${to}`);
  }
  return { from, to };
}

function startOf(day: string): number {
  return Date.parse(`${day}T00:00:00Z`);
}

function addDays(day: string, days: number): string {
  return formatUtcDay(new Date(startOf(day) + days * MS_PER_DAY));
}

function daysIn(range: DayRange): number {
  return Math.round((startOf(range.to) - startOf(range.from)) / MS_PER_DAY) + 1;
}
