import { writableObject } from "../core/jsonl.js";
import { DAY_PROBE_FORMAT, formatDayProbe, gateDayProbe, parseDayProbe, releaseDayProbe } from "./day-probe.js";
/**
 * The day-start probe's file (src/restore/day-probe.ts). Every reply of every tab and every due tab's wake check reads
 * it, so a read takes no lock; only a claim or a release takes it, then decides again on the locked read and writes,
 * since a dozen tabs come due for a moment in the same second and one of them claims. A probe a newer teamrig wrote
 * reads as none, and a write to it is refused (`NewerDataError`), never overwritten.
 */
export class DayProbeStore {
    files;
    path;
    lock;
    constructor(files, path, lock) {
        this.files = files;
        this.path = path;
        this.lock = lock;
    }
    /** The probe; undefined when there is none, or a damaged one. */
    async read() {
        const text = await this.files.read(this.path);
        return text === undefined ? undefined : parseDayProbe(text);
    }
    /** The gate for `tab`, due for `moment` at `now` (`gateDayProbe`), writing the probe when it claims. */
    async claim(moment, tab, now) {
        const unlocked = gateDayProbe(await this.read(), moment, tab, now);
        if (unlocked.kind !== 'claim') {
            return unlocked;
        }
        return this.lock.run(async () => {
            const gate = gateDayProbe(await this.readWritable(), moment, tab, now);
            if (gate.kind === 'claim') {
                await this.files.write(this.path, formatDayProbe(gate.probe));
            }
            return gate;
        });
    }
    /** Releases the probe at `reply` (`releaseDayProbe`); the probe as released, or undefined when the reply changed nothing. */
    async release(reply) {
        if (releaseDayProbe(await this.read(), reply) === undefined) {
            return undefined;
        }
        return this.lock.run(async () => {
            const released = releaseDayProbe(await this.readWritable(), reply);
            if (released !== undefined) {
                await this.files.write(this.path, formatDayProbe(released));
            }
            return released;
        });
    }
    /** The probe as a locked write reads it: one in a newer format throws `NewerDataError`, so it is never overwritten. */
    async readWritable() {
        const text = await this.files.read(this.path);
        writableObject(this.path, text, DAY_PROBE_FORMAT);
        return text === undefined ? undefined : parseDayProbe(text);
    }
}
