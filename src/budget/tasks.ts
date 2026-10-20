import { isRecord, isStringArray } from '../core/guards.ts';
import { TASK_ID } from '../register/model.ts';
import type { ToolUse } from './line.ts';

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
function idsIn(text: string | undefined, pattern: RegExp): readonly string[] {
  return text === undefined ? [] : [...text.matchAll(pattern)].map((match) => `T${match[1] ?? ''}`);
}

/** The task ids a call's tools name, in order and once each. */
export function tasksNamedBy(tools: readonly ToolUse[]): readonly string[] {
  const ids = tools.flatMap((tool) => [...idsIn(tool.command, TASK_WORD), ...idsIn(tool.command, TASK_BRANCH), ...idsIn(tool.path, TASK_BRANCH)]);
  return [...new Set(ids)];
}

/**
 * The turn a transcript's last read ended in: the tasks its calls named so far, and the W per UTC day it
 * spent, held until the next prompt splits it over them.
 */
export interface OpenTurn {
  readonly tasks: readonly string[];
  readonly held: Readonly<Record<string, number>>;
}

export const NO_TURN: OpenTurn = { tasks: [], held: {} };

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A stored turn; undefined when damaged. */
export function parseOpenTurn(value: unknown): OpenTurn | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const { tasks, held } = value;
  if (!isStringArray(tasks) || !tasks.every((id) => TASK_ID.test(id)) || new Set(tasks).size !== tasks.length || tasks.length > TASKS_PER_TURN || !isRecord(held)) {
    return undefined;
  }
  const days: Record<string, number> = {};
  for (const [day, w] of Object.entries(held)) {
    if (!DAY.test(day) || typeof w !== 'number' || !Number.isFinite(w) || w < 0) {
      return undefined;
    }
    days[day] = w;
  }
  return { tasks, held: days };
}

/** Adds `w` of `day` to a task. */
export type ChargeTask = (day: string, task: string, w: number) => void;

/**
 * One transcript's turn while a run counts. Its W is held per UTC day until the next prompt ends the turn,
 * then splits equally over every task its calls named; a turn that names none leaves its W unattributed.
 * Holding the whole turn keeps the split the same wherever runs cut the transcript; a reading adds an open
 * turn's held W itself.
 */
export class TurnTasks {
  private tasks: string[];
  private held: Map<string, number>;
  private readonly charge: ChargeTask;

  constructor(turn: OpenTurn, charge: ChargeTask) {
    this.tasks = [...turn.tasks];
    this.held = new Map(Object.entries(turn.held));
    this.charge = charge;
  }

  /** A call's tools: the tasks they name join the turn's. */
  named(tools: readonly ToolUse[]): void {
    for (const id of tasksNamedBy(tools)) {
      if (this.tasks.length < TASKS_PER_TURN && !this.tasks.includes(id)) {
        this.tasks.push(id);
      }
    }
  }

  /** W the turn spent on `day`. */
  charged(day: string, w: number): void {
    this.held.set(day, (this.held.get(day) ?? 0) + w);
  }

  /** A new turn begins: the last one's W splits equally over its tasks, or stays unattributed when it named none. */
  prompt(): void {
    for (const [day, w] of this.held) {
      for (const task of this.tasks) {
        this.charge(day, task, w / this.tasks.length);
      }
    }
    this.tasks = [];
    this.held.clear();
  }

  state(): OpenTurn {
    return { tasks: [...this.tasks], held: Object.fromEntries(this.held) };
  }
}
