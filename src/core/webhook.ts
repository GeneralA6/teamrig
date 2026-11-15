import { isRecord, stringField } from './guards.ts';

/**
 * A chat webhook teamrig posts one line of text to: `teamrig exec` each approval, refusal and run (exec spec §10), and
 * `hook restore-track` the owner's page when the Claude login expires (src/cli/login-page.ts).
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

/** True for an absolute https URL, the only kind a teamrig post goes to, so its text never crosses a network in the clear. */
export function isHttpsUrl(text: string): boolean {
  return URL.canParse(text) && new URL(text).protocol === 'https:';
}

/**
 * `webhook`, posting only to an https URL: anything else (http, a file or data URL, a bare name) is refused before
 * any request, in words that never hold the URL.
 */
export function httpsOnly(webhook: ChatWebhook): ChatWebhook {
  return {
    post: async (url, content) => (isHttpsUrl(url) ? await webhook.post(url, content) : 'the webhook address is not an https URL'),
  };
}

/** The webhook every teamrig post goes through (`teamrig exec`'s announce, the owner's page): HTTP, to https URLs only. */
export function chatWebhook(timeoutMs: number = WEBHOOK_TIMEOUT_MS): ChatWebhook {
  return httpsOnly(httpWebhook(timeoutMs));
}

/**
 * A chat webhook over HTTP: a JSON POST of `content`, with every mention turned off so a note that names
 * `@everyone` or a role pings no one, and following no redirect. It sends to any URL it is given; teamrig posts
 * through `chatWebhook`, which keeps it to https.
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
          // A redirect would carry the post to an address the config never named, http included: it fails instead.
          redirect: 'error',
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
