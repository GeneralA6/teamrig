import type { KitConfig } from '../../config/types.ts';
import { errorMessage } from '../../core/guards.ts';
import { hourSent, minuteOf, parsePushHour, pushHourText, shiftWrites } from '../../issues/push-hour.ts';
import { autoPushWrites, hourPushWrites, PUSH_WRITES_PER_HOUR, PUSH_WRITES_PER_RUN } from '../../issues/status-push.ts';
import { fileLockOf } from '../file-locks.ts';
import type { Kit } from '../kit.ts';
import type { CliRuntime } from '../runtime.ts';

/**
 * The hour's count around one automatic push (T4592, issues/push-hour.ts). Before the push, under the sync's lock,
 * the writes the hour has left set the run's limit, and that limit is reserved in the run's minute at once, so a
 * second run reads it as spent and a run that stops half way leaves the hour counted high, never low. After the
 * push the reservation is settled to the writes the run counted. A count that cannot be read is replaced by the
 * reservation, which heals the file; one that cannot be written gives the run the even share of the hour
 * (autoPushWrites), never more. Each hold of the lock is short and on its own, as the claims' and clocks' are.
 */

/** The run's write limit, the lines saying why it is below the run limit, and the writes reserved for it. */
export interface HourLimit {
  readonly writesPerRun: number;
  readonly lines: readonly string[];
  /** Unset when nothing was reserved, as when the count could not be written: then nothing is settled either. */
  readonly reserved: { readonly minute: number; readonly writes: number } | undefined;
}

/** Reads the hour's count, sets the run's limit from it and reserves that limit in the count. */
export async function reserveHour(runtime: CliRuntime, kit: Kit, config: KitConfig): Promise<HourLimit> {
  const probeSeconds = config.github.probeSeconds;
  const share = autoPushWrites(probeSeconds);
  try {
    return await fileLockOf(runtime, kit.paths.githubSyncLock, config.lock).run(async (): Promise<HourLimit> => {
      const read = parsePushHour(await runtime.files.read(kit.paths.githubPushHour));
      const now = runtime.clock.now();
      const minute = minuteOf(now);
      const limit = read.kind === 'read' ? readLimit(probeSeconds, hourSent(read.hour, now)) : { writesPerRun: share, lines: [`NOTE status push: the hour's write count could not be read (${read.reason}), so this run sends at most the even share of ${share}; its own writes start a new count`] };
      await runtime.files.write(kit.paths.githubPushHour, pushHourText(shiftWrites(read.kind === 'read' ? read.hour : [], now, minute, limit.writesPerRun)));
      return { ...limit, reserved: { minute, writes: limit.writesPerRun } };
    });
  } catch (error) {
    return { writesPerRun: share, lines: [`NOTE status push: the hour's write count could not be kept (${errorMessage(error)}), so this run sends at most the even share of ${share}`], reserved: undefined };
  }
}

function readLimit(probeSeconds: number, sent: number): Pick<HourLimit, 'writesPerRun' | 'lines'> {
  const writesPerRun = hourPushWrites(probeSeconds, sent);
  const limited = probeSeconds > 0 && writesPerRun < PUSH_WRITES_PER_RUN;
  return { writesPerRun, lines: limited ? [`NOTE status push: ${sent} write(s) went out in the last hour, of ${PUSH_WRITES_PER_HOUR}, so this run sends at most ${writesPerRun}`] : [] };
}

/** Settles the run's reservation to the `writes` it counted; a failure leaves the hour counted at the reservation. */
export async function settleHour(runtime: CliRuntime, kit: Kit, config: KitConfig, limit: HourLimit, writes: number): Promise<readonly string[]> {
  const reserved = limit.reserved;
  if (reserved === undefined || writes === reserved.writes) {
    return [];
  }
  try {
    await fileLockOf(runtime, kit.paths.githubSyncLock, config.lock).run(async () => {
      const read = parsePushHour(await runtime.files.read(kit.paths.githubPushHour));
      const now = runtime.clock.now();
      // A count damaged since the reservation is replaced by this run's writes alone.
      const hour = read.kind === 'read' ? shiftWrites(read.hour, now, reserved.minute, writes - reserved.writes) : shiftWrites([], now, reserved.minute, writes);
      await runtime.files.write(kit.paths.githubPushHour, pushHourText(hour));
    });
    return [];
  } catch (error) {
    return [`NOTE status push: the hour's write count was not settled (${errorMessage(error)}), so it counts this run at its limit of ${reserved.writes} until that minute is an hour old`];
  }
}
