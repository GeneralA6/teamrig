import { isRecord, stringField } from './guards.ts';

/**
 * A chat webhook teamrig posts one line of text to: `teamrig exec` each approval, refusal and run (exec spec §10).
 */
export interface ChatWebhook {
  /** Posts `content` to `url`; undefined once it is posted, else why not, in words that never hold the URL. */
  post(url: string, content: string): Promise<string | undefined>;
}

/** The longest message the chat accepts; a longer one is cut to fit, with an ellipsis. */
export const WEBHOOK_MAX_CONTENT = 2_000;

/** How long a post may take: a slow chat must not hold the command that already logged its event. */
export const WEBHOOK_TIMEOUT_MS = 5_000;

function fitted(content: string): string {
  return content.length <= WEBHOOK_MAX_CONTENT ? content : `${content.slice(0, WEBHOOK_MAX_CONTENT - 1)}…`;
}

/**
 * Why a post failed, from the error's name and its cause's code (`ECONNREFUSED`) alone: fetch's own messages can
 * quote the URL, which is the secret.
 */
function failureOf(error: unknown, timeoutMs: number): string {
  if (error instanceof Error && error.name === 'TimeoutError') {
    return `the webhook did not answer within ${timeoutMs} ms`;
  }
  const code = error instanceof Error && isRecord(error.cause) ? stringField(error.cause, 'code') : undefined;
  return `the webhook could not be reached${code === undefined ? '' : ` (${code})`}`;
}

/**
 * A chat webhook over HTTP: a JSON POST of `content`, with every mention turned off so a note that names
 * `@everyone` or a role pings no one.
 */
export function httpWebhook(timeoutMs: number = WEBHOOK_TIMEOUT_MS): ChatWebhook {
  return {
    async post(url, content) {
      if (!URL.canParse(url)) {
        return 'the webhook address is not a URL';
      }
      try {
        const response = await fetch(url, {
          method: 'POST',
          signal: AbortSignal.timeout(timeoutMs),
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ content: fitted(content), allowed_mentions: { parse: [] } }),
        });
        return response.ok ? undefined : `the webhook answered HTTP ${response.status}`;
      } catch (error) {
        return failureOf(error, timeoutMs);
      }
    },
  };
}
