import { claudeProjectsDir } from "../../budget/discover.js";
import { formatUtcDay, MS_PER_DAY, parseUtcDay } from "../../core/time.js";
import { lintSkills } from "../../skills/lint.js";
import { renderScorecard, scorecardRows } from "../../skills/scorecard-report.js";
import { SCAN_MAX_BYTES, scanTranscripts } from "../../skills/scorecard-scan.js";
import { ScorecardStore } from "../../skills/scorecard-store.js";
import { signatureOf } from "../../skills/signature.js";
import { SkillDir } from "../../skills/store.js";
import { noPositionals, UsageError } from "../args.js";
import { openTeamKit, requireConfig } from "../kit.js";
import { EXIT } from "../runtime.js";
/** The window's length when `--from` is not given: a week, today included. */
const WINDOW_DAYS = 7;
/**
 * `skills scorecard [--from <day>] [--to <day>] [--baseline-from <day>] [--baseline-to <day>]`: per installed skill,
 * its loads, missed uses (its `Signature:` procedure run with no load) and what a run costs, over UTC days (default
 * the last 7, today included) against a baseline (default as many days just before). Each run reads only what the
 * transcripts gained since the last one, into the team's saved scorecard.
 */
export async function scorecard(args, runtime) {
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
    const result = await scanTranscripts({ source: runtime.transcripts, store: new ScorecardStore(runtime.files, kit.paths.skillsScorecard), clock: runtime.clock }, {
        projectsDir: claudeProjectsDir(runtime.env, runtime.userHome),
        skills: { names: new Set(skills.map((skill) => skill.name)), signatures: signatures.filter((signature) => signature.patterns.length > 0) },
        since: startOf(baseline.from < window.from ? baseline.from : window.from),
        maxBytes: SCAN_MAX_BYTES,
    });
    const rows = scorecardRows({ days: result.state.days, skills, signatures, lint: lintSkills(skills, new Date(now), config) }, window, baseline);
    const footer = { window, baseline, since: result.state.since, files: result.files, bytesRead: result.bytesRead, catchingUp: result.catchingUp };
    for (const line of renderScorecard(rows, footer)) {
        runtime.out.stdout(line);
    }
    return EXIT.ok;
}
function dayFlag(flags, name) {
    const text = flags.get(name);
    if (text === undefined) {
        return undefined;
    }
    if (parseUtcDay(text) === undefined) {
        throw new UsageError(`--${name} "${text}" is not a YYYY-MM-DD day`);
    }
    return text.trim();
}
function rangeOf(from, to, fromFlag) {
    if (from > to) {
        throw new UsageError(`--${fromFlag} ${from} is after the range's last day, ${to}`);
    }
    return { from, to };
}
function startOf(day) {
    return Date.parse(`${day}T00:00:00Z`);
}
function addDays(day, days) {
    return formatUtcDay(new Date(startOf(day) + days * MS_PER_DAY));
}
function daysIn(range) {
    return Math.round((startOf(range.to) - startOf(range.from)) / MS_PER_DAY) + 1;
}
