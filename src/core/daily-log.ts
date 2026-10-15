import type { Files } from './files.ts';
import { stringField, type JsonRecord } from './guards.ts';
import { parseJsonl, toJsonlLine } from './jsonl.ts';
import { formatUtcDay } from './time.ts';

export const DAILY_LOG_VERSION = 1;

/** The notices given on a UTC day, so each is given once per key and day. */
export interface DailyLog {
  /** True when `key` was recorded on the UTC day of `now`. */
  seen(key: string, now: Date): Promise<boolean>;
  /** Records `key` on the UTC day of `now`, leaving out the lines of other days, so the file stays one day long. */
  record(key: string, now: Date): Promise<void>;
}

/** One `{"v":1,"day":"2030-01-08","key":"…"}` line per notice given today; a line of any version counts. */
export class JsonlDailyLog implements DailyLog {
  private readonly files: Files;
  private readonly path: string;

  constructor(files: Files, path: string) {
    this.files = files;
    this.path = path;
  }

  async seen(key: string, now: Date): Promise<boolean> {
    return (await this.today(now)).some((record) => stringField(record, 'key') === key);
  }

  async record(key: string, now: Date): Promise<void> {
    const kept = (await this.today(now)).map(toJsonlLine);
    await this.files.write(this.path, [...kept, toJsonlLine({ v: DAILY_LOG_VERSION, day: formatUtcDay(now), key })].join(''));
  }

  private async today(now: Date): Promise<JsonRecord[]> {
    const day = formatUtcDay(now);
    const { records } = parseJsonl((await this.files.read(this.path)) ?? '');
    return records.map((line) => line.record).filter((record) => stringField(record, 'day') === day);
  }
}
