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

/** Where a request goes and what it carries beside its body. Both may hold a secret: nothing prints them. */
interface HttpTarget {
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
}

/** One request to an outside tool's API. A GET has no body field: fetch refuses one, so the type does first. */
export type HttpRequest = (HttpTarget & { readonly method: 'GET' }) | (HttpTarget & { readonly method: 'POST' | 'PUT' | 'DELETE'; readonly body?: string });

/** The methods a connector calls an outside tool's API with. */
export type HttpMethod = HttpRequest['method'];

/**
 * What a request came to: the server's answer, whatever its status (a 404 and a 3xx are answers), or why there was
 * none, in words that never hold the URL or a header.
 */
export type HttpResult =
  | { readonly kind: 'answered'; readonly status: number; /** By lower-case name. */ readonly headers: Readonly<Record<string, string>>; readonly body: string }
  | { readonly kind: 'failed'; readonly reason: string };

/** How a connector reaches its tool's API. It never throws: a request that cannot be made is a `failed` result. */
export interface HttpClient {
  send(request: HttpRequest): Promise<HttpResult>;
}

/** How long a request and its answer may take, the body included: a tracker's slowest search answers well within it. */
export const HTTP_TIMEOUT_MS = 30_000;

/** The longest answer read, in bytes once decompressed: a page of issues is under 1 MiB, and a longer one is given up, not held in memory. */
export const HTTP_MAX_BODY_BYTES = 16 * 1024 * 1024;

function failed(reason: string): HttpResult {
  return { kind: 'failed', reason };
}

/** The answer's text, read chunk by chunk; undefined once it passes `maxBytes`, the rest left unread. */
async function textOf(response: Response, maxBytes: number): Promise<string | undefined> {
  if (response.body === null) {
    return '';
  }
  let text = '';
  let bytes = 0;
  // Leaving the loop early cancels the stream, so the rest of a too-long answer is never downloaded.
  for await (const chunk of response.body.pipeThrough(new TextDecoderStream())) {
    bytes += Buffer.byteLength(chunk, 'utf8');
    if (bytes > maxBytes) {
      return undefined;
    }
    text += chunk;
  }
  return text;
}

/**
 * An HTTP client over fetch. It sends to any URL it is given; teamrig's connectors go through `nodeHttpClient`,
 * which keeps it to https.
 */
export function fetchHttpClient(timeoutMs: number = HTTP_TIMEOUT_MS, maxBodyBytes: number = HTTP_MAX_BODY_BYTES): HttpClient {
  return {
    async send(request) {
      if (!URL.canParse(request.url)) {
        return failed('the address is not a URL');
      }
      try {
        const response = await fetch(request.url, {
          method: request.method,
          // A redirect is handed back as the answer it is, never followed: following it would carry the request's
          // sign-in header to an address the connector never named.
          redirect: 'manual',
          signal: AbortSignal.timeout(timeoutMs),
          ...(request.headers === undefined ? {} : { headers: request.headers }),
          ...(request.method === 'GET' || request.body === undefined ? {} : { body: request.body }),
        });
        const body = await textOf(response, maxBodyBytes);
        return body === undefined
          ? failed(`the server's answer was longer than ${maxBodyBytes} bytes`)
          : { kind: 'answered', status: response.status, headers: Object.fromEntries(response.headers.entries()), body };
      } catch (error) {
        // Never the error's own words: they can quote the URL.
        return failed(fetchFailure('the server', error, timeoutMs));
      }
    },
  };
}

/**
 * `client`, sending only to an https URL: anything else (http, a file or data URL, a bare name) is refused before
 * any request, so a sign-in header never crosses a network in the clear.
 */
export function httpsOnlyClient(client: HttpClient): HttpClient {
  return {
    send: async (request) => (isHttpsUrl(request.url) ? await client.send(request) : failed('the address is not an https URL')),
  };
}

/** The client every connector's request goes through: fetch, to https URLs only. */
export function nodeHttpClient(timeoutMs: number = HTTP_TIMEOUT_MS, maxBodyBytes: number = HTTP_MAX_BODY_BYTES): HttpClient {
  return httpsOnlyClient(fetchHttpClient(timeoutMs, maxBodyBytes));
}
