import { KIT_NAME } from "../../core/home.js";
import { addUtcDays, parseDayStart } from "../../core/time.js";
import { doneGroups, doneGroupTitle } from "../../register/done-groups.js";
import { formatShortTask } from "../../register/views.js";
import { noPositionals, UsageError } from "../args.js";
import { callerOf } from "../inputs.js";
import { sessionIdOf, teamZone } from "../kit.js";
import { SHORT_TITLE_CHARS } from "../reports.js";
import { EXIT } from "../runtime.js";
import { ownRegister, taskTreeOf, warnDamage } from "./register.js";
/** How `report done` reads a day it is given. */
const DAY_TEXT = /^\d{4}-\d{2}-\d{2}$/;
/**
 * `teamrig report done [--day <YYYY-MM-DD>] [--session <id|name>] [--all]` (T1729): one day of the team's done work,
 * yesterday by default, as the done groups sort it (register/done-groups.ts): Owner asked, one group per goal, Urgent
 * p1 and This week's plan, each with every row; Other work and the dropped tasks are one line with the command that
 * lists them, or their rows with `--all`. The day is the team's calendar day; `--session` reads one owner's tasks.
 * Read-only: the whole history is read, since a compaction may have moved a day's done tasks to the archive.
 */
export async function reportDone(args, runtime) {
    noPositionals(args);
    const { own } = await ownRegister(runtime);
    const zone = teamZone(own.config, runtime);
    const day = dayOf(args.flags.get('day'), zone.day(new Date(runtime.clock.now())));
    const from = parseDayStart(day, zone);
    const next = addUtcDays(day, 1);
    const to = next === undefined ? undefined : parseDayStart(next, zone);
    if (from === undefined || to === undefined) {
        throw new UsageError(`--day "${day}" is not a YYYY-MM-DD date`);
    }
    const session = args.flags.has('session') ? sessionIdOf(own.roster, callerOf(args.flags, runtime.env)) : undefined;
    const history = await own.history();
    warnDamage(runtime, history, own.paths.events);
    const tasks = [...history.state.tasks.values()].filter((task) => session === undefined || task.owner === session);
    const sorted = doneGroups({ tasks, ownerMarker: own.config.register.ownerSource, zone, from: from.getTime(), to: to.getTime() });
    const tree = taskTreeOf({ snapshot: history, config: own.config, elsewhere: own.elsewhere }, runtime);
    const view = { day, weekday: zone.weekday(from), session, all: args.switches.has('all'), tree };
    reportDoneLines(sorted, view).forEach((line) => runtime.out.stdout(line));
    return EXIT.ok;
}
/** The day `--day` names, checked as a `YYYY-MM-DD` date; without it, the day before `today`. */
function dayOf(value, today) {
    if (value === undefined) {
        return addUtcDays(today, -1) ?? today;
    }
    if (!DAY_TEXT.test(value) || addUtcDays(value, 0) === undefined) {
        throw new UsageError(`--day "${value}" is not a YYYY-MM-DD date`);
    }
    return value;
}
/**
 * The report's lines: `DONE Mon 01-07[ · alpha] · 3 done · 1 dropped`, each group but Other work as its heading with
 * every row, then Other work and Dropped: with `all` as headings with their rows (only those holding a task), else one
 * line counting those holding a task and naming the command that prints them.
 */
export function reportDoneLines({ groups, done, dropped }, view) {
    const who = view.session === undefined ? '' : ` · ${view.session}`;
    const lines = [`DONE ${view.weekday} ${view.day.slice(5)}${who} · ${done} done · ${dropped.length} dropped`];
    const other = groups.find((group) => group.kind === 'other')?.tasks ?? [];
    for (const group of groups) {
        if (group.kind !== 'other') {
            lines.push(...groupLines(doneGroupTitle(group), group.tasks, view.tree));
        }
    }
    if (view.all) {
        lines.push(...groupLines('Other work', other, view.tree), ...groupLines('Dropped', dropped, view.tree));
    }
    else if (other.length > 0 || dropped.length > 0) {
        const scope = view.session === undefined ? '' : ` --session ${view.session}`;
        lines.push(`  ${restTitle(other.length, dropped.length)}: ${KIT_NAME} report done --day ${view.day}${scope} --all`);
    }
    return lines;
}
/** The one line's heading for what only `--all` lists: `Other work (2) and dropped (1)`, leaving out an empty side. */
function restTitle(other, dropped) {
    if (dropped === 0) {
        return `Other work (${other})`;
    }
    return other === 0 ? `Dropped (${dropped})` : `Other work (${other}) and dropped (${dropped})`;
}
/** A heading with its task count and one row per task; nothing for no task. */
function groupLines(title, tasks, tree) {
    return tasks.length === 0 ? [] : [`  ${title} (${tasks.length})`, ...tasks.map((task) => `    ${formatShortTask(task, SHORT_TITLE_CHARS, undefined, tree)}`)];
}
