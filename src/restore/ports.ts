import type { Countdown } from './countdown.ts';
import type { LogonEntry } from './logon.ts';
import type { ShortcutPlace } from './shortcut.ts';
import type { ShutdownLog } from './shutdowns.ts';
import type { StopWatch } from './stops.ts';

/** What the restore after a reboot asks of the system and the person, beyond files and processes. */
export interface RestorePorts {
  readonly shutdowns: ShutdownLog;
  readonly countdown: Countdown;
  /** A stop of the run from outside, such as its tab closing, which the run logs before it ends. */
  readonly stops: StopWatch;
  /** The entry that runs the restore's check at logon; undefined on a system teamrig cannot set one up on yet. */
  readonly logon: LogonEntry | undefined;
  /** The shortcuts a restore by hand starts from; undefined on a system teamrig cannot write them on yet. */
  readonly shortcuts: ShortcutPlace | undefined;
}
