import type { Files } from '../core/files.ts';
import type { Mutex } from '../core/lock.ts';
import { formatDayProbe, gateDayProbe, parseDayProbe, releaseDayProbe, type DayProbe, type DayProbeGate, type DayProbeReply } from './day-probe.ts';

/**
 * The day-start probe's file (src/restore/day-probe.ts). Every reply of every tab and every due tab's wake check reads
 * it, so a read takes no lock; only a claim or a release takes it, then decides again on the locked read and writes,
 * since a dozen tabs come due for a moment in the same second and one of them claims.
 */
export class DayProbeStore {
  private readonly files: Files;
  private readonly path: string;
  private readonly lock: Mutex;

  constructor(files: Files, path: string, lock: Mutex) {
    this.files = files;
    this.path = path;
    this.lock = lock;
  }

  /** The probe; undefined when there is none, or a damaged one. */
  async read(): Promise<DayProbe | undefined> {
    const text = await this.files.read(this.path);
    return text === undefined ? undefined : parseDayProbe(text);
  }

  /** The gate for `tab`, due for `moment` at `now` (`gateDayProbe`), writing the probe when it claims. */
  async claim(moment: number, tab: string, now: number): Promise<DayProbeGate> {
    const unlocked = gateDayProbe(await this.read(), moment, tab, now);
    if (unlocked.kind !== 'claim') {
      return unlocked;
    }
    return this.lock.run(async () => {
      const gate = gateDayProbe(await this.read(), moment, tab, now);
      if (gate.kind === 'claim') {
        await this.files.write(this.path, formatDayProbe(gate.probe));
      }
      return gate;
    });
  }

  /** Releases the probe at `reply` (`releaseDayProbe`); the probe as released, or undefined when the reply changed nothing. */
  async release(reply: DayProbeReply): Promise<DayProbe | undefined> {
    if (releaseDayProbe(await this.read(), reply) === undefined) {
      return undefined;
    }
    return this.lock.run(async () => {
      const released = releaseDayProbe(await this.read(), reply);
      if (released !== undefined) {
        await this.files.write(this.path, formatDayProbe(released));
      }
      return released;
    });
  }
}
