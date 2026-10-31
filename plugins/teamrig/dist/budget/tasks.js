import { isRecord, isStringArray } from "../core/guards.js";
import { TASK_ID } from "../register/model.js";
import { REVIEW_FLAGS } from "../register/review.js";
import { shellRunsOf, teamrigArgsOf } from "./run-work.js";
/**
 * Which tasks a turn's W is spent on (T734): the task ids its calls name. A shell command names a task as
 * `T<n>` (`teamrig set T734`, a commit subject's `(T734)`) or by a branch or worktree named `t<n>-…`, and a
 * file tool by a path through such a worktree. Only what a call runs counts, never what came back, so a
 * `teamrig list` naming twenty tasks charges none of them. A teamrig flag's value that only mentions a task
 * names none either (T777): `teamrig inbox add --text "T5 is done"`, or the note and follow-ups of a `teamrig set`.
 */
/** `T734` as a word: a time such as `2026-10-20T12` has no word break before its `T`. */
const TASK_WORD = /\bT([1-9]\d*)\b/g;
/** `t734-task-meter`, a branch or worktree named after its task. */
const TASK_BRANCH = /\bt([1-9]\d*)-/g;
/** The most task ids a turn keeps: past it, a turn naming more splits over the first ones. */
export const TASKS_PER_TURN = 20;
/**
 * teamrig's flags whose value only mentions a task: a message, note or proof, a review's parts, a card's texts,
 * and the pointers to other tasks. Not `--what`: `teamrig queue`'s label names the work it runs now.
 */
const MENTION_FLAGS = new Set([
    '--text',
    '--note',
    '--proof',
    '--evidence',
    '--watch',
    '--met',
    '--reason',
    '--title',
    '--description',
    '--about',
    '--ref',
    '--why',
    '--question',
    '--options',
    '--recommend',
    '--default',
    '--why-ask',
    ...Object.values(REVIEW_FLAGS),
    '--followups',
    '--waits',
    '--after',
]);
/** The task ids `text` names through `pattern`, in order. */
function idsIn(text, pattern) {
    return text === undefined ? [] : [...text.matchAll(pattern)].map((match) => `T${match[1] ?? ''}`);
}
/** The values a shell call's teamrig commands give their mention flags: teamrig takes a value only as the next word. */
function mentionsOf(tool) {
    return shellRunsOf(tool).flatMap((run) => {
        const args = teamrigArgsOf(run) ?? [];
        return args.flatMap((word, index) => {
            const flag = args[index - 1];
            return flag !== undefined && !flag.dynamic && MENTION_FLAGS.has(flag.text) ? [word.text] : [];
        });
    });
}
/** `ids` in order, less one of an id for each time `mentioned` holds it. */
function withoutMentions(ids, mentioned) {
    const left = new Map();
    for (const id of mentioned) {
        left.set(id, (left.get(id) ?? 0) + 1);
    }
    return ids.filter((id) => {
        const count = left.get(id) ?? 0;
        if (count === 0) {
            return true;
        }
        left.set(id, count - 1);
        return false;
    });
}
/** The task ids a shell call's command names, less those its teamrig flags only mention; most name none, read without parsing. */
function commandIds(tool) {
    const words = idsIn(tool.command, TASK_WORD);
    const branches = idsIn(tool.command, TASK_BRANCH);
    if (words.length === 0 && branches.length === 0) {
        return [];
    }
    const mentions = mentionsOf(tool);
    const unmentioned = (ids, pattern) => withoutMentions(ids, mentions.flatMap((mention) => idsIn(mention, pattern)));
    return [...unmentioned(words, TASK_WORD), ...unmentioned(branches, TASK_BRANCH)];
}
/** The task ids a call's tools name, in order and once each. */
export function tasksNamedBy(tools) {
    const ids = tools.flatMap((tool) => [...commandIds(tool), ...idsIn(tool.path, TASK_BRANCH)]);
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
