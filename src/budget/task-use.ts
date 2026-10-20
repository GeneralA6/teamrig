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

/** W per UTC day on `task` in one session's usage, its open turns' share included. */
function daysOf(state: UsageState, task: string): Map<string, number> {
  const days = new Map<string, number>();
  const add = (day: string, w: number): void => {
    days.set(day, (days.get(day) ?? 0) + w);
  };
  for (const [day, tasks] of Object.entries(state.byTask)) {
    const w = tasks[task];
    if (w !== undefined) {
      add(day, w);
    }
  }
  for (const turn of namingTurns(state)) {
    if (turn.tasks.includes(task)) {
      for (const [day, w] of Object.entries(turn.held)) {
        add(day, w / turn.tasks.length);
      }
    }
  }
  return days;
}

/** The W the meter keeps on `task`, per session, from each session's usage by its id. */
export function taskUseOf(bySession: ReadonlyMap<string, UsageState>, task: string): TaskUse {
  const sessions: SessionTaskUse[] = [];
  for (const [session, state] of bySession) {
    const days = daysOf(state, task);
    if (days.size > 0) {
      const byDay = Object.fromEntries([...days].sort(([a], [b]) => a.localeCompare(b)));
      sessions.push({ session, byDay, w: sum(days.values()) });
    }
  }
  sessions.sort((a, b) => b.w - a.w);
  return { task, sessions, w: sum(sessions.map((session) => session.w)) };
}

/** The W of a UTC day a session's turns put on some task, its open turns that named one included. */
export function attributedW(state: UsageState, day: string): number {
  return sum(Object.values(state.byTask[day] ?? {})) + sum(namingTurns(state).map((turn) => turn.held[day] ?? 0));
}
