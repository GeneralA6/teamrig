import type { Countdown, RestoreChoice } from '../restore/countdown.ts';
import { RESTORE_RUN_VALUE, WINDOWS_RUN_KEY, type LogonEntry } from '../restore/logon.ts';
import type { RestorePorts } from '../restore/ports.ts';
import type { ShutdownLog, ShutdownWindow } from '../restore/shutdowns.ts';
import type { StopSignal, StopWatch } from '../restore/stops.ts';

/** A logon entry held in memory: `command` is what it runs now; with `failWith` set, each write and remove throws it. */
export class FakeLogonEntry implements LogonEntry {
  readonly where = `${WINDOWS_RUN_KEY} ${RESTORE_RUN_VALUE}`;
  command: string | undefined;
  failWith: string | undefined;

  constructor(command?: string) {
    this.command = command;
  }

  commandFor(node: string, script: string): string {
    return `"C:\\Windows\\System32\\conhost.exe" --headless "${node}" "${script}"`;
  }

  async read(): Promise<string | undefined> {
    return this.command;
  }

  async write(command: string): Promise<void> {
    this.failIfAsked();
    this.command = command;
  }

  async remove(): Promise<void> {
    this.failIfAsked();
    this.command = undefined;
  }

  private failIfAsked(): void {
    if (this.failWith !== undefined) {
      throw new Error(this.failWith);
    }
  }
}

/** A shutdown log that reports the shutdown it is given; none by default. */
export class FakeShutdownLog implements ShutdownLog {
  shutdown: ShutdownWindow | undefined;

  constructor(shutdown?: ShutdownWindow) {
    this.shutdown = shutdown;
  }

  async lastShutdown(): Promise<ShutdownWindow | undefined> {
    return this.shutdown;
  }
}

/** A countdown the person answers with `choice` at once; it records each length it was asked to count. */
export class FakeCountdown implements Countdown {
  readonly counted: number[] = [];
  choice: RestoreChoice;

  constructor(choice: RestoreChoice = 'go') {
    this.choice = choice;
  }

  async choose(seconds: number): Promise<RestoreChoice> {
    this.counted.push(seconds);
    return this.choice;
  }
}

/** A stop watch the test stops by hand: `stop` runs each watcher still watching, as a closed tab would, and ends nothing. */
export class FakeStopWatch implements StopWatch {
  private readonly watchers = new Set<(signal: StopSignal) => Promise<void>>();

  /** How many watchers are still watching. */
  get watching(): number {
    return this.watchers.size;
  }

  watch(onStop: (signal: StopSignal) => Promise<void>): () => void {
    this.watchers.add(onStop);
    return () => {
      this.watchers.delete(onStop);
    };
  }

  async stop(signal: StopSignal): Promise<void> {
    for (const watcher of [...this.watchers]) {
      await watcher(signal);
    }
  }
}

/** No clean shutdown on record, a countdown that goes at once, no stop, and no logon entry, as off Windows. */
export function quietRestore(): RestorePorts {
  return { shutdowns: new FakeShutdownLog(), countdown: new FakeCountdown(), stops: new FakeStopWatch(), logon: undefined };
}
