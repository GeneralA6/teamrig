import { constants, getPriority, setPriority } from 'node:os';

/** Reads and sets a process's CPU priority on Node's scale (`os.getPriority`): a higher number yields the CPU to a lower one. */
export interface Priorities {
  of(pid: number): number;
  set(pid: number, priority: number): void;
}

/** The host's priorities, through Node's `os.getPriority` and `os.setPriority`. */
export const NODE_PRIORITIES: Priorities = {
  of: (pid) => getPriority(pid),
  set: (pid, priority) => setPriority(pid, priority),
};

/**
 * A queued step's priority: below normal (Windows' class of that name, nice 10 on POSIX), so the owner's terminal and
 * apps win the CPU while it runs and it takes what they leave (T1512). The processes it starts inherit it.
 */
export const STEP_PRIORITY = constants.priority.PRIORITY_BELOW_NORMAL;

/**
 * Lowers a step just started to `STEP_PRIORITY`, never raising one that runs lower already (started under `nice`, or
 * by a step that is). A step that ended before it is lowered has nothing left to lower, and one the system will not
 * lower runs on at the priority it started with, as every step did before: neither is worth failing the step for.
 */
export function lowerStep(priorities: Priorities, pid: number): void {
  try {
    if (priorities.of(pid) < STEP_PRIORITY) {
      priorities.set(pid, STEP_PRIORITY);
    }
  } catch {
    // The step runs on at the priority it started with.
  }
}
