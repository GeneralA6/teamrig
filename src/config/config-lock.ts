import type { Files } from '../core/files.ts';
import type { JsonRecord } from '../core/guards.ts';
import type { Clock, Mutex } from '../core/lock.ts';
import { writeConfigWithBackup } from './load.ts';

/** Where a team's config is, and where its old copies are kept. */
export interface ConfigPlace {
  readonly configPath: string;
  readonly backupsDir: string;
}

/** Writes the team's config; `ConfigLock.run` hands one out, and it refuses once that run has let the lock go. */
export interface ConfigWriter {
  /** Replaces the config with `config`, keeping the old file first as `<backupName>.json` (or stamped); the backup's path. */
  write(config: JsonRecord, backupName: string): Promise<string>;
}

/**
 * The team config's one lock. A command that changes the config reads the file and writes it inside `run`, the only
 * place a `ConfigWriter` comes from, so a hire, retire, promote, budget setup, rules change, migration or split never
 * writes over another's change made between its read and its write.
 */
export class ConfigLock {
  private readonly mutex: Mutex;
  private readonly files: Files;
  private readonly clock: Clock;
  private readonly place: ConfigPlace;

  constructor(mutex: Mutex, files: Files, clock: Clock, place: ConfigPlace) {
    this.mutex = mutex;
    this.files = files;
    this.clock = clock;
    this.place = place;
  }

  /** Runs `task` holding the lock, with the writer for the config; the writer refuses once the task is over. */
  run<T>(task: (writer: ConfigWriter) => Promise<T>): Promise<T> {
    return this.mutex.run(async () => {
      let held = true;
      const writer: ConfigWriter = {
        write: async (config, backupName) => {
          if (!held) {
            throw new Error(`${this.place.configPath} was written after its lock was let go`);
          }
          return writeConfigWithBackup(this.files, { ...this.place, backupName }, config, this.clock);
        },
      };
      try {
        return await task(writer);
      } finally {
        held = false;
      }
    });
  }
}
