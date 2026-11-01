import type { Countdown, RestoreChoice } from '../restore/countdown.ts';
import { RESTORE_RUN_VALUE, WINDOWS_RUN_KEY, type LogonEntry } from '../restore/logon.ts';
import type { RestorePorts } from '../restore/ports.ts';
import { RESTORE_SHORTCUT_NAME, type FoundShortcut, type Shortcut, type ShortcutPlace, type ShortcutScan } from '../restore/shortcut.ts';
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

/** Where the fake's Start-menu shortcut goes. */
export const FAKE_START_MENU_SHORTCUT = `C:\\Start Menu\\Programs\\${RESTORE_SHORTCUT_NAME}`;

/**
 * The system's restore shortcuts held in memory by path, in the order they were first written; with `failWith` set,
 * each write and remove throws it, and with `scanFailWith` set, each scan throws it.
 */
export class FakeShortcutPlace implements ShortcutPlace {
  readonly shortcuts = new Map<string, Shortcut>();
  readonly startMenu: string;
  failWith: string | undefined;
  scanFailWith: string | undefined;

  constructor(found: readonly FoundShortcut[] = [], startMenu = FAKE_START_MENU_SHORTCUT) {
    this.startMenu = startMenu;
    found.forEach(({ path, ...shortcut }) => this.shortcuts.set(path, shortcut));
  }

  async scan(): Promise<ShortcutScan> {
    if (this.scanFailWith !== undefined) {
      throw new Error(this.scanFailWith);
    }
    return { startMenu: this.startMenu, found: [...this.shortcuts].map(([path, shortcut]) => ({ path, ...shortcut })) };
  }

  async write(path: string, shortcut: Shortcut): Promise<void> {
    this.failIfAsked();
    this.shortcuts.set(path, shortcut);
  }

  async remove(path: string): Promise<void> {
    this.failIfAsked();
    this.shortcuts.delete(path);
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

/**
 * A countdown the person answers with `choice` at once; it records each length it was asked to count, and how many
 * closed tabs each call offered.
 */
export class FakeCountdown implements Countdown {
  readonly counted: number[] = [];
  readonly offered: number[] = [];
  choice: RestoreChoice;

  constructor(choice: RestoreChoice = 'go') {
    this.choice = choice;
  }

  async choose(seconds: number, closed: number): Promise<RestoreChoice> {
    this.counted.push(seconds);
    this.offered.push(closed);
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

/** No clean shutdown on record, a countdown that goes at once, no stop, and no logon entry or shortcuts, as off Windows. */
export function quietRestore(): RestorePorts {
  return { shutdowns: new FakeShutdownLog(), countdown: new FakeCountdown(), stops: new FakeStopWatch(), logon: undefined, shortcuts: undefined };
}
