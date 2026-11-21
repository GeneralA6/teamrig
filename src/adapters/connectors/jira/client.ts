import { isRecord, isStringArray, recordField, type CredentialStore, type HttpClient, type HttpRequest, type JsonRecord, type SecretScanner } from '../../../plugin-api/index.ts';
import { baseUrl, credentialName } from './site.ts';

/**
 * Jira Cloud's REST API as the tracker calls it: each request signed in with the site's saved credential, each answer
 * read to one of three ends. A reason never holds the address or a header, and what Jira said is outside input: one
 * line of it, with any secret shape redacted.
 */

/** What a request came to: Jira's answer as parsed JSON (undefined when it sent none), no such thing, or why not. */
export type JiraAnswer = { readonly kind: 'ok'; readonly body: unknown } | { readonly kind: 'missing' } | { readonly kind: 'failed'; readonly reason: string };

/** How a site is signed in to: the header every request carries, or why there is none. */
export type JiraSignIn = { readonly kind: 'found'; readonly header: string } | { readonly kind: 'failed'; readonly reason: string };

/** Waits `ms` milliseconds. */
export type Wait = (ms: number) => Promise<void>;

/** How often a request Jira turned away for the rate limit (429) is sent again: its limits clear within seconds. */
export const RATE_LIMIT_RETRIES = 2;

/** The longest one request waits on the rate limit in all, before the run says so instead of hanging. */
export const RATE_LIMIT_MAX_WAIT_MS = 60_000;

/** The wait when Jira names none. */
const RATE_LIMIT_DEFAULT_WAIT_MS = 1_000;

/** The most a wait is stretched by chance, so sessions turned away together do not come back together. */
export const RATE_LIMIT_JITTER_MS = 250;

/** The longest piece of Jira's own words a reason quotes. */
const MAX_ERROR_TEXT = 200;

/** Runs of control characters, line ends among them: a quoted line holds none. */
const CONTROLS = /[\u0000-\u001f\u007f-\u009f]+/g;

/** The saved pair: the account's e-mail, a colon, the API token. An e-mail holds no colon, so the first one parts them. */
const PAIR = /^[^:]+:.+$/;

function failed(reason: string): { readonly kind: 'failed'; readonly reason: string } {
  return { kind: 'failed', reason };
}

/** The wait Jira asks for in its `Retry-After` header, a count of seconds. */
function retryAfterMs(header: string | undefined): number {
  return header !== undefined && /^\d{1,6}$/.test(header.trim()) ? Number(header.trim()) * 1000 : RATE_LIMIT_DEFAULT_WAIT_MS;
}

function parsed(text: string): unknown {
  try {
    const value: unknown = JSON.parse(text);
    return value;
  } catch {
    return undefined;
  }
}

/** The first thing Jira's error body says: a line of `errorMessages`, else a field of `errors` with its message. */
function firstError(body: string): string | undefined {
  const value = parsed(body);
  if (!isRecord(value)) {
    return undefined;
  }
  const messages: unknown = value['errorMessages'];
  const [message] = isStringArray(messages) ? messages : [];
  if (message !== undefined) {
    return message;
  }
  const [field] = Object.entries(recordField(value, 'errors') ?? {});
  return field !== undefined && typeof field[1] === 'string' ? `${field[0]}: ${field[1]}` : undefined;
}

export class JiraClient {
  private readonly http: HttpClient;
  private readonly credentials: CredentialStore;
  private readonly scanner: SecretScanner;
  private readonly wait: Wait;
  private readonly jitter: () => number;
  /** One read of each site's credential a run, shared by every request to it. */
  private readonly signIns = new Map<string, Promise<JiraSignIn>>();

  /** `jitter` gives a number from 0 up to 1, as Math.random does. */
  constructor(http: HttpClient, credentials: CredentialStore, scanner: SecretScanner, wait: Wait, jitter: () => number) {
    this.http = http;
    this.credentials = credentials;
    this.scanner = scanner;
    this.wait = wait;
    this.jitter = jitter;
  }

  /** How `site` is signed in to, from its saved credential. */
  signIn(site: string): Promise<JiraSignIn> {
    const known = this.signIns.get(site);
    if (known !== undefined) {
      return known;
    }
    const read = this.readSignIn(site);
    this.signIns.set(site, read);
    return read;
  }

