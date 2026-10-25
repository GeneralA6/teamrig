import type { Mutex } from '../core/lock.ts';
import { taskNumber } from './fold.ts';
import type { EventLog } from './store.ts';

/**
 * Where a register's new task numbers come from (T1139). A register issues the higher of its own next number
 * and the floor the numbering gives, so an id names one task in every register that shares the numbering.
 */
export interface TaskNumbering {
  /** Runs `write` while no other register sharing the numbering issues one, with the lowest number it may issue. */
  issue<T>(write: (floor: number) => Promise<T>): Promise<T>;
}

/** A team on its own: its numbers are its register's, which the register's own lock hands out one at a time. */
export const OWN_NUMBERS: TaskNumbering = { issue: (write) => write(1) };

/** Another register sharing the numbering, read for the number its next task would get. */
export interface NumberSource {
  nextNumber(): Promise<number>;
}

/** A register's next number, read without its lock: reads never need it (store.ts). */
export class LogNumbers implements NumberSource {
  private readonly log: EventLog;

  constructor(log: EventLog) {
    this.log = log;
  }

  async nextNumber(): Promise<number> {
    return taskNumber((await this.log.read()).state.nextId);
  }
}

/**
 * One numbering across a team tree's registers. Every create in the tree runs under the tree's lock, so reading
 * the other registers' next numbers and appending the new task stay one step: two teams adding at once never
 * issue one number.
 */
export class TreeNumbering implements TaskNumbering {
  private readonly mutex: Mutex;
  private readonly others: readonly NumberSource[];

  constructor(mutex: Mutex, others: readonly NumberSource[]) {
    this.mutex = mutex;
    this.others = others;
  }

  issue<T>(write: (floor: number) => Promise<T>): Promise<T> {
    return this.mutex.run(async () => {
      const next = await Promise.all(this.others.map((other) => other.nextNumber()));
      return write(Math.max(1, ...next));
    });
  }
}
