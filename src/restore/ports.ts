import type { Countdown } from './countdown.ts';
import type { ShutdownLog } from './shutdowns.ts';

/** What the restore after a reboot asks of the system and the person, beyond files and processes. */
export interface RestorePorts {
  readonly shutdowns: ShutdownLog;
  readonly countdown: Countdown;
}
