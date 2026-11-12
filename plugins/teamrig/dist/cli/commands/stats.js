import { MeterLog } from "../../budget/calibration.js";
import { limitSpansOf } from "../../budget/extra.js";
import { formatAddress } from "../../core/address.js";
import { AREA_MEASURE_LABELS, AREA_MEASURES, standingOut } from "../../register/area-stats.js";
import { GOAL_STATES } from "../../register/goal-stats.js";
import { registerHealth } from "../../register/stats-health.js";
import { isStatsRange, registerStats, STATS_RANGE_DAYS, STATS_RANGES, WORK_SOURCES, } from "../../register/stats.js";
import { WAIT_KINDS } from "../../register/waits.js";
import { accountWeekOn } from "../account-teams.js";
import { noPositionals, UsageError } from "../args.js";
import { callerOf } from "../inputs.js";
import { sessionIdOf, teamZone } from "../kit.js";
import { rollUp } from "../roll-up.js";
import { EXIT } from "../runtime.js";
import { useLines } from "../stats-use.js";
import { KitTreeGoals } from "../tree-goals.js";
import { ownRegister, warnDamage } from "./register.js";
/** The goal states worth a look, so the `GOALS` line names their goals; the others it only counts. */
const NAMED_GOAL_STATES = ['at risk', 'late'];
/** The most areas the AREAS line names: the rows of the tab's Bottlenecks section. */
const AREAS_SHOWN = 6;
/**
 * `teamrig stats [--tree] [--range 7d|30d|90d|180d|1y|all] [--session <id|name>]` (T1771): the register's numbers over a range
 * of the team's calendar days, as the pane's Stats tab folds them (register/stats.ts): the Health tiles with their
 * levels, then each section's headline and the days the week sat at its usage limit (the `$` mark, from the meter log),
 * for the lead and the meeting agenda's top lines, and last how much of the task work the plan held (cli/stats-use.ts,
 * from the daily rollups). As with `list`, `--session`
 * reads one session's tasks in its team, and with `--tree` names the caller instead, who must be the team's lead: the
 * teams under it are rolled up, so `/teamrig`, which fills in the tab's session, can run both. Read-only: each
 * register's whole history is read, since a range reaches past what a compaction left in the working set.
 */
export async function stats(args, runtime) {
    noPositionals(args);
    const range = rangeOf(args.flags.get('range'));
    const tree = args.switches.has('tree');
    const rolled = tree ? await rollUp(runtime, callerOf(args.flags, runtime.env)) : await ownRegister(runtime);
    const scope = tree || !args.flags.has('session') ? undefined : { team: rolled.own.team, session: sessionIdOf(rolled.own.roster, callerOf(args.flags, runtime.env)) };
    const histories = await historiesOf(runtime, rolled);
    const folded = await foldHistories(runtime, rolled, histories, range, scope);
    const use = await useLines(runtime, { teams: histories, focus: rolled.own.config.focus, days: folded.stats.days.map((day) => day.day), ...(scope === undefined ? {} : { scope }) });
    const name = scope === undefined ? rolled.own.team : formatAddress({ team: scope.team, id: scope.session });
    [...statsLines(folded, name, rolled.teams.map((team) => team.team)), ...use].forEach((line) => runtime.out.stdout(line));
    return EXIT.ok;
}
/**
 * The fold of every register of `rolled` over `range` on its own team's clock, the days at the usage limit read from
 * the meter log, narrowed to one session's tasks when `scope` names one. Read-only, each register's whole history.
 */
export async function foldStats(runtime, rolled, range, scope) {
    return foldHistories(runtime, rolled, await historiesOf(runtime, rolled), range, scope);
}
async function foldHistories(runtime, rolled, histories, range, scope) {
    const teams = histories.map(statsTeamOf);
    const { config } = rolled.own;
    const now = runtime.clock.now();
    const limits = await limitsOf(runtime, rolled.own, now);
    const goals = await goalsOf(runtime, rolled);
    const stats = registerStats({ teams, range, now: new Date(now), zone: teamZone(config, runtime), ownerMarker: config.register.ownerSource, limits, goals, ...(scope === undefined ? {} : { session: scope }) });
    return { stats, health: registerHealth(stats) };
}
/** The goals the rolled teams' tasks can serve: each team's own records and those of the teams above it. */
async function goalsOf(runtime, { teams }) {
    const reads = await Promise.all(teams.map((team) => new KitTreeGoals(runtime, team.paths, team.config).all()));
    return new Map(reads.flatMap((goals) => [...goals]));
}
function rangeOf(value) {
    if (value === undefined) {
        return '7d';
    }
    if (!isStatsRange(value)) {
        throw new UsageError(`--range takes ${STATS_RANGES.slice(0, -1).join(', ')} or ${STATS_RANGES.at(-1)}, not ${value}`);
    }
    return value;
}
/**
 * The stretches the week sat at its usage limit, from the meter log of the account the caller's team is on
 * (`accountWeekOn`); a tree's teams are read against that account too.
 */
