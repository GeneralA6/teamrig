import { writableObject } from "../core/jsonl.js";
import { DAY_SCHEDULE_FORMAT, formatDaySchedule, parseDaySchedule, withDayStarts } from "./schedule.js";
/**
 * The fleet's day schedule file (src/wake/schedule.ts), in the root team's state. Every wake check of every tab in
 * the tree reads it, so a read takes no lock; only the lead's write takes it. A schedule a newer teamrig wrote reads
 * as none (each team's `wake.dayStartUtc` then holds), and a write to it is refused (`NewerDataError`), never
 * overwritten.
 */
export class DayScheduleStore {
    files;
    path;
    lock;
    constructor(files, path, lock) {
        this.files = files;
        this.path = path;
        this.lock = lock;
    }
    /** The schedule; undefined when there is none, or one it cannot read. */
    async read() {
        const text = await this.files.read(this.path);
        return text === undefined ? undefined : parseDaySchedule(text);
    }
    /** Writes `starts` on `day` over what that day held (`withDayStarts`); the schedule as written. */
    async write(day, starts) {
        return this.lock.run(async () => {
            const text = await this.files.read(this.path);
            writableObject(this.path, text, DAY_SCHEDULE_FORMAT);
            const written = withDayStarts(text === undefined ? undefined : parseDaySchedule(text), day, starts);
            await this.files.write(this.path, formatDaySchedule(written));
            return written;
        });
    }
}
