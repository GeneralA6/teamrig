import { parseDeadline } from "../core/time.js";
import { taskNumber } from "./fold.js";
import { ACTIVE_STATUSES } from "./model.js";
import { scoreOf, valueOf } from "./score.js";
import { isFinished, isReady, waitContext } from "./waits.js";
import { currentWeek } from "./week.js";
/**
 * The dependency tree of one register, from the links its tasks already have: a task needs the tasks it is planned
 * after (`after`) and the tasks it waits on (`--waits task:`), and is needed by every active task that names it so.
 * A need is finished once its task is done or dropped, or retired from every register (waits.ts); a need another
 * register of the team tree holds is read there ({@link TasksElsewhere}, one numbering across the tree). Read side
 * only, with no `node:` import: `show --tree`, `list`, `check`, `start`, the meeting agenda, the plan, the live-tasks
 * note and the status pane read it, and the register's write policy refuses a link that would close a loop with
 * {@link needPath}.
 */
/** What a task needs first: the tasks it is planned after, then the tasks it waits on, each once. */
export function needsOf(task) {
    const waitedOn = task.waits.flatMap((reason) => (reason.kind === 'task' ? [reason.id] : []));
    return [...new Set([...task.after, ...waitedOn])];
}
/**
 * True when an active task of `tasks` needs an id they lack ({@link needsOf}), which another register of the team tree
 * may hold; a read with none has no need to read the tree's other registers.
 */
