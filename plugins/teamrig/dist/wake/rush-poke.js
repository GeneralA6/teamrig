import { KIT_NAME } from "../core/home.js";
import { costText } from "./decide.js";
/**
 * The owner's "work left": an open or in-progress task, not one waiting or verifying whose waits cleared, since a
 * verifying task's proof time passing is not a reason to wake a tab in a rush.
 */
function isWorkLeft(task) {
    return task.status === 'open' || task.status === 'in-progress';
}
/** The task a poke names: the most urgent one tagged with the rush's goal, else the most urgent. */
function topTaskOf(tasks, goal) {
    return tasks.find((task) => task.goals.includes(goal)) ?? tasks[0];
}
/**
 * Whether to poke the tab now, later, or not at all. One poke per idle stretch: a poke at or after the tab's last turn
 * blocks another until the tab has a new turn, so a tab that ignores a poke (or whose poke was dropped) is not poked
 * again and again. Nothing is due past the rush's end.
 */
export function decideRushPoke(input) {
    const { rush, lastTurnAt, now, idleMs, lastPokeAt } = input;
    if (rush === undefined || lastTurnAt === undefined) {
        return { kind: 'none' };
    }
    const task = topTaskOf(input.startable.filter(isWorkLeft), rush.goal);
    if (task === undefined || (lastPokeAt !== undefined && lastPokeAt >= lastTurnAt)) {
        return { kind: 'none' };
    }
    const dueAt = lastTurnAt + idleMs;
    if (dueAt >= rush.endsAt) {
        return { kind: 'none' };
    }
    return now < dueAt ? { kind: 'later', at: dueAt } : { kind: 'poke', task, idleMs: now - lastTurnAt };
}
/**
 * True when a queued step of the session holds the host now: its start is in the ledger with no end, started within
 * `maxRunMs` (a step is killed by then, so an older open start is one whose process died without its end). A step
 * still waiting in line for the host has no start yet, so it does not count: the tab can work on meanwhile.
 */
export function stepRunningFor(records, session, now, maxRunMs) {
    const ended = new Set();
    const started = new Map();
    for (const record of records) {
        if (record.type !== 'heavy' || record.session !== session) {
            continue;
        }
        if (record.endedAt === null) {
            started.set(record.id, Date.parse(record.startedAt));
        }
        else {
            ended.add(record.id);
        }
    }
    return [...started].some(([id, at]) => !ended.has(id) && now - at < maxRunMs);
}
function minutesText(ms) {
    return `${Math.round(ms / 60_000)} min`;
}
/** The prompt a poke submits: why the tab was woken, and the task to go on with. */
export function rushPokePrompt(session, rush, task, idleMs, cost) {
    return [
        `Rush on ${rush.goal}: this tab sat idle ${minutesText(idleMs)} with work left and no queued step of its own running.`,
        `Start or continue ${task.id} (${task.title}) now, or your top task if another comes first; a run still waiting in the queue is no reason to wait.`,
        `If nothing can move, write why in its note (\`${KIT_NAME} set ${task.id} --session ${session} --status <status> --note "..."\`). This poke costs ${costText(cost)}.`,
    ].join(' ');
}
/** The person's toast for a poke. */
export function rushPokeToast(rush, task, idleMs, cost) {
    return `${KIT_NAME} poked this tab (rush on ${rush.goal}, idle ${minutesText(idleMs)}): ${task.id} (${costText(cost)})`;
}
