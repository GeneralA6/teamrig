import type { ModelWeight } from '../config/types.ts';
import type { CallUsage } from '../ports/host/index.ts';

/**
 * Weighted tokens (W): one number for what a call cost, whatever mix of input, cache and output it
 * used. The weights price each kind against a plain input token: a cache write lasting 5 minutes
 * 1.25, one lasting an hour 2 (a write the usage does not split by lifetime counts as an hour's), a
 * cache read 0.1, an output token 5. They are an estimate fitted to the account's weekly limit, not
 * published prices.
 */
export const WEIGHTS = {
  input: 1,
  cacheWrite5m: 1.25,
  cacheWrite1h: 2,
  cacheWriteUnsplit: 2,
  cacheRead: 0.1,
  output: 5,
} as const;

/** About how many characters of tool output make one token, to price output the usage does not count by itself. */
export const CHARS_PER_TOKEN = 2.28;

/** The token counts of one API call, as the host's transcript reader reports them. */
export type Usage = CallUsage;

/** The context the model read for the call: its input, cache-write and cache-read tokens. */
export function contextTokens(usage: Usage): number {
  return usage.input + usage.cacheWrite5m + usage.cacheWrite1h + usage.cacheWriteUnsplit + usage.cacheRead;
}

/**
 * What one W of `model` costs against the weekly meter (`budget.modelWeights`): the weight of the longest listed
 * prefix of the model id, else 1. A line naming no model counts 1, since its cost cannot be told apart. The longest
 * prefix wins so a listed `claude-fable-5-1` can price one release apart from a broader `claude-fable`.
 */
export function modelWeightOf(model: string | undefined, weights: readonly ModelWeight[]): number {
  if (model === undefined) {
    return 1;
  }
  let best: ModelWeight | undefined;
  for (const entry of weights) {
    if (model.startsWith(entry.model) && (best === undefined || entry.model.length > best.model.length)) {
      best = entry;
    }
  }
  return best?.weight ?? 1;
}

/** The call's weighted tokens. */
export function weightOf(usage: Usage): number {
  return (
    usage.input * WEIGHTS.input +
    usage.cacheWrite5m * WEIGHTS.cacheWrite5m +
    usage.cacheWrite1h * WEIGHTS.cacheWrite1h +
    usage.cacheWriteUnsplit * WEIGHTS.cacheWriteUnsplit +
    usage.cacheRead * WEIGHTS.cacheRead +
    usage.output * WEIGHTS.output
  );
}