  get(site: string, path: string): Promise<JiraAnswer> {
    return this.call(site, (headers) => ({ method: 'GET', url: `${baseUrl(site)}${path}`, headers }));
  }

  post(site: string, path: string, body: JsonRecord): Promise<JiraAnswer> {
    return this.call(site, (headers) => ({ method: 'POST', url: `${baseUrl(site)}${path}`, headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) }));
  }

  put(site: string, path: string, body: JsonRecord): Promise<JiraAnswer> {
    return this.call(site, (headers) => ({ method: 'PUT', url: `${baseUrl(site)}${path}`, headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) }));
  }

  /** How the credential of `site` is saved, for a reason that asks for it. */
  private saveLine(site: string): string {
    return `save the account's e-mail, a colon and its API token with ${this.credentials.saveCommand(credentialName(site))}`;
  }

  private async readSignIn(site: string): Promise<JiraSignIn> {
    const name = credentialName(site);
    const read = await this.credentials.read(name);
    switch (read.kind) {
      case 'failed':
        return failed(`credential ${name} could not be read from ${this.credentials.label}: ${read.reason}`);
      case 'missing':
        return failed(`${this.credentials.label} holds no credential ${name}: ${this.saveLine(site)}`);
      case 'found':
        return PAIR.test(read.secret)
          ? { kind: 'found', header: `Basic ${Buffer.from(read.secret, 'utf8').toString('base64')}` }
          : failed(`credential ${name} is not an e-mail, a colon and an API token: ${this.saveLine(site)}`);
    }
  }

  private async call(site: string, requestWith: (headers: Readonly<Record<string, string>>) => HttpRequest): Promise<JiraAnswer> {
    const signIn = await this.signIn(site);
    if (signIn.kind === 'failed') {
      return signIn;
    }
    return await this.send(site, requestWith({ authorization: signIn.header, accept: 'application/json' }), RATE_LIMIT_RETRIES, 0);
  }

  /** Sends `request`, again after the wait Jira asks for while it answers 429 and `retries` are left. Nothing else is sent twice. */
  private async send(site: string, request: HttpRequest, retries: number, waitedMs: number): Promise<JiraAnswer> {
    const result = await this.http.send(request);
    if (result.kind === 'failed') {
      return failed(`Jira gave no answer: ${result.reason}`);
    }
    if (result.status !== 429) {
      return this.answer(site, result.status, result.body);
    }
    const pause = retryAfterMs(result.headers['retry-after']) + Math.round(this.jitter() * RATE_LIMIT_JITTER_MS);
    if (retries === 0 || waitedMs + pause > RATE_LIMIT_MAX_WAIT_MS) {
      return failed(`Jira is limiting requests (429) and asks to wait ${Math.ceil(pause / 1000)} s more: run it again later`);
    }
    await this.wait(pause);
    return await this.send(site, request, retries - 1, waitedMs + pause);
  }

  private answer(site: string, status: number, body: string): JiraAnswer {
    if (status >= 200 && status < 300) {
      if (body.trim() === '') {
        return { kind: 'ok', body: undefined };
      }
      const value = parsed(body);
      return value === undefined ? failed(`Jira answered ${status} with text that is not JSON`) : { kind: 'ok', body: value };
    }
    if (status === 404) {
      return { kind: 'missing' };
    }
    if (status === 401) {
      return failed(`Jira refused the sign-in (401): the API token saved as ${credentialName(site)} may have expired; ${this.saveLine(site)}`);
    }
    if (status >= 300 && status < 400) {
      return failed(`Jira answered ${status}, a redirect, which teamrig does not follow`);
    }
    const said = firstError(body);
    return failed(said === undefined ? `Jira answered ${status}` : `Jira answered ${status}: ${this.line(said)}`);
  }

  /**
   * Jira's words as one plain line: control characters and line ends to spaces, any secret shape redacted, then cut
   * short. Redacted first: a cut through a secret would leave a start too short to match its shape.
   */
  private line(text: string): string {
    const plain = this.scanner.redact(text.replace(CONTROLS, ' ').trim());
    return plain.length > MAX_ERROR_TEXT ? `${plain.slice(0, MAX_ERROR_TEXT)}...` : plain;
  }
}