export function needsElsewhere(tasks) {
    return [...tasks.values()].some((task) => ACTIVE_STATUSES.includes(task.status) && needsOf(task).some((id) => !tasks.has(id)));
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
/**
 * The keys of plan order, in order: the first one on which two tasks differ puts one ahead: `pinned` (a task the
 * owner's leader pinned, above every other key); `band` (expedite, then Roadmap and Maintenance, then the rest;
 * score.ts); `ready` (a task that can move before one with a need not finished, whose value still reaches that need
 * through its score); `score` (the highest WSJF score first; score.ts); `started` (an in-progress task stays on top of
 * its equals); `due` (effective due, the earliest first, undated last); `unblocks` (the best priority among the active
 * tasks that need it, then the most of them; none last); `week` (in the week plan in force first); `size` (the smallest
 * first, unsized last); `age` (the lowest number first).
 */
export const PLAN_KEYS = ['pinned', 'band', 'ready', 'score', 'started', 'due', 'unblocks', 'week', 'size', 'age'];
const BY_KEY = {
    pinned: (a, b) => trueFirst(a.pinned, b.pinned),
    band: (a, b) => lowFirst(a.ranked?.band, b.ranked?.band),
    ready: (a, b) => trueFirst(b.blocked, a.blocked),
    score: (a, b) => highFirst(a.ranked?.score, b.ranked?.score),
    started: (a, b) => trueFirst(a.started, b.started),
    due: (a, b) => lowFirst(a.at, b.at),
    unblocks: (a, b) => lowFirst(a.unblocks?.priority, b.unblocks?.priority) || (b.unblocks?.count ?? 0) - (a.unblocks?.count ?? 0),
    week: (a, b) => trueFirst(a.inWeek, b.inWeek),
    size: (a, b) => lowFirst(a.size ?? undefined, b.size ?? undefined),
    age: (a, b) => taskNumber(a.id) - taskNumber(b.id),
};
/** The first of {@link PLAN_KEYS} on which the two places differ; undefined when they tie on every one. */
export function decidingKey(a, b) {
    return PLAN_KEYS.find((key) => BY_KEY[key](a, b) !== 0);
}
/** Plan order: by the first of {@link PLAN_KEYS} on which the places differ. */
export function planOrder(a, b) {
    const key = decidingKey(a, b);
    return key === undefined ? 0 : BY_KEY[key](a, b);
}
/** The lower number first, a missing one last. */
function lowFirst(a, b) {
    const x = a ?? Number.POSITIVE_INFINITY;
    const y = b ?? Number.POSITIVE_INFINITY;
    return x === y ? 0 : x < y ? -1 : 1;
}
/** The higher number first, a missing one last. */
function highFirst(a, b) {
    return lowFirst(a === undefined ? undefined : -a, b === undefined ? undefined : -b);
}
/** A true flag first. */
function trueFirst(a, b) {
    return Number(b === true) - Number(a === true);
}
/** What a register outside a team tree reads elsewhere: nothing. */
export const NO_TASKS_ELSEWHERE = new Map();
/**
 * The team tree as team `holder` reads it, from a read of team `reader`'s register (its `own` tasks and what it read
 * `elsewhere`): the holder's tasks, and every other register's, the reader's own among them, as the holder's
 * elsewhere; so another team's task is judged as that team's sessions judge it. The reader's own task wins an id
 * another register holds too, which only a register numbered before its tree can have.
 */
export function readAs(holder, reader, own, elsewhere) {
    const tasks = new Map();
    const others = new Map();
    for (const task of own) {
        others.set(task.id, { team: reader, task });
    }
    for (const [id, away] of elsewhere) {
        if (away.team === holder) {
            tasks.set(id, away.task);
        }
        else if (!others.has(id)) {
            others.set(id, away);
        }
    }
    return { tasks, elsewhere: others };
}
/** What a task is worth by its class, goal and severity, as `ranking` reads them. */
function valueFacts(task, ranking) {
    return { workClass: ranking.classOf(task), rank: ranking.goalOf(task)?.rank ?? null, type: task.type ?? null, critical: task.critical ?? false };
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
    /** The week plan in force, whose tasks plan order puts first after band, readiness, score, due and need; null: none. */
    week;
    tasks;
    /** The tasks of the team tree's other registers, for a need this read lacks. */
    elsewhere;
    /** Per id, the active tasks that need it, by number. */
    needers;
    dues = new Map();
    now;
    ranking;
    /** Each place's score, kept because a sort reads every task's many times. */
    ranked = new Map();
    /**
     * `week` defaults to the newest week tag of `tasks` started by `now`; a register read passes the one it knows.
     * `elsewhere` holds the tasks of the team tree's other registers, which a need the read lacks is read from.
     * `ranking` gives its places a band and a score; a read that sorts or lists tasks passes one.
     */
    constructor(tasks, now, zone, week = currentWeek(tasks.values(), now, zone), elsewhere = NO_TASKS_ELSEWHERE, ranking) {
        this.tasks = tasks;
        this.elsewhere = elsewhere;
        this.zone = zone;
        this.week = week;
        this.now = now.getTime();
        this.ranking = ranking;
        this.context = waitContext(tasks, now, zone, elsewhere);
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
    /** The task another register of the team tree holds under an id the read lacks; undefined when the read has it or none does. */
    elsewhereOf(id) {
        return this.tasks.has(id) ? undefined : this.elsewhere.get(id);
    }
    /**
     * The ids the task needs first ({@link needsOf}); a need may be missing from the read: another register of the team
     * tree holds it, or it was retired, so finished.
     */
    needs(id) {
        const task = this.tasks.get(id);
        return task === undefined ? [] : needsOf(task);
    }
    /** The active tasks that need it, by number. */
    neededBy(id) {
        return this.needers.get(id) ?? [];
    }
    /**
     * The best of the active tasks that need an active task ({@link Unblocks}); undefined for a finished task, one the
     * read lacks, or one nothing active needs.
     */
    unblocks(id) {
        const needers = this.isActiveId(id) ? this.neededBy(id) : [];
        const best = Math.min(...needers.map((needer) => needer.priority));
        const first = needers.find((needer) => needer.priority === best);
        return first === undefined ? undefined : { first: first.id, priority: best, count: needers.length };
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
     * The task's place in plan order on its effective due, what it unblocks and this tree's week, for sorting rows of
     * several registers together, each placed by its own register's tree ({@link planOrder}).
     */
    placeOf(task) {
        return {
            id: task.id,
            pinned: task.pin !== undefined && task.pin !== null,
            ranked: this.rankedOf(task),
            blocked: this.isBlocked(task),
            at: this.dueTime(task),
            started: task.status === 'in-progress',
            unblocks: this.unblocks(task.id),
            inWeek: this.week !== null && task.week === this.week,
            size: task.size ?? null,
        };
    }
    /** Plan order ({@link PLAN_KEYS}) on effective dues, what each task unblocks and this tree's week. */
    byPlanOrder(a, b) {
        return planOrder(this.placeOf(a), this.placeOf(b));
    }
    /** A task's band and score, and the class and goal they come from; undefined with no ranking. */
    rankedOf(task) {
        const { ranking } = this;
        if (ranking === undefined) {
            return undefined;
        }
        const known = this.ranked.get(task.id);
        if (known !== undefined) {
            return known;
        }
        const facts = valueFacts(task, ranking);
        const needers = this.isActiveId(task.id) ? this.neededBy(task.id) : [];
        const neededValue = needers.length === 0 ? undefined : Math.max(...needers.map((needer) => valueOf(valueFacts(needer, ranking), ranking.focus)));
        const score = scoreOf({ ...facts, priority: task.priority, ownerSourced: task.source === ranking.ownerSource, dueAt: this.dueTime(task), neededValue, sizing: ranking.sizingOf(task) }, ranking.focus, this.now);
        const place = { ...score, workClass: facts.workClass, goal: ranking.goalOf(task) };
        this.ranked.set(task.id, place);
        return place;
    }
    /** The tasks in plan order ({@link byPlanOrder}). */
    inPlanOrder(tasks) {
        return [...tasks].sort((a, b) => this.byPlanOrder(a, b));
    }
    /**
     * The first move toward finishing the task: down its unfinished needs in plan order to one that needs nothing
     * unfinished in this read, whose unfinished need another register of the team tree holds comes first (its owner
     * there moves), then its pending decision or approval (the lead's or the owner's), then a time still to come, else
     * its owner's work. Undefined for a finished task, or when every unfinished need runs into a loop.
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
    /** The task's first unfinished need, in {@link needsOf} order, that this read lacks and another register holds. */
    unfinishedElsewhere(task) {
        return needsOf(task)
            .flatMap((id) => this.elsewhereOf(id) ?? [])
            .find((away) => !isFinished(away.task.id, this.context));
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
        const away = this.unfinishedElsewhere(task);
        if (away !== undefined) {
            return { kind: 'elsewhere', who: away.task.owner, team: away.team, need: away.task, task, behind: undefined };
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
    /** True for an active task with a need not finished here or in another register; a wait on a person or a time is no need. */
    isBlocked(task) {
        return isActive(task) && needsOf(task).some((id) => !isFinished(id, this.context));
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
