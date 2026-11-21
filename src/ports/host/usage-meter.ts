import type { CallUsage } from './transcript-reader.ts';

/**
 * What one token of each kind costs against a plain input token, as the host's plan meters a call: a cache write by
 * how long it lasts (one the usage does not split by lifetime has its own price), a cache read, an output token. The
 * numbers are the adapter's: an estimate fitted to the plan's limit where the host publishes none.
 */
export interface TokenWeights {
  readonly input: number;
  readonly cacheWrite5m: number;
  readonly cacheWrite1h: number;
  readonly cacheWriteUnsplit: number;
  readonly cacheRead: number;
  readonly output: number;
}

/** One window of the plan's limit: percent of it used, and when it resets, in epoch milliseconds. */
export interface RateWindow {
  readonly usedPct: number;
  readonly resetsAt: number;
}

/** The plan's own reading of its limits: the five-hour window and the week, each null when the plan has none or told none. */
export interface RateLimits {
  readonly fiveHour: RateWindow | null;
  readonly sevenDay: RateWindow | null;
}

/**
 * The host's usage meter: what a call the transcript reader gave cost, in weighted tokens (W), one number whatever
 * mix of input, cache and output the call used, and what the plan itself says of its limits. The core adds, splits
 * and compares W; only this port prices a token or reads the plan's reading.
 */
export interface UsageMeter {
  /** The price of each kind of token, for a reader that prices one kind alone, such as the output a reply added. */
  readonly weights: TokenWeights;
  /** About how many characters of tool output make one token, to price output the usage does not count by itself. */
  readonly charsPerToken: number;
  /** The call's weighted tokens. */
  ofCall(usage: CallUsage): number;
  /** The context the model read for the call, in tokens: everything it was sent, cached or not. */
  contextReading(usage: CallUsage): number;
  /**
   * The plan's reading of its week, and of its five-hour window where it has one, as the host's status input (the
   * text it hands its status line) tells them. Undefined is an answer: the input told no window, as on a plan with
   * no limit, before a session's first reply, or on a host that tells no reading a program can take.
   */
  weekReading(status: string): RateLimits | undefined;
}
