import type { Files } from '../core/files.ts';
import type { Mutex } from '../core/lock.ts';
import { writableObject } from '../core/jsonl.ts';
import { DAY_SCHEDULE_FORMAT, formatDaySchedule, parseDaySchedule, withDayStarts, type DaySchedule, type ScheduledStart } from './schedule.ts';

/**
 * The fleet's day schedule file (src/wake/schedule.ts), in the root team's state. Every wake check of every tab in
 * the tree reads it, so a read takes no lock; only the lead's write takes it. A schedule a newer teamrig wrote reads
 * as none (each team's `wake.dayStartUtc` then holds), and a write to it is refused (`NewerDataError`), never
 * overwritten.
 */
export class DayScheduleStore {
  private readonly files: Files;
  private readonly path: string;
  private readonly lock: Mutex;

  constructor(files: Files, path: string, lock: Mutex) {
    this.files = files;
    this.path = path;
    this.lock = lock;
  }

  /** The schedule; undefined when there is none, or one it cannot read. */
  async read(): Promise<DaySchedule | undefined> {
    const text = await this.files.read(this.path);
    return text === undefined ? undefined : parseDaySchedule(text);
  }

  /** Writes `starts` on `day` over what that day held (`withDayStarts`); the schedule as written. */
  async write(day: string, starts: ReadonlyMap<string, ScheduledStart>): Promise<DaySchedule> {
    return this.lock.run(async () => {
      const text = await this.files.read(this.path);
      writableObject(this.path, text, DAY_SCHEDULE_FORMAT);
      const written = withDayStarts(text === undefined ? undefined : parseDaySchedule(text), day, starts);
      await this.files.write(this.path, formatDaySchedule(written));
      return written;
    });
  }
}
