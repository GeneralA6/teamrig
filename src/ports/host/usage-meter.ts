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

/**
 * The host's usage meter: what a call the transcript reader gave cost, in weighted tokens (W), one number whatever
 * mix of input, cache and output the call used. The core adds, splits and compares W; only this port prices a token.
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
}
