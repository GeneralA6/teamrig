import type { Countdown, RestoreChoice } from '../restore/countdown.ts';
import type { RestorePorts } from '../restore/ports.ts';
import type { ShutdownLog } from '../restore/shutdowns.ts';

/** A shutdown log that reports the start it is given; none by default. */
export class FakeShutdownLog implements ShutdownLog {
  start: number | undefined;

  constructor(start?: number) {
    this.start = start;
  }

  async lastShutdownStart(): Promise<number | undefined> {
    return this.start;
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

/** No clean shutdown on record, and a countdown that goes at once. */
export function quietRestore(): RestorePorts {
  return { shutdowns: new FakeShutdownLog(), countdown: new FakeCountdown() };
}
