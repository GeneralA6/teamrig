import { MS_PER_DAY } from "../core/time.js";
import { foldEvents } from "./fold.js";
import { GITHUB_SOURCE } from "./model.js";
import { waitsOnOwner } from "./owner-waits.js";
import { dueTime } from "./views.js";
/**
 * The register's numbers over time (T1771, the core half of the pane's Stats tab, T1419): each day's flow, where new
 * work comes from, lead and cycle times, due-date hits, waits, bugs and done per session, for the teams handed in (a
 * tree rolled up) over a range of the team's calendar days. The tab and `teamrig stats` read this one fold, so they
 * never disagree. Pure, with no node: import, so the pane vendors it (src/read/index.ts).
 *
 * A task that moved to another team (T1144) counts in the team that holds it now: the team it left drops every event
 * of it, and the split shows as a {@link Split}. Times are in days, fractional; a day is a calendar day of the zone.
 */
/**
 * The ranges (T1865, the owner's list): the last 7, 30, 90, 180 or 365 calendar days, today included, or every day
 * since the first task was created. A long range reads the archived history, since the fold takes each team's whole log.
 */
export const STATS_RANGES = ['7d', '30d', '90d', '180d', '1y', 'all'];
export function isStatsRange(value) {
    return STATS_RANGES.some((range) => range === value);
}
/** The calendar days each range but `all` counts, today included: `1y` is 365 of them. */
export const STATS_RANGE_DAYS = { '7d': 7, '30d': 30, '90d': 90, '180d': 180, '1y': 365 };
/** The days the recent net covers whatever the range: 4 weeks, so one quiet week does not swing the backlog's trend. */
export const RECENT_DAYS = 28;
/** The active statuses as a tuple, each with its own count; a spec holds them equal to model.ts's ACTIVE_STATUSES. */
export const STATS_ACTIVE_STATUSES = ['open', 'in-progress', 'verifying', 'waiting'];
export function isActive(status) {
    return STATS_ACTIVE_STATUSES.some((active) => active === status);
}
/**
 * Who asked for new work: its owner (self-made), the human owner, the team's lead, a GitHub issue, or another
 * session; checked in that order.
 */
export const WORK_SOURCES = ['self', 'owner', 'lead', 'github', 'session'];
const TOP_PRIORITY = 1;
const AGE_BANDS = [
    { label: '<2 d', below: 2 },
    { label: '2-7 d', below: 7 },
    { label: '7-14 d', below: 14 },
    { label: '14+ d', below: Number.POSITIVE_INFINITY },
];
const LATE_BANDS = [
    { label: '1 d', below: 2 },
    { label: '2-3 d', below: 4 },
    { label: '4+ d', below: Number.POSITIVE_INFINITY },
];
export function registerStats(input) {
    const { zone, ownerMarker, session } = input;
    const now = input.now.getTime();
    const teams = input.teams.map((team) => foldTeam(team, session));
    const held = teams.flatMap((team) => team.held);
    const today = calendarDay(input.now, zone);
    const first = Math.min(today, input.range === 'all' ? (firstCreatedDay(held, zone) ?? today) : today - (STATS_RANGE_DAYS[input.range] - 1) * MS_PER_DAY);
    const clock = { now, zone, window: dayWindow(first, today, zone) };
    const series = new DaySeries(daySpans(first, today, zone), clock.window.end);
    const dueMoved = teams.reduce((count, team) => count + sweep(team, series, clock.window), 0);
    const days = series.days(input.limits ?? []);
    const tasks = held.map((each) => each.task);
    const activeHeld = held.filter((each) => isActive(each.task.status));
    const active = activeHeld.map((each) => each.task);
    const created = held.filter((each) => within(clock.window, each.task.createdAt));
    const closedHeld = held.filter((each) => closedIn(each.task, clock.window));
    const done = held.filter((each) => doneIn(each.task, clock.window));
    const overdue = overdueOf(held, clock);
    const onOwner = ownerWaitsOf(activeHeld, ownerMarker);
    const recent = dayWindow(today - (RECENT_DAYS - 1) * MS_PER_DAY, today, zone);
    return {
        range: input.range,
        days,
        opened: created.length,
        closedTasks: closedHeld.length,
        droppedTasks: closedHeld.filter((each) => each.task.status === 'dropped').length,
        net: created.length - closedHeld.length,
        closes: days.reduce((sum, day) => sum + day.done + day.dropped, 0),
        recent: { days: RECENT_DAYS, net: tasks.filter((task) => within(recent, task.createdAt)).length - tasks.filter((task) => closedIn(task, recent)).length },
        active: activeRecord((status) => active.filter((task) => task.status === status).length),
        all: teamPart(held, clock, overdue),
        teams: teams.filter((team) => session === undefined || team.team === session.team).map((team) => ({ team: team.team, ...teamPart(team.held, clock) })),
        newWork: newWork(created, ownerMarker),
        activeByAge: banded(active.map((task) => (now - Date.parse(task.createdAt)) / MS_PER_DAY), AGE_BANDS),
        neverStarted: done.filter((each) => each.task.startedAt === null).length,
        lateDays: banded(dated(done.map((each) => each.task), zone).flatMap(({ closedAt, due }) => (closedAt > due ? [Math.ceil((closedAt - due) / MS_PER_DAY)] : [])), LATE_BANDS),
        dueMoved,
        waits: waitStats(active, onOwner, now),
        bugs: {
            active: active.filter((task) => task.type === 'bug').length,
            opened: created.filter((each) => each.task.type === 'bug').length,
            fixed: done.filter((each) => each.task.type === 'bug').length,
        },
        people: people(done),
        splits: splitsOf(teams, zone),
        tasks: {
            active: activeHeld,
            opened: created,
            closed: closedHeld,
            overdue,
            overdueP1: overdue.filter((each) => each.task.priority === TOP_PRIORITY),
            ownerDecisions: onOwner,
        },
    };
}
/** A team's tasks in scope, from its events without those of the tasks that moved away. */
function foldTeam(team, scope) {
    const moves = team.events.filter((event) => event.type === 'moved');
    const movedIds = new Set(moves.map((event) => event.id));
    const kept = team.events.filter((event) => !movedIds.has(event.id));
    const tasks = [...foldEvents(kept).tasks.values()].filter((task) => scope === undefined || (scope.team === team.team && task.owner === scope.session));
    return { team: team.team, kept, ids: new Set(tasks.map((task) => task.id)), held: tasks.map((task) => ({ team: team.team, lead: team.lead, task })), moves };
}
/**
 * Replays a team's kept events of the tasks in scope into the day series, as the fold reads them (a second create
 * is ignored, a status the task already has is no move), and returns how many of them moved their due date in the
 * window.
 */
