import { isRecord, isStringArray } from "../core/guards.js";
import { TASK_ID } from "../register/model.js";
/**
 * Which tasks a turn's W is spent on (T734): the task ids its calls name. A shell command names a task as
 * `T<n>` (`teamrig set T734`, a commit subject's `(T734)`) or by a branch or worktree named `t<n>-…`, and a
 * file tool by a path through such a worktree. Only what a call runs counts, never what came back, so a
 * `teamrig list` naming twenty tasks charges none of them.
 */
/** `T734` as a word: a time such as `2026-10-20T12` has no word break before its `T`. */
const TASK_WORD = /\bT([1-9]\d*)\b/g;
/** `t734-task-meter`, a branch or worktree named after its task. */
const TASK_BRANCH = /\bt([1-9]\d*)-/g;
/** The most task ids a turn keeps: past it, a turn naming more splits over the first ones. */
export const TASKS_PER_TURN = 20;
/** The task ids `text` names through `pattern`, in order. */
function idsIn(text, pattern) {
    return text === undefined ? [] : [...text.matchAll(pattern)].map((match) => `T${match[1] ?? ''}`);
}
/** The task ids a call's tools name, in order and once each. */
export function tasksNamedBy(tools) {
    const ids = tools.flatMap((tool) => [...idsIn(tool.command, TASK_WORD), ...idsIn(tool.command, TASK_BRANCH), ...idsIn(tool.path, TASK_BRANCH)]);
    return [...new Set(ids)];
}
export const NO_TURN = { tasks: [], held: {} };
const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** A stored turn; undefined when damaged. */
export function parseOpenTurn(value) {
    if (!isRecord(value)) {
        return undefined;
    }
    const { tasks, held } = value;
    if (!isStringArray(tasks) || !tasks.every((id) => TASK_ID.test(id)) || new Set(tasks).size !== tasks.length || tasks.length > TASKS_PER_TURN || !isRecord(held)) {
        return undefined;
    }
    const days = {};
    for (const [day, w] of Object.entries(held)) {
        if (!DAY.test(day) || typeof w !== 'number' || !Number.isFinite(w) || w < 0) {
            return undefined;
        }
        days[day] = w;
    }
    return { tasks, held: days };
}
/**
 * One transcript's turn while a run counts. Its W is held per UTC day until the next prompt ends the turn,
 * then splits equally over every task its calls named; a turn that names none leaves its W unattributed.
 * Holding the whole turn keeps the split the same wherever runs cut the transcript; a reading adds an open
 * turn's held W itself.
 */
export class TurnTasks {
    tasks;
    held;
    charge;
    constructor(turn, charge) {
        this.tasks = [...turn.tasks];
        this.held = new Map(Object.entries(turn.held));
        this.charge = charge;
    }
    /** A call's tools: the tasks they name join the turn's. */
    named(tools) {
        for (const id of tasksNamedBy(tools)) {
            if (this.tasks.length < TASKS_PER_TURN && !this.tasks.includes(id)) {
                this.tasks.push(id);
            }
        }
    }
    /** W the turn spent on `day`. */
    charged(day, w) {
        this.held.set(day, (this.held.get(day) ?? 0) + w);
    }
    /** A new turn begins: the last one's W splits equally over its tasks, or stays unattributed when it named none. */
    prompt() {
        for (const [day, w] of this.held) {
            for (const task of this.tasks) {
                this.charge(day, task, w / this.tasks.length);
            }
        }
        this.tasks = [];
        this.held.clear();
    }
    state() {
        return { tasks: [...this.tasks], held: Object.fromEntries(this.held) };
    }
}
