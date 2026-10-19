import { parseDeadline } from "../core/time.js";
import { taskNumber } from "./fold.js";
import { ACTIVE_STATUSES } from "./model.js";
import { isFinished, isReady, waitContext } from "./waits.js";
/**
 * The dependency tree of one register, from the links its tasks already have: a task needs the tasks it is planned
 * after (`after`) and the tasks it waits on (`--waits task:`), and is needed by every active task that names it so.
 * A need is finished once its task is done or dropped, or retired from the read (waits.ts). Read side only, with no
 * `node:` import: `show --tree`, `list`, `check`, `start`, the meeting agenda, the plan, the live-tasks note and the
 * status pane read it, and the register's write policy refuses a link that would close a loop with {@link needPath}.
 */
/** What a task needs first: the tasks it is planned after, then the tasks it waits on, each once. */
export function needsOf(task) {
    const waitedOn = task.waits.flatMap((reason) => (reason.kind === 'task' ? [reason.id] : []));
    return [...new Set([...task.after, ...waitedOn])];
}
/**
 * The shortest chain from `from` to `to`, each task needing the next, over every task the map holds whatever its
 * status (a finished task may be reopened); `[from]` when both are one task, undefined when no chain leads there.
 * A write that makes `id` need `other` closes a loop when `needPath(tasks, other, id)` finds one.
 */
export function needPath(tasks, from, to) {
    return shortestPath(from, to, (id) => {
        const task = tasks.get(id);
        return task === undefined ? [] : needsOf(task);
    });
}
/** A chain as printed: `T2 -> T194 -> T2`, each task needing the next. */
export function pathText(path) {
    return path.join(' -> ');
}
/**
 * How a loop's link from `id` to `other` (of `owner`) goes: the step `id` needs becomes a task of its own. A link by
 * a task wait goes by `set --ask`, whose waits replace the old ones; a plan dependency by a new task and
 * `update --after`, which replaces the old list.
 */
export function loopFix(id, other, owner, byWait) {
    const command = byWait
        ? `teamrig set ${id} --status waiting --ask ${owner} --text "<the step>"`
        : `teamrig add --owner ${owner} --title "<the step>", then teamrig update ${id} --after <its id>`;
    return `make the step ${id} needs from ${other} its own task: ${command}`;
}
/** Plan order: priority, then deadline (undated last), then id. */
export function planOrder(a, b) {
    const dueA = a.at ?? Number.POSITIVE_INFINITY;
    const dueB = b.at ?? Number.POSITIVE_INFINITY;
    return a.priority - b.priority || (dueA === dueB ? 0 : dueA < dueB ? -1 : 1) || taskNumber(a.id) - taskNumber(b.id);
}
/**
 * The tree of one register read at `now`, over teamrig's tasks or a reader's own rows ({@link TreeTask}): what it
 * hands back (a needer, a move's task, a waiting task) is one of those rows.
 */
