import { isRecord, isStringArray, recordField } from "../../../plugin-api/index.js";
import { baseUrl, credentialName } from "./site.js";
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
function failed(reason) {
    return { kind: 'failed', reason };
}
/** The wait Jira asks for in its `Retry-After` header, a count of seconds. */
function retryAfterMs(header) {
    return header !== undefined && /^\d{1,6}$/.test(header.trim()) ? Number(header.trim()) * 1000 : RATE_LIMIT_DEFAULT_WAIT_MS;
}
function parsed(text) {
    try {
        const value = JSON.parse(text);
        return value;
    }
    catch {
        return undefined;
    }
}
/** The first thing Jira's error body says: a line of `errorMessages`, else a field of `errors` with its message. */
function firstError(body) {
    const value = parsed(body);
    if (!isRecord(value)) {
        return undefined;
    }
    const messages = value['errorMessages'];
    const [message] = isStringArray(messages) ? messages : [];
    if (message !== undefined) {
        return message;
    }
    const [field] = Object.entries(recordField(value, 'errors') ?? {});
    return field !== undefined && typeof field[1] === 'string' ? `${field[0]}: ${field[1]}` : undefined;
}
export class JiraClient {
    http;
    credentials;
    scanner;
    wait;
    jitter;
    /** One read of each site's credential a run, shared by every request to it. */
    signIns = new Map();
    /** `jitter` gives a number from 0 up to 1, as Math.random does. */
    constructor(http, credentials, scanner, wait, jitter) {
        this.http = http;
        this.credentials = credentials;
        this.scanner = scanner;
        this.wait = wait;
        this.jitter = jitter;
    }
    /** How `site` is signed in to, from its saved credential. */
    signIn(site) {
        const known = this.signIns.get(site);
        if (known !== undefined) {
            return known;
        }
        const read = this.readSignIn(site);
        this.signIns.set(site, read);
        return read;
    }
    get(site, path) {
        return this.call(site, (headers) => ({ method: 'GET', url: `${baseUrl(site)}${path}`, headers }));
    }
    post(site, path, body) {
        return this.call(site, (headers) => ({ method: 'POST', url: `${baseUrl(site)}${path}`, headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) }));
    }
    put(site, path, body) {
        return this.call(site, (headers) => ({ method: 'PUT', url: `${baseUrl(site)}${path}`, headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) }));
    }
    /** How the credential of `site` is saved, for a reason that asks for it. */
    saveLine(site) {
        return `save the account's e-mail, a colon and its API token with ${this.credentials.saveCommand(credentialName(site))}`;
    }
    async readSignIn(site) {
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
    async call(site, requestWith) {
        const signIn = await this.signIn(site);
        if (signIn.kind === 'failed') {
            return signIn;
        }
        return await this.send(site, requestWith({ authorization: signIn.header, accept: 'application/json' }), RATE_LIMIT_RETRIES, 0);
    }
    /** Sends `request`, again after the wait Jira asks for while it answers 429 and `retries` are left. Nothing else is sent twice. */
    async send(site, request, retries, waitedMs) {
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
    answer(site, status, body) {
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
    line(text) {
        const plain = this.scanner.redact(text.replace(CONTROLS, ' ').trim());
        return plain.length > MAX_ERROR_TEXT ? `${plain.slice(0, MAX_ERROR_TEXT)}...` : plain;
    }
}
