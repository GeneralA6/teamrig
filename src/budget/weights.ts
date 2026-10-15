import { isNonNegativeInteger, recordField, type JsonRecord } from '../core/guards.ts';

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

/** The token counts of one API call, as its transcript line reports them. */
export interface Usage {
  readonly input: number;
  /** Cache writes that live 5 minutes. */
  readonly cacheWrite5m: number;
  /** Cache writes that live an hour. */
  readonly cacheWrite1h: number;
  /** Cache writes the usage does not split by lifetime. */
  readonly cacheWriteUnsplit: number;
  readonly cacheRead: number;
  readonly output: number;
}

/** A count that may be missing (0) but, when present, must be a whole number of tokens. */
function countOf(record: JsonRecord, key: string): number | undefined {
  const value = record[key] ?? 0;
  return isNonNegativeInteger(value) ? value : undefined;
}

/**
 * A message's `usage` as counts; undefined when it has none or any count is damaged (negative, a
 * fraction, not a number). A missing count is 0. The cache-write split by lifetime is taken from
 * `cache_creation` when it is there; whatever it leaves out of the total is unsplit.
 */
export function usageOf(message: JsonRecord): Usage | undefined {
  const usage = recordField(message, 'usage');
  if (usage === undefined) {
    return undefined;
  }
  const input = countOf(usage, 'input_tokens');
  const cacheWrite = countOf(usage, 'cache_creation_input_tokens');
  const cacheRead = countOf(usage, 'cache_read_input_tokens');
  const output = countOf(usage, 'output_tokens');
  const split = recordField(usage, 'cache_creation') ?? {};
  const cacheWrite5m = countOf(split, 'ephemeral_5m_input_tokens');
  const cacheWrite1h = countOf(split, 'ephemeral_1h_input_tokens');
  if (
    input === undefined ||
    cacheWrite === undefined ||
    cacheRead === undefined ||
    output === undefined ||
    cacheWrite5m === undefined ||
    cacheWrite1h === undefined
  ) {
    return undefined;
  }
  return {
    input,
    cacheWrite5m,
    cacheWrite1h,
    cacheWriteUnsplit: Math.max(0, cacheWrite - cacheWrite5m - cacheWrite1h),
    cacheRead,
    output,
  };
}

/** The context the model read for the call: its input, cache-write and cache-read tokens. */
export function contextTokens(usage: Usage): number {
  return usage.input + usage.cacheWrite5m + usage.cacheWrite1h + usage.cacheWriteUnsplit + usage.cacheRead;
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
