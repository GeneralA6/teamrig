import type { HookEnd, HookRequest, HookRunner } from '../deploy/hooks.ts';

/** A clock a fake run moves forward, such as the harness's `FakeClock`. */
interface Advancing {
  advance(ms: number): void;
}

/** How one fake hook run goes: the lines it prints, how it ends (default exit 0), how long it takes, and what it does meanwhile. */
export interface HookScript {
  readonly lines?: readonly string[];
  readonly end?: HookEnd | number;
  readonly takesMs?: number;
  readonly during?: (request: HookRequest) => Promise<void>;
}

/**
 * A hook runner that runs nothing: each request is recorded, and each program answers by its scripts in turn, the
 * last one from then on; a program with no script prints nothing and exits 0. A run whose `stop` has aborted once its
 * `during` returns ends `stopped`, as the real runner kills it then.
 */
export class FakeHooks implements HookRunner {
  readonly ran: HookRequest[] = [];
  private readonly scripts = new Map<string, HookScript[]>();
  private readonly asked = new Map<string, number>();
  private readonly clock: Advancing | null;

  constructor(clock: Advancing | null = null) {
    this.clock = clock;
  }

  /** Sets how the runs of `argv` go, in turn. */
  answer(argv: readonly string[], ...scripts: HookScript[]): this {
    this.scripts.set(keyOf(argv), scripts);
    this.asked.set(keyOf(argv), 0);
    return this;
  }

  /** The programs run, each as its words joined by spaces, in order. */
  get commands(): string[] {
    return this.ran.map((request) => keyOf(request.argv));
  }

  async run(request: HookRequest): Promise<HookEnd> {
    this.ran.push(request);
    const key = keyOf(request.argv);
    const scripts = this.scripts.get(key) ?? [];
    const asked = this.asked.get(key) ?? 0;
    this.asked.set(key, asked + 1);
    const script = scripts[Math.min(asked, scripts.length - 1)] ?? {};
    await script.during?.(request);
    for (const line of script.lines ?? []) {
      request.onLine(line);
    }
    this.clock?.advance(script.takesMs ?? 0);
    if (request.stop?.aborted === true) {
      return { kind: 'stopped' };
    }
    const end = script.end ?? 0;
    return typeof end === 'number' ? { kind: 'exited', code: end } : end;
  }
}

function keyOf(argv: readonly string[]): string {
  return argv.join(' ');
}
