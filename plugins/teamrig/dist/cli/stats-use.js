import { join } from 'node:path';
import { formatW } from "../budget/format.js";
import { parseRollup, rollupDayOf } from "../budget/rollup-file.js";
import { planUse } from "../budget/rollup-use.js";
import { MS_PER_DAY } from "../core/time.js";
import { inWeek } from "../register/done-groups.js";
import { classOf } from "../register/focus.js";
import { weekTagAt, weekTagsOf } from "../register/week-tags.js";
import { teamZone } from "./kit.js";
const SECONDS_PER_MINUTE = 60;
/**
 * Where a team's work on a task counts on a UTC day. A task is planned that day when the tag in force at the day's end
 * names a week holding the day's noon: a tag set mid-week reads planned from that day on, and a later retag leaves the
 * days before it as they were. A task the team's events never name was another register's, read by its tag of today.
 */
function placerOf({ rolled, history }, runtime) {
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
async function rolledDays(runtime, { paths }, days) {
    const read = [];
    for (const name of (await runtime.files.list(paths.rollup)).sort()) {
        const day = rollupDayOf(name);
        if (day === undefined || !days.has(day)) {
            continue;
        }
        const path = join(paths.rollup, name);
        const parsed = parseRollup((await runtime.files.read(path)) ?? '');
        if (parsed === undefined) {
            runtime.out.stderr(`WARN ${path}: damaged or from a newer teamrig, left out of the USE lines`);
        }
        else {
            read.push(parsed);
        }
    }
    return read;
}
function totalText({ w, seconds }) {
    return `${formatW(w)} W, ${Math.round(seconds / SECONDS_PER_MINUTE)} min`;
}
function sumOf(a, b) {
    return { w: a.w + b.w, seconds: a.seconds + b.seconds };
}
/** A share against its target, its gap in whole points so the line's numbers add up as printed. */
function shareText(pct, targetPct) {
    const share = pct === null ? null : Math.round(pct);
    const target = targetPct === null ? '' : `, target ${targetPct}%`;
    const gap = share === null || targetPct === null ? '' : `, gap ${share >= targetPct ? '+' : ''}${share - targetPct}`;
    return `${share === null ? 'none' : `${share}%`} of task W${target}${gap}`;
}
function splitText({ planned, unplanned }) {
    return `planned ${totalText(planned)}; unplanned ${totalText(unplanned)}`;
}
function classLine(use) {
    return `USE ${use.workClass} ${shareText(use.sharePct, use.targetPct)}: ${splitText(use)}`;
}
/**
 * The lines of T2076's 3A: how much of the range's task W the plan held, and each class against `focus.allocation`,
 * from the daily rollups, so only closed UTC days count: today has no file yet. W is raw, as the rollup holds it.
 */
export async function useLines(runtime, { teams, focus, days, scope }) {
    const inRange = new Set(days);
    const rolled = [];
    const placers = new Map();
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
