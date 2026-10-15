import type { ShellEnd, ShellRequest, ShellResult, ShellRunner } from '../test-run/shell.ts';

/** A clock a fake run moves forward, such as the harness's `FakeClock`. */
interface Advancing {
  advance(ms: number): void;
}

/**
 * A shell that runs nothing: each request is recorded, and every run prints what was set (default
 * nothing) and ends as set (default exit 0), moving `clock` on by the time it was set to take.
 */
export class FakeShell implements ShellRunner {
  readonly ran: ShellRequest[] = [];
  private result: ShellResult = { end: { kind: 'exited', code: 0 }, output: '' };
  private takesMs = 0;
  private failure: Error | undefined;

  private readonly clock: Advancing | null;

  constructor(clock: Advancing | null = null) {
    this.clock = clock;
  }

  /** From now on, every run prints `output`, ends with `end` (an exit code or a signal) and takes `takesMs`. */
  prints(output: string, end: ShellEnd | number = 0, takesMs = 0): this {
    this.result = { end: typeof end === 'number' ? { kind: 'exited', code: end } : end, output };
    this.takesMs = takesMs;
    return this;
  }

  /** From now on, every run fails to start with `error`, as a missing folder does. */
  failsWith(error: Error): this {
    this.failure = error;
    return this;
  }

  async run(request: ShellRequest): Promise<ShellResult> {
    this.ran.push(request);
    if (this.failure !== undefined) {
      throw this.failure;
    }
    this.clock?.advance(this.takesMs);
    return this.result;
  }
}
