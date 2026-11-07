import type { SizeBase } from '../register/events.ts';
import type { UsageState } from './store.ts';
import type { OpenTurn } from './tasks.ts';

/**
 * What a task cost (T734; T649's estimate flag reads it): the W each session's turns spent on it per UTC
 * day, from the meter's `byTask` plus the task's share of each open turn that named it, which the turn's
 * next prompt moves into `byTask`.
 */

/** One session's W on a task. */
export interface SessionTaskUse {
  readonly session: string;
  /** W per UTC day, oldest first. */
  readonly byDay: Readonly<Record<string, number>>;
  readonly w: number;
}

export interface TaskUse {
  readonly task: string;
  /** The sessions whose turns spent W on it, the most first. */
  readonly sessions: readonly SessionTaskUse[];
  readonly w: number;
}

function sum(values: Iterable<number>): number {
  let total = 0;
  for (const value of values) {
    total += value;
  }
  return total;
}

/** The open turns of a session's transcripts that named a task. */
function namingTurns(state: UsageState): OpenTurn[] {
  return Object.values(state.cursors)
    .map(({ turn }) => turn)
    .filter((turn) => turn.tasks.length > 0);
}

/** W per task on each UTC day of one session's usage: `byTask`, plus each open turn's held W split equally over the tasks it named. */
export function taskDaysOf(state: UsageState): ReadonlyMap<string, ReadonlyMap<string, number>> {
  const days = new Map<string, Map<string, number>>();
  const add = (day: string, task: string, w: number): void => {
    const tasks = days.get(day) ?? new Map<string, number>();
    tasks.set(task, (tasks.get(task) ?? 0) + w);
    days.set(day, tasks);
  };
  for (const [day, tasks] of Object.entries(state.byTask)) {
    for (const [task, w] of Object.entries(tasks)) {
      add(day, task, w);
    }
  }
  for (const turn of namingTurns(state)) {
    for (const [day, w] of Object.entries(turn.held)) {
      for (const task of turn.tasks) {
        add(day, task, w / turn.tasks.length);
      }
    }
  }
  return days;
}

/** W per UTC day on `task` out of one session's `taskDaysOf`. */
function daysOf(days: ReturnType<typeof taskDaysOf>, task: string): [string, number][] {
  return [...days].flatMap(([day, tasks]): [string, number][] => {
    const w = tasks.get(task);
    return w === undefined ? [] : [[day, w]];
  });
}

/**
 * `taskUseOf` for a caller that asks about many tasks, as the ranking and the budget hooks do: each session's days are
 * worked out once, not once per task.
 */
export function taskUseReader(bySession: ReadonlyMap<string, UsageState>): (task: string) => TaskUse {
  const stores = [...bySession].map(([session, state]) => ({ session, days: taskDaysOf(state) }));
  return (task) => {
    const sessions: SessionTaskUse[] = [];
    for (const { session, days } of stores) {
      const own = daysOf(days, task);
      if (own.length > 0) {
        const byDay = Object.fromEntries(own.sort(([a], [b]) => a.localeCompare(b)));
        sessions.push({ session, byDay, w: sum(own.map(([, w]) => w)) });
      }
    }
    sessions.sort((a, b) => b.w - a.w);
    return { task, sessions, w: sum(sessions.map((session) => session.w)) };
  };
}

/** The W the meter keeps on `task`, per session, from each session's usage by its id. */
export function taskUseOf(bySession: ReadonlyMap<string, UsageState>, task: string): TaskUse {
  return taskUseReader(bySession)(task);
}

/** The W of a task's use per UTC day, its sessions' summed. */
export function wByDay(use: TaskUse): Map<string, number> {
  const days = new Map<string, number>();
  for (const session of use.sessions) {
    for (const [day, w] of Object.entries(session.byDay)) {
      days.set(day, (days.get(day) ?? 0) + w);
    }
  }
  return days;
}

/**
 * The W a task spent since its size was set (T649): with no base, all the meter keeps on it; else the days after the
 * base's day in full, and on that day what it spent past the base's W. A day before it counts nothing, so a base whose
 * day the meter no longer keeps counts only the days after it.
 */
export function spentSince(use: TaskUse, base: SizeBase | null): number {
  if (base === null) {
    return use.w;
  }
  let spent = 0;
  for (const [day, w] of wByDay(use)) {
    if (day > base.day) {
      spent += w;
    } else if (day === base.day) {
      spent += Math.max(0, w - base.w);
    }
  }
  return spent;
}

/**
 * The W the meter keeps on every task, by its id: `taskUseOf(...).w` of each in one pass over the stores, since the
 * budget hooks that read it run on every turn and a team's stores name hundreds of tasks.
 */
export function taskWOf(states: Iterable<UsageState>): ReadonlyMap<string, number> {
  const byTask = new Map<string, number>();
  const add = (task: string, w: number): void => {
    byTask.set(task, (byTask.get(task) ?? 0) + w);
  };
  for (const state of states) {
    for (const tasks of Object.values(state.byTask)) {
      for (const [task, w] of Object.entries(tasks)) {
        add(task, w);
      }
    }
    for (const turn of namingTurns(state)) {
      const share = sum(Object.values(turn.held)) / turn.tasks.length;
      for (const task of turn.tasks) {
        add(task, share);
      }
    }
  }
  return byTask;
}

/** The W of a UTC day a session's turns put on some task, its open turns that named one included. */
export function attributedW(state: UsageState, day: string): number {
  return sum(Object.values(state.byTask[day] ?? {})) + sum(namingTurns(state).map((turn) => turn.held[day] ?? 0));
}