export class TaskTree {
    /** How the same read judges a waiting task's reasons ready. */
    context;
    /** The team's zone: a stored due day is a day of it, and rows show times in it. */
    zone;
    tasks;
    /** Per id, the active tasks that need it, by number. */
    needers;
    dues = new Map();
    constructor(tasks, now, zone) {
        this.tasks = tasks;
        this.zone = zone;
        this.context = waitContext(tasks, now, zone);
        const needers = new Map();
        for (const task of [...tasks.values()].filter(isActive).sort((a, b) => taskNumber(a.id) - taskNumber(b.id))) {
            for (const id of needsOf(task)) {
                needers.set(id, [...(needers.get(id) ?? []), task]);
            }
        }
        this.needers = needers;
    }
    /** The task of the read; undefined when the read lacks it. */
    task(id) {
        return this.tasks.get(id);
    }
    /** The ids the task needs first ({@link needsOf}); a need may be missing from the read: retired, so finished. */
    needs(id) {
        const task = this.tasks.get(id);
        return task === undefined ? [] : needsOf(task);
    }
    /** The active tasks that need it, by number. */
    neededBy(id) {
        return this.needers.get(id) ?? [];
    }
    /**
     * Whom an active task holds up beyond its owner: the active tasks of other owners that need it, the one with the
     * earliest effective due first, then in plan order. Empty for a finished task or one the read lacks.
     */
    neededByOthers(id) {
        const task = this.tasks.get(id);
        if (task === undefined || !isActive(task)) {
            return [];
        }
        const dueAt = (needer) => this.effectiveDue(needer.id)?.at ?? Number.POSITIVE_INFINITY;
        return this.neededBy(id)
            .filter((needer) => needer.owner !== task.owner)
            .sort((a, b) => (dueAt(a) === dueAt(b) ? this.byPlanOrder(a, b) : dueAt(a) < dueAt(b) ? -1 : 1));
    }
    /**
     * The earliest of the task's own due and the effective due of every active task that needs it, so work that holds
     * a dated task inherits its date; the task's own due wins a tie. A finished task keeps its own due only.
     * Undefined when neither the task nor anything needing it has a date (or the read lacks the task).
     */
    effectiveDue(id) {
        if (!this.dues.has(id)) {
            this.dues.set(id, this.findDue(id));
        }
        return this.dues.get(id);
    }
    /** The task's effective deadline in ms, or undefined when it has none; a task the read lacks keeps its own. */
    dueTime(task) {
        if (!this.tasks.has(task.id)) {
            return task.due === null ? undefined : parseDeadline(task.due, this.zone)?.getTime();
        }
        return this.effectiveDue(task.id)?.at;
    }
    /**
     * The task's place in plan order on its effective due, for sorting rows of several registers together, each
     * placed by its own register's tree ({@link planOrder}).
     */
    placeOf(task) {
        return { id: task.id, priority: task.priority, at: this.dueTime(task) };
    }
    /** Plan order on effective dues: priority, then effective due (undated last), then id. */
    byPlanOrder(a, b) {
        return planOrder(this.placeOf(a), this.placeOf(b));
    }
    /** The tasks in plan order on effective dues. */
    inPlanOrder(tasks) {
        return [...tasks].sort((a, b) => this.byPlanOrder(a, b));
    }
    /**
     * The first move toward finishing the task: down its unfinished needs in plan order to one that needs nothing
     * unfinished, whose pending decision or approval (the lead's or the owner's) comes first, then a time still to
     * come, else its owner's work. Undefined for a finished task, or when every unfinished need runs into a loop.
     */
    nextMove(id) {
        return this.isActiveId(id) ? this.moveFrom(id, new Set()) : undefined;
    }
    /**
     * What waits on `session`: every active task of another owner that directly needs an unfinished task of the
     * session, or waits on its decision or approval, in plan order.
     */
    waitingOn(session) {
        const waiting = [...this.tasks.values()].flatMap((task) => {
            if (!isActive(task) || task.owner === session) {
                return [];
            }
            const needs = this.inPlanOrder(this.unfinishedNeeds(task).filter((need) => need.owner === session));
            const asks = task.waits.filter((reason) => (reason.kind === 'decision' || reason.kind === 'approval') && reason.who === session);
            return needs.length === 0 && asks.length === 0 ? [] : [{ task, needs, asks }];
        });
        return waiting.sort((a, b) => this.byPlanOrder(a.task, b.task));
    }
    /**
     * The loops among active tasks, which none of their tasks can ever leave: each the shortest chain from its first
     * task back to it (`[T2, T194, T2]`), the first task the lowest-numbered one not already in a loop found.
     */
    loops() {
        const inLoop = new Set();
        const loops = [];
        const active = [...this.tasks.values()].filter(isActive).sort((a, b) => taskNumber(a.id) - taskNumber(b.id));
        for (const task of active) {
            const back = inLoop.has(task.id) ? undefined : this.loopThrough(task.id);
            if (back !== undefined) {
                back.forEach((id) => inLoop.add(id));
                loops.push(back);
            }
        }
        return loops;
    }
    loopThrough(id) {
        for (const need of this.activeNeeds(id)) {
            const path = shortestPath(need, id, (next) => this.activeNeeds(next));
            if (path !== undefined) {
                return [id, ...path];
            }
        }
        return undefined;
    }
    /** The needs of the task that are active, as a loop among active tasks follows them. */
    activeNeeds(id) {
        return this.needs(id).filter((need) => this.isActiveId(need));
    }
    unfinishedNeeds(task) {
        return needsOf(task).flatMap((id) => {
            const need = this.tasks.get(id);
            return need !== undefined && !isFinished(id, this.context) ? [need] : [];
        });
    }
    moveFrom(id, seen) {
        const task = this.tasks.get(id);
        if (task === undefined) {
            return undefined;
        }
        seen.add(id);
        const needs = this.inPlanOrder(this.unfinishedNeeds(task));
        if (needs.length > 0) {
            for (const need of needs.filter((candidate) => !seen.has(candidate.id))) {
                const move = this.moveFrom(need.id, seen);
                if (move !== undefined) {
                    return move;
                }
            }
            return undefined;
        }
        const pending = task.waits.filter((reason) => !isReady(reason, this.context));
        const person = pending.find((reason) => reason.kind === 'decision' || reason.kind === 'approval');
        if (person !== undefined) {
            return { kind: person.kind, who: person.who, task, behind: this.behind(person.who, task) };
        }
        const time = pending.find((reason) => reason.kind === 'time');
        return time?.kind === 'time'
            ? { kind: 'time', who: task.owner, task, at: time.at, behind: this.behind(task.owner, task) }
            : { kind: 'work', who: task.owner, task, behind: this.behind(task.owner, task) };
    }
    /** The first in plan order of the in-progress tasks of `who` with a higher priority than `task`. */
    behind(who, task) {
        const ahead = [...this.tasks.values()].filter((other) => other.owner === who && other.status === 'in-progress' && other.id !== task.id && other.priority < task.priority);
        return this.inPlanOrder(ahead)[0];
    }
    findDue(id) {
        const task = this.tasks.get(id);
        if (task === undefined) {
            return undefined;
        }
        let best = ownDue(task, null, this.zone);
        if (!isActive(task)) {
            return best;
        }
        // Upward over every active task that needs it, directly or not, each once; a nearer or lower-numbered one wins a tie.
        const seen = new Set([id]);
        const queue = [...this.neededBy(id)];
        for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
            if (seen.has(next.id)) {
                continue;
            }
            seen.add(next.id);
            const due = ownDue(next, next.id, this.zone);
            if (due !== undefined && (best === undefined || due.at < best.at)) {
                best = due;
            }
            queue.push(...this.neededBy(next.id));
        }
        return best;
    }
    isActiveId(id) {
        const task = this.tasks.get(id);
        return task !== undefined && isActive(task);
    }
}
function isActive(task) {
    return ACTIVE_STATUSES.includes(task.status);
}
/** The task's own due as an effective due from `from`, read in `zone`; undefined when it has none or it does not parse. */
function ownDue(task, from, zone) {
    const at = task.due === null ? undefined : parseDeadline(task.due, zone)?.getTime();
    return task.due === null || at === undefined ? undefined : { due: task.due, at, from };
}
/** Breadth first from `from` along `next` to `to`: the shortest chain, both ends included; undefined when none. */
function shortestPath(from, to, next) {
    const cameFrom = new Map([[from, null]]);
    const queue = [from];
    for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
        if (id === to) {
            const path = [];
            for (let step = id; step !== null && step !== undefined; step = cameFrom.get(step)) {
                path.unshift(step);
            }
            return path;
        }
        for (const following of next(id)) {
            if (!cameFrom.has(following)) {
                cameFrom.set(following, id);
                queue.push(following);
            }
        }
    }
    return undefined;
}
