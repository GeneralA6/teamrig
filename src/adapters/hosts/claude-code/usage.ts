import type { CallUsage, TokenWeights, UsageMeter } from '../../../plugin-api/index.ts';

/**
 * What Claude Code's plan charges for each kind of token, against a plain input token: a cache write lasting 5
 * minutes 1.25, one lasting an hour 2 (a write the usage does not split by lifetime counts as an hour's), a cache
 * read 0.1, an output token 5. They are an estimate fitted to the account's weekly limit, not published prices.
 */
export const WEIGHTS: TokenWeights = {
  input: 1,
  cacheWrite5m: 1.25,
  cacheWrite1h: 2,
  cacheWriteUnsplit: 2,
  cacheRead: 0.1,
  output: 5,
};

/** About how many characters of a tool's output Claude Code's models read as one token. */
export const CHARS_PER_TOKEN = 2.28;

function ofCall(usage: CallUsage): number {
  return (
    usage.input * WEIGHTS.input +
    usage.cacheWrite5m * WEIGHTS.cacheWrite5m +
    usage.cacheWrite1h * WEIGHTS.cacheWrite1h +
    usage.cacheWriteUnsplit * WEIGHTS.cacheWriteUnsplit +
    usage.cacheRead * WEIGHTS.cacheRead +
    usage.output * WEIGHTS.output
  );
}

/** The call's input, cache-write and cache-read tokens: Claude Code counts the three apart, and the model read them all. */
function contextReading(usage: CallUsage): number {
  return usage.input + usage.cacheWrite5m + usage.cacheWrite1h + usage.cacheWriteUnsplit + usage.cacheRead;
}

/** Claude Code's usage meter. */
export const usageMeter: UsageMeter = { weights: WEIGHTS, charsPerToken: CHARS_PER_TOKEN, ofCall, contextReading };
