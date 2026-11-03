import { MS_PER_MINUTE } from '../core/time.ts';
import type { RestoreEntry } from './entry.ts';
import type { RestoreRegistry } from './registry.ts';

/**
 * The retry of a tab whose last turn ended on an API error a later try may not meet: the wake check sends the turn on
 * a few times, spaced out, and the tab's next good turn (or a fresh start) clears the count (src/restore/entry.ts).
 */

/**
 * The errors a retry may cure. Claude Code's `server_error` covers any 5xx answer, "API is at capacity", no answer or
 * a timeout, a network or TLS failure and a token refresh race, which it calls usually transient; `overloaded` is the
 * API's own. A rate limit lasts until its reset, an expired login until a /login (src/restore/login.ts retries those
 * tabs), and the rest (a bad request, billing, a model not found, ...) fail the same way again.
 */
export const TRANSIENT_API_ERRORS: ReadonlySet<string> = new Set(['server_error', 'overloaded']);

/**
 * The wait before each retry, counted from the later of the failure and the last retry. Claude Code already retried
 * the request within the turn, so the first waits a minute and the next ones longer; their count is the limit.
 */
export const API_RETRY_BACKOFF_MS: readonly number[] = [MS_PER_MINUTE, 5 * MS_PER_MINUTE, 15 * MS_PER_MINUTE];

/** The retries sent since the tab's last good turn before it is left for the person. */
export const API_RETRY_LIMIT = API_RETRY_BACKOFF_MS.length;

/**
 * What `decideApiRetry` says of a tab: nothing to retry (`none`), a retry due at `at`, or a retry now: the error and
 * when its turn failed, which retry this is (`n`, from 1), and the entry that records it.
 */
export type ApiRetry =
  | { readonly kind: 'none' }
  | { readonly kind: 'later'; readonly at: number }
  | { readonly kind: 'retry'; readonly code: string; readonly failedAt: number; readonly n: number; readonly entry: RestoreEntry };

const NONE: ApiRetry = { kind: 'none' };

/**
 * Whether a tab's last turn should be sent again: only while its entry still says that turn ended on a transient error
 * (a prompt typed since makes it working, a good turn clears the error, an end closes it), with fewer than
 * `API_RETRY_LIMIT` retries sent and the backoff passed.
 */
export function decideApiRetry(entry: RestoreEntry | undefined, now: number): ApiRetry {
  const apiError = entry?.apiError;
  if (entry === undefined || apiError === undefined || entry.endedAt !== undefined || entry.state !== 'error') {
    return NONE;
  }
  const { code, failedAt, retries, retriedAt } = apiError;
  // Undefined past the limit.
  const wait = API_RETRY_BACKOFF_MS[retries];
  if (code === undefined || !TRANSIENT_API_ERRORS.has(code) || wait === undefined) {
    return NONE;
  }
  const at = Math.max(failedAt, retriedAt ?? failedAt) + wait;
  if (now < at) {
    return { kind: 'later', at };
  }
  const n = retries + 1;
  return { kind: 'retry', code, failedAt, n, entry: { ...entry, apiError: { ...apiError, retries: n, retriedAt: now } } };
}

/**
 * Decides a tab's retry and, for one due now, writes its entry with the retry counted before the prompt goes out, so
 * the next check waits for the next backoff. The hooks write the entry with no lock: the gap between this read and
 * write is a few milliseconds of a tab idle at its prompt, and a hook event landing in it loses only that event's
 * fields until the next one.
 */
export async function claimApiRetry(registry: RestoreRegistry, tab: string, now: number): Promise<ApiRetry> {
  const retry = decideApiRetry(await registry.read(tab), now);
  if (retry.kind === 'retry') {
    await registry.write(retry.entry);
  }
  return retry;
}

/** The transient error a tab's last turn ended on once every retry was spent; undefined while one is left, or for any other error. */
export function apiRetriesSpentOn(entry: RestoreEntry): string | undefined {
  const { state, apiError } = entry;
  const code = apiError?.code;
  if (state !== 'error' || apiError === undefined || code === undefined || !TRANSIENT_API_ERRORS.has(code)) {
    return undefined;
  }
  return apiError.retries >= API_RETRY_LIMIT ? code : undefined;
}

/** The restore log's line for a retry: `tab` names the tab. */
export function apiRetryLine(tab: string, code: string, n: number): string {
  return `api-error: retried ${tab}, its turn ended on ${code}; retry ${n} of ${API_RETRY_LIMIT}`;
}

/** The restore log's line for a tab left for the person: its turn failed again after the last retry. */
export function apiGaveUpLine(tab: string, code: string): string {
  return `api-error: gave up on ${tab}: its turn ended on ${code} after ${API_RETRY_LIMIT} retries`;
}
