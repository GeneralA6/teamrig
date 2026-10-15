import { FLAG_KINDS, formatFlag } from "../register/check.js";
import { byPlanOrder, formatShortTask, formatTask } from "../register/views.js";
import { formatSkillFlag } from "../skills/lint.js";
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
const SUMMARY_STATUSES = ['in-progress', 'verifying', 'blocked', 'open', 'done', 'dropped'];
/** The characters `lines` print, each with its newline. */
export function printedChars(lines) {
    return lines.reduce((sum, line) => sum + line.length + 1, 0);
}
/** The first lines that fit in `budget` printed characters, then `more(n)` for the n left out; all of them when they fit. */
export function fitBudget(lines, budget, more) {
    if (printedChars(lines) <= budget) {
        return [...lines];
    }
    const kept = [];
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
function firstOf(lines, shown) {
    return lines.length <= shown ? [...lines] : [...lines.slice(0, shown), `  +${lines.length - shown} more`];
}
/** `list`: every field of every row with `all`, else the short form. */
export function listLines(rows, all) {
    return all ? rows.map(({ task, team }) => formatTask(task, team)) : shortList(rows);
}
function ownerOf({ task, team }) {
    return team === undefined ? task.owner : `${team}/${task.owner}`;
}
/** `  alpha 7: 2 in-progress, 1 blocked, 4 open`. */
function ownerLine(owner, rows) {
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
function shortList(rows) {
    const owners = new Map();
    for (const row of rows) {
        owners.set(ownerOf(row), [...(owners.get(ownerOf(row)) ?? []), row]);
    }
    const ownerCount = owners.size > 1 ? ` of ${owners.size} owners` : '';
    const hint = rows.length > 0 ? ' (short rows; --all for every field)' : '';
    const summary = owners.size > 1
        ? [...owners].sort(([a, x], [b, y]) => y.length - x.length || a.localeCompare(b)).map(([owner, owned]) => ownerLine(owner, owned))
        : [];
    const sorted = [...rows].sort((a, b) => byPlanOrder(a.task, b.task));
    return fitBudget([`LIST ${rows.length} task(s)${ownerCount}${hint}`, ...summary, ...sorted.map(({ task, team }) => formatShortTask(task, SHORT_TITLE_CHARS, team))], SHORT_FORM_CHARS, (left) => `+${left} more (--all lists every task in full)`);
}
/** `check`: every flag in full with `all`, else the short form. */
export function checkLines(report, all) {
    return all ? longCheck(report) : shortCheck(report);
}
function skillsLine({ skills, skillsDir }) {
    return `SKILLS ${skills.length} flag(s) in ${skillsDir}`;
}
/** Each register's `CHECK` line and flags, then the skill flags: every flag, every field. */
function longCheck(report) {
    return [
        ...report.sections.flatMap(({ team, flags }) => [
            `CHECK${team === undefined ? '' : ` ${team}:`} ${flags.length} flag(s), ${report.scope}`,
            ...flags.map((flag) => formatFlag(flag, team)),
        ]),
        skillsLine(report),
        ...report.skills.map(formatSkillFlag),
    ];
}
/** A kind's heading and its first `shown` flags; a detail every flag of the kind shares moves to the heading. */
function kindLines(kind, rows, shown) {
    const details = new Set(rows.map(({ flag }) => flag.detail));
    const [shared] = details.size === 1 ? [...details] : [];
    const lines = rows.map(({ flag, team }) => {
        const detail = shared === undefined ? `(${flag.detail}) ` : '';
        return `  ${detail}${formatShortTask(flag.task, SHORT_TITLE_CHARS, team)}`;
    });
    return [`${kind} ${rows.length}${shared === undefined ? '' : ` (${shared})`}`, ...firstOf(lines, shown)];
}
/**
 * The short `check`: one `CHECK` line over every register, then each kind with its count and its first flags in plan
 * order, then the skill flags the same way. Each kind shows MAX_FLAGS_PER_KIND flags, or fewer, the same number for
 * every kind, so the whole fits in SHORT_FORM_CHARS; at one each, lines past the budget give way to a `+N more` line.
 */
function shortCheck(report) {
    const flags = report.sections.flatMap(({ team, flags: own }) => own.map((flag) => ({ flag, team })));
    const kinds = FLAG_KINDS.map((kind) => ({
        kind,
        rows: flags.filter(({ flag }) => flag.kind === kind).sort((a, b) => byPlanOrder(a.flag.task, b.flag.task)),
    })).filter(({ rows }) => rows.length > 0);
    const teams = report.sections.length > 1 ? ` in ${report.sections.length} team(s)` : '';
    const hint = flags.length + report.skills.length > 0 ? ' (short form; --all for every flag in full)' : '';
    const head = `CHECK ${flags.length} flag(s)${teams}, ${report.scope}${hint}`;
    const linesShowing = (shown) => [
        head,
        ...kinds.flatMap(({ kind, rows }) => kindLines(kind, rows, shown)),
        skillsLine(report),
        ...firstOf(report.skills.map((flag) => `  ${formatSkillFlag(flag)}`), shown),
    ];
    for (let shown = MAX_FLAGS_PER_KIND; shown > 1; shown -= 1) {
        const lines = linesShowing(shown);
        if (printedChars(lines) <= SHORT_FORM_CHARS) {
            return lines;
        }
    }
    return fitBudget(linesShowing(1), SHORT_FORM_CHARS, (left) => `+${left} more line(s) (--all for every flag in full)`);
}
