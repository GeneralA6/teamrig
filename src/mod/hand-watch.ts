/**
 * A watch over the mod's hands (`hooks/register.ts`), so a hand that stops answering leaves a line in teamrig's own
 * logs (#920). Each `$.clock.every` tick runs through `HandWatch.run`: a tick that throws or rejects is traced and
 * resolves undefined, so the clock goes on; and, with no timer of its own, each run first looks whether an earlier
 * tick of the same hand is still unsettled, and traces it once it has stayed so past STALL_MS from the first run that
 * found it unsettled (one tick after it started). The clock is read only then, or for a throw, so a hand whose ticks
 * settle in time costs no clock call (the clear hand ticks every second). The same hand and kind are traced at most
 * once per TRACE_EVERY_MS, so a hand stuck for hours writes a few lines, not one per tick.
 *
 * The mod runs inside Claude Code without Node, so this file imports nothing: it compiles to a module the mod
 * imports as it is.
 */

/** How long a tick may stay unsettled, by default, before the hand's next run traces it as stalled; most hands' CLI runs stop by 30 s. */
export const STALL_MS = 60_000;
/** The least time between two traces of the same hand and kind. */
export const TRACE_EVERY_MS = 10 * 60_000;
/** The most of an error's text a trace carries. */
export const TRACE_ERROR_CHARS = 300;

/** What a watch saw: a tick that threw, or one still unsettled `ms` after a run first found it so. */
export type HandTrace =
  | { readonly kind: 'threw'; readonly hand: string; readonly error: string }
  | { readonly kind: 'stalled'; readonly hand: string; readonly ms: number };

export interface HandWatchHost {
  /** The time on the clock the hands tick on (Claude Code's `$.clock.now()`). */
  now(): number | Promise<number>;
  /** Records a trace; a throw here is ignored, so a broken sink never stops a hand. */
  trace(trace: HandTrace): void;
}

function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.slice(0, TRACE_ERROR_CHARS);
}

export class HandWatch {
  /** Each hand's ticks not settled yet: how long each may take, and when a run first found it unsettled. */
  private readonly pending = new Map<string, Set<{ readonly limitMs: number; seenAt?: number }>>();
  /** When each hand and kind was last traced. */
  private readonly traced = new Map<string, number>();

  private readonly host: HandWatchHost;

  constructor(host: HandWatchHost) {
    this.host = host;
  }

  /**
   * Runs one tick of `hand`; its result, or undefined when it threw or rejected. `limitMs` is how long the tick may
   * take before a later run calls it stalled: past its longest CLI run's timeout, for a hand whose run may be long.
   */
  async run<T>(hand: string, tick: () => Promise<T>, limitMs: number = STALL_MS): Promise<T | undefined> {
    const ticks = this.pending.get(hand) ?? new Set<{ readonly limitMs: number; seenAt?: number }>();
    this.pending.set(hand, ticks);
    if (ticks.size > 0) {
      const at = await this.host.now();
      const late: number[] = [];
      for (const one of ticks) {
        one.seenAt ??= at;
        if (at - one.seenAt >= one.limitMs) {
          late.push(at - one.seenAt);
        }
      }
      if (late.length > 0) {
        this.emit({ kind: 'stalled', hand, ms: Math.max(...late) }, at);
      }
    }
    const token: { readonly limitMs: number; seenAt?: number } = { limitMs };
    ticks.add(token);
    let running: Promise<T>;
    try {
      running = tick();
    } catch (error) {
      running = Promise.reject(error);
    }
    try {
      return await running;
    } catch (error) {
      this.emit({ kind: 'threw', hand, error: errorText(error) }, await this.host.now());
      return undefined;
    } finally {
      ticks.delete(token);
    }
  }

  private emit(trace: HandTrace, at: number): void {
    const key = `${trace.hand} ${trace.kind}`;
    const last = this.traced.get(key);
    if (last !== undefined && at - last < TRACE_EVERY_MS) {
      return;
    }
    this.traced.set(key, at);
    try {
      this.host.trace(trace);
    } catch {
      // A sink that fails must never stop the hand it watches.
    }
  }
}
