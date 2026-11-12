import { median } from "../core/quantile.js";
import { MS_PER_DAY } from "../core/time.js";
import { RegisterFold } from "./fold.js";
import { ACTIVE_STATUSES, isTopPriority } from "./model.js";
import { dueTime } from "./views.js";
/**
 * Where the trouble sits (T1866, the core half of the pane's Bottlenecks section): each team and session on five
 * measures, each cell held against the other areas and against the area's own usual. Raw counts follow size, so the
 * lead would top every column on the first test alone: red needs both tests, amber one. The tab and `teamrig stats`
 * read this one fold, so they never disagree. Pure, with no node: import, so the pane vendors it (src/read/index.ts).
 */
export const AREA_MEASURES = ['bugs', 'p1', 'p1Late', 'low', 'waits'];
export const AREA_MEASURE_LABELS = { bugs: 'bugs', p1: 'p1', p1Late: 'p1 late', low: 'low', waits: 'waits' };
/** The defaults the owner can change (T1866 design, section 5). */
export const AREA_THRESHOLDS = {
    /** High against the others means in this top share of the areas, rounded up, ties with the last one included... */
    topShare: 0.25,
    /** ...and at least this many times their median... */
    overMedian: 2,
    /** ...or, for the low share, at least this many points over theirs: a share has no useful multiple. */
    lowPoints: 15,
    /** High against its own usual means at least this many times it. */
    overUsual: 1.5,
    /** The day-ends the usual is the median of. */
    usualDays: 30,
    /** A task waiting longer than this many days is a long wait. */
    waitDays: 3,
    /** The priority number from which a task is low priority: p3 and below. */
    lowPriority: 3,
};
/** What each measure counts, read for the tasks now and at each past day-end, so the two cannot differ. */
const COUNTED = {
    bugs: (task) => task.type === 'bug',
    p1: (task) => isTopPriority(task.priority),
    p1Late: (task, at, zone) => isTopPriority(task.priority) && (dueTime(task, zone) ?? at) < at,
    low: (task) => task.priority >= AREA_THRESHOLDS.lowPriority,
    waits: (task, at) => task.status === 'waiting' && at - Date.parse(task.statusAt) > AREA_THRESHOLDS.waitDays * MS_PER_DAY,
};
export function areaStats({ teams, now, zone, dayEnds }) {
    const replayed = teams.map((team) => ({ team, days: dayEndCounts(team.kept, dayEnds, zone) }));
    const wholeTeams = teams.length > 1 ? replayed.filter(({ team }) => team.active.length > 0).map(wholeTeam) : [];
    return { teams: groupOf(wholeTeams, now, zone), sessions: groupOf(replayed.flatMap(teamSessions), now, zone) };
}
/**
 * The areas that stand out: those with a red cell. Red needs peers, so a lone area stands out by an amber one, else a
 * session's own numbers could never show it above its usual.
 */
export function standingOut({ areas }) {
    const mark = areas.length > 1 ? 'bad' : 'warn';
    return areas.filter((area) => cellsAt(area, mark) > 0);
}
/**
 * The log replayed once, stopping at each day-end in turn: a task counts for whoever owned it at that moment, so
 * today's owner does not inherit a usual it never had. An event written just out of time order lands at the next stop.
 */
