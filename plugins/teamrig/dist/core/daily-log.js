import { stringField } from "./guards.js";
import { parseJsonl, toJsonlLine } from "./jsonl.js";
import { formatUtcDay } from "./time.js";
export const DAILY_LOG_VERSION = 1;
/** One `{"v":1,"day":"2030-01-08","key":"…"}` line per notice given today; a line of any version counts. */
export class JsonlDailyLog {
    files;
    path;
    constructor(files, path) {
        this.files = files;
        this.path = path;
    }
    async seen(key, now) {
        return (await this.today(now)).some((record) => stringField(record, 'key') === key);
    }
    async record(key, now) {
        const kept = (await this.today(now)).map(toJsonlLine);
        await this.files.write(this.path, [...kept, toJsonlLine({ v: DAILY_LOG_VERSION, day: formatUtcDay(now), key })].join(''));
    }
    async today(now) {
        const day = formatUtcDay(now);
        const { records } = parseJsonl((await this.files.read(this.path)) ?? '');
        return records.map((line) => line.record).filter((record) => stringField(record, 'day') === day);
    }
}
