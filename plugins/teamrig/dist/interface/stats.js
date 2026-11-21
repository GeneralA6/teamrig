import { taskNumber } from "../register/fold.js";
import { servedSlip } from "./goals.js";
import { ServedText } from "./text.js";
/**
 * The `stats` document's body: the fold `teamrig stats` and the pane's Stats tab read, under its own field names,
 * so a reader maps it straight onto what it drew before. Every field is written out by name and no stored object is
 * spread: a field the fold gains is not served until a minor adds it here. A count's tasks are served as ids, and
 * each task named has one slim row in `tasks`, so a title is scanned and served once however many counts name it.
 * `RegisterStats.teams` is left out: one team is counted, so it would repeat `all`.
 */
export function statsBody(input) {
    const { stats, health } = input;
    const served = new ServedText(input.shapes);
    const named = new NamedTasks();
    const behind = {
        active: named.ids(stats.tasks.active),
        opened: named.ids(stats.tasks.opened),
        closed: named.ids(stats.tasks.closed),
        overdue: named.ids(stats.tasks.overdue),
        overdueP1: named.ids(stats.tasks.overdueP1),
        ownerDecisions: named.ids(stats.tasks.ownerDecisions),
    };
    const goals = {
        goals: stats.goals.goals.map((goal) => servedProgress(goal, served, named)),
        offGoal: stats.goals.offGoal,
        doneInRange: stats.goals.doneInRange,
    };
    const areas = { teams: servedGroup(stats.areas.teams, named), sessions: servedGroup(stats.areas.sessions, named) };
    return {
        at: new Date(input.now).toISOString(),
        validUntil: new Date(input.validUntil).toISOString(),
        range: stats.range,
        session: input.session,
        days: stats.days.map((day) => ({ day: day.day, opened: day.opened, done: day.done, dropped: day.dropped, active: servedActive(day.active), atLimit: day.atLimit })),
        opened: stats.opened,
        closedTasks: stats.closedTasks,
        droppedTasks: stats.droppedTasks,
        net: stats.net,
        closes: stats.closes,
        recent: { days: stats.recent.days, net: stats.recent.net },
        active: servedActive(stats.active),
        all: servedAll(stats.all),
        newWork: {
            total: stats.newWork.total,
            bySource: {
                self: stats.newWork.bySource.self,
                owner: stats.newWork.bySource.owner,
                lead: stats.newWork.bySource.lead,
                github: stats.newWork.bySource.github,
                session: stats.newWork.bySource.session,
            },
            bugs: stats.newWork.bugs,
            byPriority: stats.newWork.byPriority.map(({ priority, count }) => ({ priority, count })),
            byGoal: stats.newWork.byGoal.map(({ goal, count }) => ({ goal, count })),
            noGoal: stats.newWork.noGoal,
        },
        activeByAge: stats.activeByAge.map(servedBand),
        neverStarted: stats.neverStarted,
        lateDays: stats.lateDays.map(servedBand),
        dueMoved: stats.dueMoved,
        waits: {
            waiting: stats.waits.waiting,
            byKind: { decision: stats.waits.byKind.decision, approval: stats.waits.byKind.approval, task: stats.waits.byKind.task, time: stats.waits.byKind.time },
            ownerDecisions: { count: stats.waits.ownerDecisions.count, oldestDays: stats.waits.ownerDecisions.oldestDays },
        },
        bugs: { active: stats.bugs.active, opened: stats.bugs.opened, fixed: stats.bugs.fixed },
        people: stats.people.map(({ team, session, done }) => ({ team, session, done })),
        splits: stats.splits.map(({ day, from, to, tasks }) => ({ day, from, to, tasks })),
        health: servedHealth(health),
        behind,
        goals,
        areas,
        tasks: named.rows(served, input.names),
        cuts: served.cuts,
    };
}
/** The tasks the counts name, each kept once: the ids go out where a count is, the rows once at the document's end. */
class NamedTasks {
    found = new Map();
    /** The ids of `tasks`, in their order; each task is kept for its row. */
    ids(tasks) {
        return tasks.map(({ task }) => {
            this.found.set(task.id, task);
            return task.id;
        });
    }
    rows(served, names) {
        return [...this.found.values()].sort((one, other) => taskNumber(one.id) - taskNumber(other.id)).map((task) => servedRow(task, served, names));
    }
}
/**
 * A task's slim row. Its title is outside text when a connector's import wrote the task, by the rule `sourceOf`
 * reads a source with: the owner's marker first, then a connector's id. `sourceOf` itself is not called, since it
 * would scan a source name this document does not serve and could list a cut of a field no reader finds here.
 */
function servedRow(task, served, names) {
    const outside = task.source !== names.owner && names.connectors.some((connector) => connector.id === task.source);
    return {
        id: task.id,
        title: served.marked(task.id, 'title', task.title, outside ? 'outside' : 'team'),
        owner: task.owner,
        priority: task.priority,
        status: task.status,
        due: task.due,
    };
}
function servedActive(active) {
    return { open: active.open, 'in-progress': active['in-progress'], verifying: active.verifying, waiting: active.waiting };
}
function servedSpread(spread) {
    return { count: spread.count, median: spread.median, p85: spread.p85 };
}
function servedBand(band) {
    return { label: band.label, count: band.count };
}
function servedAll(all) {
    return {
        active: all.active,
        leadTime: servedSpread(all.leadTime),
        cycleTime: servedSpread(all.cycleTime),
        overdue: { count: all.overdue.count, p1: all.overdue.p1 },
        due: { total: all.due.total, onTime: all.due.onTime },
    };
}
function servedHealth(health) {
    return {
        closeOpen: { level: health.closeOpen.level, ratio: health.closeOpen.ratio },
        backlog: { level: health.backlog.level, net: health.backlog.net, active: health.backlog.active },
        overdue: { level: health.overdue.level, count: health.overdue.count, p1: health.overdue.p1 },
        ownerDecisions: { level: health.ownerDecisions.level, count: health.ownerDecisions.count, oldestDays: health.ownerDecisions.oldestDays },
        backlogClears: { level: health.backlogClears.level, weeks: health.backlogClears.weeks },
    };
}
/** A goal's texts are the team's own, written by its lead: served plain and scanned, as the `goals` document does. */
function servedProgress(goal, served, named) {
    return {
        tag: goal.tag,
        title: served.plain(goal.tag, 'title', goal.title),
        start: goal.start,
        target: goal.target,
        parent: goal.parent,
        slips: goal.slips.map((slip, index) => servedSlip(goal.tag, index, slip, served)),
        done: goal.done,
        open: goal.open,
        doneDays: goal.doneDays.map(({ day, done }) => ({ day, done })),
        pace: goal.pace,
        forecast: goal.forecast,
        state: goal.state,
        tasks: named.ids(goal.tasks),
    };
}
function servedGroup(group, named) {
    const { median } = group;
    return {
        areas: group.areas.map((area) => servedArea(area, named)),
        median: { bugs: median.bugs, p1: median.p1, p1Late: median.p1Late, low: median.low, waits: median.waits, active: median.active },
    };
}
function servedArea(area, named) {
    const cell = (measure) => ({ value: measure.value, usual: measure.usual, level: measure.level, tasks: named.ids(measure.tasks) });
    return {
        team: area.team,
        session: area.session,
        active: area.active,
        cells: { bugs: cell(area.cells.bugs), p1: cell(area.cells.p1), p1Late: cell(area.cells.p1Late), low: cell(area.cells.low), waits: cell(area.cells.waits) },
    };
}