function dayEndCounts(events, dayEnds, zone) {
    const fold = new RegisterFold();
    let next = 0;
    return dayEnds.map((end) => {
        for (let event = events[next]; event !== undefined && Date.parse(event.at) < end; event = events[next]) {
            fold.apply(event);
            next += 1;
        }
        return countsByOwner(fold.state().tasks.values(), end, zone);
    });
}
function countsByOwner(tasks, at, zone) {
    const byOwner = new Map();
    for (const task of tasks) {
        if (ACTIVE_STATUSES.includes(task.status)) {
            const counts = byOwner.get(task.owner) ?? noCounts();
            byOwner.set(task.owner, counts);
            counts.active += 1;
            AREA_MEASURES.filter((measure) => COUNTED[measure](task, at, zone)).forEach((measure) => (counts[measure] += 1));
        }
    }
    return byOwner;
}
function wholeTeam({ team, days }) {
    return { team: team.team, session: null, tasks: team.active, days: sinceFirstTask(days.map((day) => summed([...day.values()]))) };
}
function teamSessions({ team, days }) {
    return [...new Set(team.active.map((each) => each.task.owner))].map((owner) => ({
        team: team.team,
        session: owner,
        tasks: team.active.filter((each) => each.task.owner === owner),
        days: sinceFirstTask(days.map((day) => day.get(owner) ?? noCounts())),
    }));
}
/**
 * The day-ends from the area's first active task on. Before it the area was not there, a register younger than the
 * usual's days or a session hired since, and zeros from then would sink its usual until every count read as a spike.
 */
function sinceFirstTask(days) {
    const first = days.findIndex((day) => day.active > 0);
    return first === -1 ? [] : days.slice(first);
}
function groupOf(placed, now, zone) {
    const measured = placed.map((area) => ({ area, cells: perMeasure((measure) => measuredCell(area, measure, now, zone)) }));
    const peers = perMeasure((measure) => measured.map(({ cells }) => cells[measure].value));
    const areas = measured.map(({ area, cells }) => ({
        team: area.team,
        session: area.session,
        active: area.tasks.length,
        cells: perMeasure((measure) => levelled(cells[measure], measure, peers[measure])),
    }));
    return {
        areas: areas.sort(worstFirst),
        median: { active: median(placed.map((area) => area.tasks.length)) ?? 0, ...perMeasure((measure) => median(peers[measure]) ?? 0) },
    };
}
function measuredCell(area, measure, now, zone) {
    const tasks = area.tasks.filter((each) => COUNTED[measure](each.task, now, zone));
    return {
        value: valueOf(measure, tasks.length, area.tasks.length),
        usual: median(area.days.map((day) => valueOf(measure, day[measure], day.active))) ?? 0,
        tasks,
    };
}
function valueOf(measure, count, active) {
    if (measure !== 'low') {
        return count;
    }
    return active === 0 ? 0 : Math.round((100 * count) / active);
}
function levelled(cell, measure, peers) {
    const others = highAmongPeers(cell.value, measure, peers);
    const usual = cell.value > 0 && cell.value >= AREA_THRESHOLDS.overUsual * cell.usual;
    return { ...cell, level: others && usual ? 'bad' : others || usual ? 'warn' : 'good' };
}
/** An area alone fails this by itself: its value is its peers' median, so red needs at least one other area. */
function highAmongPeers(value, measure, peers) {
    const top = [...peers].sort((a, b) => b - a)[Math.ceil(peers.length * AREA_THRESHOLDS.topShare) - 1] ?? value;
    const middle = median(peers) ?? 0;
    const bar = measure === 'low' ? middle + AREA_THRESHOLDS.lowPoints : AREA_THRESHOLDS.overMedian * middle;
    return value > 0 && value >= top && value >= bar;
}
function worstFirst(a, b) {
    return cellsAt(b, 'bad') - cellsAt(a, 'bad') || cellsAt(b, 'warn') - cellsAt(a, 'warn') || b.active - a.active || byName(a, b);
}
function cellsAt(area, level) {
    return AREA_MEASURES.filter((measure) => area.cells[measure].level === level).length;
}
function byName(a, b) {
    const left = nameOf(a);
    const right = nameOf(b);
    return left < right ? -1 : left > right ? 1 : 0;
}
function nameOf({ team, session }) {
    return `${team}/${session ?? ''}`;
}
function perMeasure(make) {
    return { bugs: make('bugs'), p1: make('p1'), p1Late: make('p1Late'), low: make('low'), waits: make('waits') };
}
function noCounts() {
    return { active: 0, ...perMeasure(() => 0) };
}
function summed(counts) {
    const total = (key) => counts.reduce((sum, each) => sum + each[key], 0);
    return { active: total('active'), ...perMeasure(total) };
}
