import { writeConfigWithBackup } from "./load.js";
/**
 * The team config's one lock. A command that changes the config reads the file and writes it inside `run`, the only
 * place a `ConfigWriter` comes from, so a hire, retire, promote, budget setup, rules change, migration or split never
 * writes over another's change made between its read and its write.
 */
export class ConfigLock {
    mutex;
    files;
    clock;
    place;
    constructor(mutex, files, clock, place) {
        this.mutex = mutex;
        this.files = files;
        this.clock = clock;
        this.place = place;
    }
    /** Runs `task` holding the lock, with the writer for the config; the writer refuses once the task is over. */
    run(task) {
        return this.mutex.run(async () => {
            let held = true;
            const writer = {
                write: async (config, backupName) => {
                    if (!held) {
                        throw new Error(`${this.place.configPath} was written after its lock was let go`);
                    }
                    return writeConfigWithBackup(this.files, { ...this.place, backupName }, config, this.clock);
                },
            };
            try {
                return await task(writer);
            }
            finally {
                held = false;
            }
        });
    }
}
