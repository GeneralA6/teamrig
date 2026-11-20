import { isRecord, type CallUsage, type RateLimits, type RateWindow, type TokenWeights, type UsageMeter } from '../../../plugin-api/index.ts';
import { objectOf } from './json.ts';

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

const MS_PER_SECOND = 1000;

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** A window as Claude Code's status input holds it: `used_percentage`, and `resets_at` in epoch seconds. */
function windowOf(value: unknown): RateWindow | null {
  if (!isRecord(value)) {
    return null;
  }
  const usedPct = finite(value['used_percentage']);
  const resetsAt = finite(value['resets_at']);
  return usedPct === undefined || resetsAt === undefined ? null : { usedPct, resetsAt: resetsAt * MS_PER_SECOND };
}

/**
 * The `rate_limits` of Claude Code's status input, its `five_hour` and `seven_day` windows. Claude Code sends them
 * only to a claude.ai plan's sessions, after the session's first reply; without them, or with neither window whole,
 * there is no reading.
 */
function weekReading(status: string): RateLimits | undefined {
  const limits = objectOf(status)?.['rate_limits'];
  if (!isRecord(limits)) {
    return undefined;
  }
  const fiveHour = windowOf(limits['five_hour']);
  const sevenDay = windowOf(limits['seven_day']);
  return fiveHour === null && sevenDay === null ? undefined : { fiveHour, sevenDay };
}

/** Claude Code's usage meter. */
export const usageMeter: UsageMeter = { weights: WEIGHTS, charsPerToken: CHARS_PER_TOKEN, ofCall, contextReading, weekReading };