function sweep(team, series, window) {
    const statuses = new Map();
    const dues = new Map();
    const dueMoved = new Set();
    for (const event of team.kept) {
        if (!team.ids.has(event.id)) {
            continue;
        }
        const at = Date.parse(event.at);
        const status = statuses.get(event.id);
        if (event.type === 'create') {
            if (status === undefined) {
                statuses.set(event.id, 'open');
                dues.set(event.id, event.task.due);
                series.created(at);
            }
        }
        else if (status !== undefined && event.type === 'status' && event.status !== status) {
            series.moved(at, status, event.status);
            statuses.set(event.id, event.status);
        }
        else if (status !== undefined && event.type === 'update' && event.changes.due !== undefined) {
            const before = dues.get(event.id) ?? null;
            if (before !== null && event.changes.due !== before && at >= window.start && at < window.end) {
                dueMoved.add(event.id);
            }
            dues.set(event.id, event.changes.due);
        }
    }
    return dueMoved.size;
}
/** Each day's creations, closes and moves between statuses; what happened before the first day is its base. */
class DaySeries {
    spans;
    end;
    counts;
    base = activeRecord(() => 0);
    constructor(spans, end) {
        this.spans = spans;
        this.end = end;
        this.counts = spans.map(() => ({ opened: 0, done: 0, dropped: 0, moves: activeRecord(() => 0) }));
    }
    created(at) {
        const index = this.dayIndex(at);
        const moves = this.movesAt(index);
        if (moves !== undefined) {
            moves.open += 1;
        }
        const day = this.counts[index];
        if (day !== undefined) {
            day.opened += 1;
        }
    }
    moved(at, from, to) {
        const index = this.dayIndex(at);
        const moves = this.movesAt(index);
        if (moves === undefined) {
            return;
        }
        if (isActive(from)) {
            moves[from] -= 1;
        }
        if (isActive(to)) {
            moves[to] += 1;
        }
        const day = this.counts[index];
        if (day !== undefined && isActive(from)) {
            day.done += to === 'done' ? 1 : 0;
            day.dropped += to === 'dropped' ? 1 : 0;
        }
    }
    /** The days in order, each marked when one of `limits` overlaps it. */
    days(limits) {
        const running = { ...this.base };
        return this.spans.map((span, index) => {
            const day = this.counts[index];
            for (const status of STATS_ACTIVE_STATUSES) {
                running[status] += day?.moves[status] ?? 0;
            }
            const atLimit = limits.some((limit) => limit.start < span.end && limit.end > span.start);
            return { day: span.day, opened: day?.opened ?? 0, done: day?.done ?? 0, dropped: day?.dropped ?? 0, active: { ...running }, atLimit };
        });
    }
    /** The base before the first day; none from the last day's end on. */
    movesAt(index) {
        return index < 0 ? this.base : this.counts[index]?.moves;
    }
    /** The day an instant falls on: -1 before the first, the day count from the last one's end on. */
    dayIndex(at) {
        if (at >= this.end) {
            return this.spans.length;
        }
        let low = -1;
        let high = this.spans.length - 1;
        while (low < high) {
            const middle = Math.floor((low + high + 1) / 2);
            const start = this.spans[middle]?.start;
            if (start !== undefined && start <= at) {
                low = middle;
            }
            else {
                high = middle - 1;
            }
        }
        return low;
    }
}
/** A team's (or the whole set's) part; `overdue` is {@link overdueOf} the same tasks, handed in when already listed. */
function teamPart(held, clock, overdue = overdueOf(held, clock)) {
    const tasks = held.map((each) => each.task);
    const done = tasks.filter((task) => doneIn(task, clock.window));
    const withDue = dated(done, clock.zone);
    return {
        active: tasks.filter((task) => isActive(task.status)).length,
        leadTime: spread(done.map((task) => daysBetween(task.createdAt, task.statusAt))),
        cycleTime: spread(done.flatMap((task) => (task.startedAt === null ? [] : [daysBetween(task.startedAt, task.statusAt)]))),
        overdue: { count: overdue.length, p1: overdue.filter((each) => each.task.priority === TOP_PRIORITY).length },
        due: { total: withDue.length, onTime: withDue.filter(({ closedAt, due }) => closedAt <= due).length },
    };
}
/** The active tasks past their due date now, the longest past first; a tie keeps the fold's order. */
function overdueOf(held, clock) {
    return held
        .flatMap((each) => {
        const due = dueTime(each.task, clock.zone);
        return isActive(each.task.status) && due !== undefined && due < clock.now ? [{ each, due }] : [];
    })
        .sort((a, b) => a.due - b.due)
        .map(({ each }) => each);
}
/** The active tasks waiting, or whose proof waits, on the owner, the oldest wait first; a tie keeps the fold's order. */
function ownerWaitsOf(active, ownerMarker) {
    return active.filter((each) => waitsOnOwner(each.task, ownerMarker)).sort((a, b) => Date.parse(a.task.statusAt) - Date.parse(b.task.statusAt));
}
function newWork(created, ownerMarker) {
    const bySource = { self: 0, owner: 0, lead: 0, github: 0, session: 0 };
    created.forEach((each) => {
        bySource[sourceOf(each, ownerMarker)] += 1;
    });
    const tasks = created.map((each) => each.task);
    return {
        total: created.length,
        bySource,
        bugs: tasks.filter((task) => task.type === 'bug').length,
        byPriority: [...tally(tasks.map((task) => task.priority))].map(([priority, count]) => ({ priority, count })).sort((a, b) => a.priority - b.priority),
        byGoal: [...tally(tasks.flatMap((task) => [...new Set(task.goals)]))].map(([goal, count]) => ({ goal, count })).sort((a, b) => b.count - a.count || byText(a.goal, b.goal)),
        noGoal: tasks.filter((task) => task.goals.length === 0).length,
    };
}
function sourceOf({ task, lead }, ownerMarker) {
    if (task.source === task.owner) {
        return 'self';
    }
    if (task.source === ownerMarker) {
        return 'owner';
    }
    if (task.source === lead) {
        return 'lead';
    }
    return task.source === GITHUB_SOURCE ? 'github' : 'session';
}
/** The waits of the active tasks; `onOwner` is {@link ownerWaitsOf} them, the oldest first. */
function waitStats(active, onOwner, now) {
    const waiting = active.filter((task) => task.status === 'waiting');
    const byKind = { decision: 0, approval: 0, task: 0, time: 0 };
    for (const task of waiting) {
        for (const kind of new Set(task.waits.map((reason) => reason.kind))) {
            byKind[kind] += 1;
        }
    }
    const oldest = onOwner[0];
    const oldestDays = oldest === undefined ? null : Math.max(0, (now - Date.parse(oldest.task.statusAt)) / MS_PER_DAY);
    return { waiting: waiting.length, byKind, ownerDecisions: { count: onOwner.length, oldestDays } };
}
function people(done) {
    const counts = new Map();
    for (const { team, task } of done) {
        const key = JSON.stringify([team, task.owner]);
        counts.set(key, { team, session: task.owner, done: (counts.get(key)?.done ?? 0) + 1 });
    }
    return [...counts.values()].sort((a, b) => b.done - a.done || byText(a.team, b.team) || byText(a.session, b.session));
}
function splitsOf(teams, zone) {
    const splits = new Map();
    for (const team of teams) {
        for (const move of team.moves) {
            const day = zone.day(new Date(move.at));
            const key = JSON.stringify([day, team.team, move.to]);
            const split = splits.get(key) ?? { day, from: team.team, to: move.to, ids: new Set() };
            split.ids.add(move.id);
            splits.set(key, split);
        }
    }
    return [...splits.values()]
        .map(({ day, from, to, ids }) => ({ day, from, to, tasks: ids.size }))
        .sort((a, b) => byText(a.day, b.day) || byText(a.from, b.from) || byText(a.to, b.to));
}
function doneIn(task, window) {
    return task.status === 'done' && within(window, task.statusAt);
}
function closedIn(task, window) {
    return (task.status === 'done' || task.status === 'dropped') && within(window, task.statusAt);
}
function within(window, at) {
    const ms = Date.parse(at);
    return ms >= window.start && ms < window.end;
}
/** The closed tasks that had a due date, with when they closed and that due, in ms. */
function dated(tasks, zone) {
    return tasks.flatMap((task) => {
        const due = dueTime(task, zone);
        return due === undefined ? [] : [{ closedAt: Date.parse(task.statusAt), due }];
    });
}
function daysBetween(from, to) {
    return (Date.parse(to) - Date.parse(from)) / MS_PER_DAY;
}
function spread(values) {
    const sorted = [...values].sort((a, b) => a - b);
    return { count: sorted.length, median: quantile(sorted, 0.5), p85: quantile(sorted, 0.85) };
}
/** The `q` quantile of sorted values, linearly interpolated between the two nearest; null with none. */
function quantile(sorted, q) {
    const position = q * (sorted.length - 1);
    const below = sorted[Math.floor(position)];
    const above = sorted[Math.ceil(position)];
    return below === undefined || above === undefined ? null : below + (above - below) * (position - Math.floor(position));
}
function banded(values, bands) {
    const bandOf = (value) => bands.findIndex((band) => value < band.below);
    return bands.map((band, index) => ({ label: band.label, count: values.filter((value) => bandOf(value) === index).length }));
}
function tally(keys) {
    const counts = new Map();
    keys.forEach((key) => counts.set(key, (counts.get(key) ?? 0) + 1));
    return counts;
}
function activeRecord(count) {
    return { open: count('open'), 'in-progress': count('in-progress'), verifying: count('verifying'), waiting: count('waiting') };
}
function byText(a, b) {
    return a < b ? -1 : a > b ? 1 : 0;
}
/** A calendar day of the zone as the ms of its UTC midnight, so days step by MS_PER_DAY whatever the clock change. */
function calendarDay(at, zone) {
    const wall = zone.wall(at);
    return Date.UTC(wall.year, wall.month - 1, wall.day);
}
function firstCreatedDay(held, zone) {
    const first = held.reduce((min, each) => Math.min(min ?? Number.POSITIVE_INFINITY, Date.parse(each.task.createdAt)), undefined);
    return first === undefined ? undefined : calendarDay(new Date(first), zone);
}
/** When the zone's clock shows 00:00 on a calendar day. */
function midnight(day, zone) {
    const date = new Date(day);
    return zone.instant({ year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(), hour: 0, minute: 0 }).getTime();
}
/** From the start of calendar day `first` to the end of `last`. */
function dayWindow(first, last, zone) {
    return { start: midnight(first, zone), end: midnight(last + MS_PER_DAY, zone) };
}
function daySpans(first, last, zone) {
    const spans = [];
    let start = midnight(first, zone);
    for (let day = first; day <= last; day += MS_PER_DAY) {
        const end = midnight(day + MS_PER_DAY, zone);
        spans.push({ day: new Date(day).toISOString().slice(0, 10), start, end });
        start = end;
    }
    return spans;
}
