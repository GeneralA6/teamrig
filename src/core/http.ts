import { isRecord, stringField } from './guards.ts';

/** True for an absolute https URL, the only kind a teamrig request goes to, so its text never crosses a network in the clear. */
export function isHttpsUrl(text: string): boolean {
  return URL.canParse(text) && new URL(text).protocol === 'https:';
}

/**
 * Why a fetch to `what` ("the webhook") failed, from the error's name and its cause's code (`ECONNREFUSED`) alone:
 * fetch's own messages can quote the URL, which may be the secret.
 */
export function fetchFailure(what: string, error: unknown, timeoutMs: number): string {
  if (error instanceof Error && error.name === 'TimeoutError') {
    return `${what} did not answer within ${timeoutMs} ms`;
  }
  const code = error instanceof Error && isRecord(error.cause) ? stringField(error.cause, 'code') : undefined;
  return `${what} could not be reached${code === undefined ? '' : ` (${code})`}`;
}