async function limitsOf(runtime, own, now) {
    const account = await accountWeekOn(runtime, own.config.budget, own.paths, now);
    return limitSpansOf(await new MeterLog(runtime.files, account.paths.meterLog).read(now));
}
/** Each team's whole history, its damaged lines named once. */
async function historiesOf(runtime, { teams }) {
    const read = [];
    for (const rolled of teams) {
        const history = await rolled.history();
        warnDamage(runtime, history, rolled.paths.events);
        read.push({ rolled, history });
    }
    return read;
}
function statsTeamOf({ rolled, history }) {
    return { team: rolled.team, lead: rolled.config.roles.lead, events: history.read.events };
}
/**
 * The top lines of `stats`, which the meeting agenda opens with too: a header naming the scope, range and tree, the
 * Health tiles, the flow, and the days at the usage limit when the range has any.
 */
export function statsTopLines({ stats, health }, name, teams) {
    const first = stats.days[0]?.day;
    const last = stats.days.at(-1)?.day;
    const span = first === undefined || last === undefined ? '' : `: ${spanStart(first, last)} to ${last.slice(5)}`;
    const tree = teams.length > 1 ? ` (tree: ${teams.join(', ')})` : '';
    return [
        `STATS ${name}, ${rangeText(stats.range)}${span}${tree}`,
        `HEALTH ${healthText(health)}`,
        `FLOW opened ${stats.opened}, closed ${stats.closedTasks} (${stats.droppedTasks} dropped), net ${signed(stats.net)}; last ${stats.recent.days} d net ${signed(stats.recent.net)}`,
        ...limitLines(stats),
    ];
}
/** The lines `stats` prints: its top lines (statsTopLines), then one headline per other section. */
export function statsLines(folded, name, teams) {
    const { stats } = folded;
    const lines = [
        ...statsTopLines(folded, name, teams),
        `NEW WORK ${newWorkText(stats)}`,
        `SPEED lead time ${spreadText(stats.all.leadTime)} (${stats.all.leadTime.count} done); cycle time ${spreadText(stats.all.cycleTime)} (${stats.all.cycleTime.count} started, ${stats.neverStarted} never)`,
        `DELAYS overdue ${stats.all.overdue.count}, p1 ${stats.all.overdue.p1}; done by due ${stats.all.due.onTime} of ${stats.all.due.total}${bandsText(stats.lateDays, 'late')}; due moved ${stats.dueMoved}`,
        `WAITS ${waitsText(stats)}`,
        `BUGS ${stats.bugs.active} active, ${stats.bugs.opened} opened, ${stats.bugs.fixed} fixed`,
        `PEOPLE ${stats.people.length === 0 ? 'none done' : stats.people.map((person) => `${teams.length > 1 ? `${person.team}/` : ''}${person.session} ${person.done}`).join(', ')}`,
        `GOALS ${goalsText(stats.goals)}`,
        `AREAS ${areasText(stats.areas, teams.length > 1)}`,
    ];
    if (teams.length > 1) {
        lines.push(`TEAMS ${stats.teams.map((team) => `${team.team} ${team.active} active, overdue ${team.overdue.count}`).join(' · ')}`);
    }
    for (const split of stats.splits) {
        lines.push(`SPLIT ${split.day.slice(5)} ${split.tasks} task(s) moved ${split.from} -> ${split.to}: the chart of ${split.from} before it lacks them`);
    }
    return lines;
}
/** The days the week sat at its usage limit (the `$` mark), when the range has any. */
function limitLines({ days }) {
    const marked = days.filter((day) => day.atLimit).map((day) => day.day.slice(5));
    return marked.length === 0 ? [] : [`LIMIT $ ${marked.join(', ')}: the week sat at its usage limit, so a quiet day there is no slack`];
}
function rangeText(range) {
    return range === 'all' ? 'all days' : `${STATS_RANGE_DAYS[range]} d`;
}
/** The span's first day, with its year when the span starts in another year than it ends, as a `1y` range always does. */
function spanStart(first, last) {
    return first.slice(0, 4) === last.slice(0, 4) ? first.slice(5) : first;
}
function healthText(health) {
    const { closeOpen, backlog, overdue, ownerDecisions, backlogClears } = health;
    return [
        `close/open ${closeOpen.ratio === null ? 'none opened' : closeOpen.ratio.toFixed(2)} ${levelText(closeOpen.level)}`,
        `backlog ${signed(backlog.net)}, ${backlog.active} active ${levelText(backlog.level)}`,
        `overdue ${overdue.count}, p1 ${overdue.p1} ${levelText(overdue.level)}`,
        `owner decisions ${ownerDecisions.count}${ownerDecisions.oldestDays === null ? '' : `, oldest ${days(ownerDecisions.oldestDays)}`} ${levelText(ownerDecisions.level)}`,
        `backlog clears ${backlogClears.weeks === null ? 'never, at this rate' : `in ${backlogClears.weeks} week(s)`} ${levelText(backlogClears.level)}`,
    ].join(' · ');
}
function levelText(level) {
    return `[${level}]`;
}
/** The whole teams that stand out, then the sessions, held to the rows the tab's section shows. */
function areasText({ teams, sessions }, tree) {
    const areas = [...standingOut(teams), ...standingOut(sessions)];
    if (areas.length === 0) {
        return 'none stand out';
    }
    const named = areas.slice(0, AREAS_SHOWN).map((area) => areaText(area, tree));
    const more = areas.length > AREAS_SHOWN ? [`${areas.length - AREAS_SHOWN} more`] : [];
    return `${areas.length} ${areas.length === 1 ? 'stands' : 'stand'} out: ${[...named, ...more].join('; ')}`;
}
function areaText(area, tree) {
    const cells = AREA_MEASURES.filter((measure) => area.cells[measure].level !== 'good').map((measure) => `${AREA_MEASURE_LABELS[measure]} ${cellValue(measure, area.cells[measure].value)} ${levelText(area.cells[measure].level)}`);
    return `${areaName(area, tree)} ${cells.join(', ')}`;
}
function areaName({ team, session }, tree) {
    if (session === null) {
        return team;
    }
    return tree ? `${team}/${session}` : session;
}
function cellValue(measure, value) {
    return measure === 'low' ? `${value}%` : `${value}`;
}
function newWorkText({ newWork }) {
    const sources = WORK_SOURCES.map((source) => `${source} ${newWork.bySource[source]}`).join(', ');
    const goals = newWork.byGoal.length === 0 ? '' : `; goals ${newWork.byGoal.map((goal) => `${goal.goal} ${goal.count}`).join(', ')}`;
    return `${newWork.total}: ${sources}; ${newWork.bugs} bug(s)${goals}; no goal ${newWork.noGoal}`;
}
function waitsText({ waits }) {
    const kinds = WAIT_KINDS.filter((kind) => waits.byKind[kind] > 0).map((kind) => `${kind} ${waits.byKind[kind]}`);
    const oldest = waits.ownerDecisions.oldestDays === null ? '' : `, oldest ${days(waits.ownerDecisions.oldestDays)}`;
    return `${waits.waiting} waiting${kinds.length === 0 ? '' : ` (${kinds.join(', ')})`}; on the owner ${waits.ownerDecisions.count}${oldest}`;
}
function goalsText(goals) {
    const states = GOAL_STATES.flatMap((state) => {
        const tags = goals.goals.filter((goal) => goal.state === state).map((goal) => goal.tag);
        const named = NAMED_GOAL_STATES.includes(state) ? ` (${tags.join(', ')})` : '';
        return tags.length === 0 ? [] : [`${tags.length} ${state}${named}`];
    });
    return `${states.length === 0 ? 'none' : states.join(', ')}; off goal: ${offGoalText(goals)}`;
}
function offGoalText({ offGoal, doneInRange }) {
    return doneInRange === 0 ? 'no task done' : `${offGoal} of ${doneInRange} done tasks (${Math.round((offGoal / doneInRange) * 100)}%)`;
}
function bandsText(bands, what) {
    const counted = bands.filter((band) => band.count > 0);
    return counted.length === 0 ? '' : `; ${what} ${counted.map((band) => `${band.count} by ${band.label}`).join(', ')}`;
}
function spreadText(spread) {
    return spread.median === null || spread.p85 === null ? 'none' : `median ${days(spread.median)}, p85 ${days(spread.p85)}`;
}
function days(value) {
    return `${value.toFixed(1)} d`;
}
function signed(value) {
    return value > 0 ? `+${value}` : `${value}`;
}
