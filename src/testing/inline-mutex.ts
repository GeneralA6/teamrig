import type { Mutex } from '../core/lock.ts';

/** A `Mutex` that runs the task at once and counts how often it was taken. */
export class InlineMutex implements Mutex {
  runs = 0;

  async run<T>(task: () => Promise<T>): Promise<T> {
    this.runs += 1;
    return task();
  }
}
