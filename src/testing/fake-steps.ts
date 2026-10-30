import type { StepEnd, StepRequest, StepRunner } from '../delivery/steps.ts';

/** A clock a fake run moves forward, such as the harness's `FakeClock`. */
interface Advancing {
  advance(ms: number): void;
}

/**
 * A step runner that runs nothing: each request is recorded, `during` (default nothing) is called while the step
 * "runs", as a test that looks at the host lock mid-step, and every run ends as set (default exit 0), moving
 * `clock` on by the time it was set to take. A run whose `stop` has aborted once `during` returns ends `stopped`, as
 * the real runner kills it.
 */
export class FakeSteps implements StepRunner {
  readonly ran: StepRequest[] = [];
  private end: StepEnd = { kind: 'exited', code: 0 };
  private takesMs = 0;
  private failure: Error | undefined;
  private during: (request: StepRequest) => Promise<void> = async () => undefined;

  private readonly clock: Advancing | null;

  constructor(clock: Advancing | null = null) {
    this.clock = clock;
  }

  /** From now on, every run ends with `end` (an exit code, a signal or a timeout) and takes `takesMs`. */
  ends(end: StepEnd | number, takesMs = 0): this {
    this.end = typeof end === 'number' ? { kind: 'exited', code: end } : end;
    this.takesMs = takesMs;
    return this;
  }

  /** From now on, every run fails to start with `error`, as a missing folder does. */
  failsWith(error: Error): this {
    this.failure = error;
    return this;
  }

  /** Calls `look` while each step runs. */
  whileRunning(look: (request: StepRequest) => Promise<void>): this {
    this.during = look;
    return this;
  }

  async run(request: StepRequest): Promise<StepEnd> {
    this.ran.push(request);
    if (this.failure !== undefined) {
      throw this.failure;
    }
    await this.during(request);
    if (request.stop?.aborted === true) {
      return { kind: 'stopped' };
    }
    this.clock?.advance(this.takesMs);
    return this.end;
  }
}
