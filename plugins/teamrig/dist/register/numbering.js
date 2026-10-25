import { taskNumber } from "./fold.js";
/** A team on its own: its numbers are its register's, which the register's own lock hands out one at a time. */
export const OWN_NUMBERS = { issue: (write) => write(1) };
/** A register's next number, read without its lock: reads never need it (store.ts). */
export class LogNumbers {
    log;
    constructor(log) {
        this.log = log;
    }
    async nextNumber() {
        return taskNumber((await this.log.read()).state.nextId);
    }
}
/**
 * One numbering across a team tree's registers. Every create in the tree runs under the tree's lock, so reading
 * the other registers' next numbers and appending the new task stay one step: two teams adding at once never
 * issue one number.
 */
export class TreeNumbering {
    mutex;
    others;
    constructor(mutex, others) {
        this.mutex = mutex;
        this.others = others;
    }
    issue(write) {
        return this.mutex.run(async () => {
            const next = await Promise.all(this.others.map((other) => other.nextNumber()));
            return write(Math.max(1, ...next));
        });
    }
}
