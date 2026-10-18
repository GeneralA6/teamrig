import type { Countdown } from './countdown.ts';
import type { LogonEntry } from './logon.ts';
import type { ShutdownLog } from './shutdowns.ts';

/** What the restore after a reboot asks of the system and the person, beyond files and processes. */
export interface RestorePorts {
  readonly shutdowns: ShutdownLog;
  readonly countdown: Countdown;
  /** The entry that runs the restore's check at logon; undefined on a system teamrig cannot set one up on yet. */
  readonly logon: LogonEntry | undefined;
}
